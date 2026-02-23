# Gossip Client -- Outbox Model Implementation Analysis

## Summary

Gossip (Rust) has one of the most thorough and principled outbox model implementations among nostr clients. It was designed from the ground up around the outbox/inbox relay concept, with the core architecture built around a **RelayPicker** that uses a multi-factor scoring system to optimally assign followed pubkeys to relays.

Key characteristics:
- **Dedicated `PersonRelay` table** (LMDB, not SQLite) tracking per-(pubkey, relay) associations with read/write/dm flags and temporal decay scores.
- **Two-layer scoring**: An `association_score` (how strongly a person is associated with a relay) is multiplied by an `adjusted_score` (how good the relay is in general), yielding a composite score between 0.0 and 1.0.
- **Greedy relay picker algorithm**: Iteratively selects the relay that covers the most still-unassigned pubkeys, subject to a configurable `max_relays` ceiling (default 50) and `num_relays_per_person` target (default 2).
- **Relay discovery pipeline**: Fetches kind 10002 (NIP-65 relay lists), kind 3 contact list content, NIP-05 relays, and relay hints from 'p' tags, each weighted differently.
- **Health tracking**: Relays are penalized with exclusion timers (15 seconds to 10 minutes) on failure, and success/failure counts feed into the relay score.
- **Explicit role separation**: Distinguishes OUTBOX (kind 10002 'write'), INBOX (kind 10002 'read'), DISCOVER, DM (kind 10050), READ, WRITE, GLOBAL, SEARCH, and SPAMSAFE relay roles via bitmask flags.

---

## 1. Relay Selection Logic

### Core Algorithm: The RelayPicker

The relay picker lives in `/tmp/outbox-research/gossip/gossip-lib/src/relay_picker.rs` and is the heart of Gossip's outbox implementation. It is a global singleton (`GLOBALS.relay_picker`) that maintains:

```rust
pub struct RelayPicker {
    // Per-person ranked relay lists with scores
    person_relay_scores: DashMap<PublicKey, Vec<(RelayUrl, f32)>>,
    // Currently connected relays and their pubkey assignments
    relay_assignments: DashMap<RelayUrl, RelayAssignment>,
    // Relays in penalty box (URL -> unix timestamp when eligible again)
    excluded_relays: DashMap<RelayUrl, i64>,
    // Pubkeys still needing relay assignments, with remaining count needed
    pubkey_counts: DashMap<PublicKey, usize>,
}
```

**File**: `/tmp/outbox-research/gossip/gossip-lib/src/relay_picker.rs`

The picker uses a **greedy set-cover** approach:

1. Build a scoreboard for all known relays, starting at 0.0.
2. For each pubkey still needing assignment, add its per-relay scores to the scoreboard.
3. Skip excluded relays and (if at max connections) relays not already connected.
4. Pick the relay with the highest aggregate score.
5. Assign all pubkeys that had a score for that relay (with a threshold: if score <= 5.0 and it is not in the person's top 3 relays, skip it).
6. Decrement each assigned pubkey's remaining-needed count.
7. Repeat until no more progress can be made.

```rust
// From relay_picker.rs pick()
let winner = scoreboard
    .iter()
    .max_by(|x, y| x.value().partial_cmp(y.value()).unwrap())
    .unwrap();
```

### Score Computation

The composite score is computed in `get_best_relays_with_score()` in `/tmp/outbox-research/gossip/gossip-lib/src/relay.rs`:

```rust
pub fn get_best_relays_with_score(
    pubkey: PublicKey,
    usage: RelayUsage,
    score_factors: ScoreFactors,
) -> Result<Vec<(RelayUrl, f32)>, Error> {
    // ...
    for pr in person_relays.drain(..) {
        let association_score = pr.association_score(now, usage);
        let relay = GLOBALS.db().read_or_create_relay(&pr.url, None)?;
        if relay.should_avoid() { continue; }
        let multiplier = relay.adjusted_score(score_factors);
        let score = association_score * multiplier;
        // Only accept declared relays (association_score >= 1.0)
        if association_score < 1.0 {
            weak.push((pr.url, score));
        } else {
            strong.push((pr.url, score));
        }
    }
    // Prefer strong (declared) relays; fall back to weak only if no strong ones exist
    let mut output = strong.clone();
    if output.is_empty() { output.extend(weak); }
    output.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    Ok(output)
}
```

**Key design decision**: Declared relays (from kind 10002, kind 3, or NIP-05) are strongly preferred. "Weak" relays (only known from hints or fetches) are only used if no declared relays exist. This means a person who has published a relay list will almost always have their declared relays used.

---

## 2. PersonRelay Table

### Storage Layer

Gossip uses **LMDB** (not SQLite) for all persistent storage. The PersonRelay records are stored in a database named `"person_relays2"` with a composite key of `pubkey_bytes + url_bytes`.

**File**: `/tmp/outbox-research/gossip/gossip-lib/src/storage/person_relays2.rs`

```rust
// Key: pubkey.as_bytes + url.as_str().as_bytes (truncated to MAX_LMDB_KEY)
// Value: PersonRelay2 serialized via speedy
```

### PersonRelay2 Schema

**File**: `/tmp/outbox-research/gossip/gossip-lib/src/storage/types/person_relay2.rs`

```rust
pub struct PersonRelay2 {
    pub pubkey: PublicKey,
    pub url: RelayUrl,
    /// Set from kind 10002 or kind 3 contents or NIP-05 (inbox direction)
    pub read: bool,
    /// Set from kind 10002 or kind 3 contents or NIP-05 (outbox direction)
    pub write: bool,
    /// Set from kind 10050 (NIP-17 DM relay list)
    pub dm: bool,
    /// Last time we fetched one of the person's events from this relay
    pub last_fetched: Option<u64>,
    /// Last time a 3rd party suggested this association (e.g. 'p' tag relay hint)
    pub last_suggested: Option<u64>,
}
```

The earlier version (PersonRelay1) had more granular fields (`last_suggested_kind3`, `last_suggested_nip05`, `last_suggested_bytag`, `manually_paired_read`, `manually_paired_write`). These were consolidated in v2 into just `read`/`write`/`dm` booleans and two temporal fields.

### How PersonRelay Is Populated

PersonRelay records are created/updated from multiple sources:

1. **When events are seen on a relay** (`process/mod.rs`):
   ```rust
   GLOBALS.db().modify_person_relay(
       event.pubkey, &url,
       |pr| pr.last_fetched = Some(now.0 as u64),
       None,
   )?;
   ```

2. **From relay hints in 'p' tags** (`process/mod.rs`):
   ```rust
   GLOBALS.db().modify_person_relay(
       pubkey, &url,
       |pr| pr.last_suggested = Some(now.0 as u64),
       None,
   )?;
   ```

3. **From NIP-05 validation** (`nip05.rs`):
   ```rust
   GLOBALS.db().modify_person_relay(
       *pubkey, &relay_url,
       |pr| { pr.read = true; pr.write = true; },
       None,
   )?;
   ```

4. **From kind 10002 relay lists** (`storage/mod.rs` `set_relay_list()`):
   ```rust
   // First clears all read/write for that person, then sets per the list
   pr.read = *usage == RelayListUsage::Inbox || *usage == RelayListUsage::Both;
   pr.write = *usage == RelayListUsage::Outbox || *usage == RelayListUsage::Both;
   ```

5. **From kind 3 contact list content** (`process/by_kind.rs` `process_somebody_elses_contact_list()`):
   Parses the `content` field as a `SimpleRelayList`, then calls `set_relay_list()` with the same mechanism as kind 10002.

6. **From kind 10050 DM relay lists** (`storage/mod.rs` `process_dm_relay_list()`):
   Sets the `dm` flag on matching person_relay records.

7. **From nprofile bech32 references in content** (`process/mod.rs`):
   ```rust
   // If the author mentioned their own nprofile
   pr.read = true; pr.write = true;
   // If someone else mentioned the nprofile
   pr.last_suggested = Some(now.0 as u64);
   ```

---

## 3. Scoring Sources and Weights

### Association Score (PersonRelay2)

**File**: `/tmp/outbox-research/gossip/gossip-lib/src/storage/types/person_relay2.rs`

```rust
pub fn association_score(&self, now: Unixtime, usage: RelayUsage) -> f32 {
    let mut score = 0.0;

    if usage == RelayUsage::Outbox {
        if self.write { score += 1.0; }  // author-signed explicit claim
    } else if usage == RelayUsage::Inbox {
        if self.read { score += 1.0; }   // author-signed explicit claim
    }

    // last_fetched: gossip verified happened-to-work-before
    if let Some(when) = self.last_fetched {
        // base=0.2, halflife=14 days
        score += exponential_decay(0.2, 60*60*24*14, elapsed);
    }

    // last_suggested: anybody-signed suggestion (e.g. relay hint in 'p' tag)
    if let Some(when) = self.last_suggested {
        // base=0.1, halflife=7 days
        score += exponential_decay(0.1, 60*60*24*7, elapsed);
    }

    score
}
```

| Source | Weight | Decay |
|--------|--------|-------|
| Kind 10002 relay list (read/write) | **1.0** (constant) | None -- binary flag |
| Kind 3 contact list content | **1.0** (via read/write flags) | None -- binary flag |
| NIP-05 relays | **1.0** (sets both read+write) | None -- binary flag |
| Successful event fetch | **0.2** base | Exponential, 14-day halflife |
| Relay hint ('p' tag) | **0.1** base | Exponential, 7-day halflife |

The declared sources (kind 10002, kind 3, NIP-05) all collapse into the same `read`/`write` boolean flags, so they are **equally weighted at 1.0**. The key distinction is that kind 10002 sets read and write independently, kind 3 content can set them independently, and NIP-05 always sets both.

### Relay Score (Relay3)

**File**: `/tmp/outbox-research/gossip/gossip-lib/src/storage/types/relay3.rs`

```rust
pub fn score(&self) -> f32 {
    if self.should_avoid() { return 0.0; }
    let mut score: f32 = 1.0;
    // Rank: user-assigned 0-9 (default 3). rank/9 gives 0.33 for default.
    score *= self.rank as f32 / 9.0;
    // Success rate: min penalty is 50% (0.5 + 0.5 * rate)
    score *= 0.5 + 0.5 * self.success_rate();
    score
}

pub fn adjusted_score(&self, factors: ScoreFactors) -> f32 {
    let mut score = self.score();
    if factors.connected {
        if !GLOBALS.connected_relays.contains_key(&self.url) {
            score /= 2.0;  // halve score for not-connected relays
        }
    }
    if factors.success_count {
        if self.success_count > 0 {
            score *= (self.success_count as f32).log10();
        } else {
            score = 0.0;  // never-connected relays get zero
        }
    }
    score
}
```

The `ScoreFactors::FULLY_ADJUSTED` (used by the relay picker) applies both the connected bonus and the success_count multiplier. A typical good relay with default rank (3) and good success rate scores about 0.33.

### Composite Score

The final score for a (person, relay) pair is:

```
composite = association_score * adjusted_relay_score
```

For a declared relay (association=1.0) at default rank (3) with 100% success and connected:

```
1.0 * (3/9) * (0.5 + 0.5*1.0) * log10(success_count) = 0.333 * log10(N)
```

---

## 4. Connection Management

### Limits

**File**: `/tmp/outbox-research/gossip/gossip-lib/src/storage/mod.rs`

```rust
def_setting!(num_relays_per_person, b"num_relays_per_person", u8, 2);
def_setting!(max_relays, b"max_relays", u8, 50);
```

- **num_relays_per_person**: Default **2**. Each followed pubkey will ideally be assigned to 2 relays.
- **max_relays**: Default **50**. When at this limit, the picker only considers already-connected relays for new assignments.

### Connection Architecture

Gossip uses a **minion** architecture where each relay connection is managed by its own async task (a "minion"). The `Overlord` coordinates minions through message passing.

**File**: `/tmp/outbox-research/gossip/gossip-lib/src/manager.rs`

```rust
// Engage a new or existing minion for relay jobs
async fn engage_minion_inner(url: RelayUrl, mut jobs: Vec<RelayJob>) -> Result<(), Error> {
    // Check approval, offline, should_avoid...
    let entry = GLOBALS.connected_relays.entry(url.clone());
    if let Entry::Occupied(mut oe) = entry {
        // Already connected: send jobs to existing minion
        for job in jobs.drain(..) {
            let _ = GLOBALS.to_minions.send(ToMinionMessage { ... });
            oe.get_mut().push(job);
        }
    } else {
        // New connection: spawn a new minion
        let mut minion = Minion::new(url.clone()).await?;
        // ...spawn task...
        entry.insert(jobs);
    }
}
```

There are two modes for dispatching to relays:
- **`run_jobs_on_all_relays`**: Connects to every relay in the list (used for inbox, giftwraps, discovery).
- **`run_jobs_on_some_relays`**: Connects to `count` relays from the list, skipping failures (used for person feeds).

### Connection Lifecycle

Each relay connection tracks its jobs via `GLOBALS.connected_relays: DashMap<RelayUrl, Vec<RelayJob>>`. Jobs have a `RelayConnectionReason` that determines whether the connection should persist when the job completes. Persistent reasons include `Follow`, `FetchInbox`, `Giftwraps`.

---

## 5. Fallback Behavior

### When No Outbox Info Exists

The `get_best_relays_with_score()` function in `/tmp/outbox-research/gossip/gossip-lib/src/relay.rs` separates results into "strong" (declared, association >= 1.0) and "weak" (undeclared) relays:

```rust
if association_score < 1.0 {
    weak.push((pr.url, score));
} else {
    strong.push((pr.url, score));
}
let mut output = strong.clone();
if output.is_empty() {
    output.extend(weak);  // Only use weak relays as fallback
}
```

If a person has **no** relay list at all, the system falls back to:
1. Relays where the person's events have been fetched (`last_fetched`, score base 0.2 with 14-day decay)
2. Relays suggested by others' relay hints (`last_suggested`, score base 0.1 with 7-day decay)
3. If the seeker is looking for an event and gets no relay list within 15 seconds, it falls back to the user's READ relays.

### Relay List Discovery

**File**: `/tmp/outbox-research/gossip/gossip-lib/src/seeker.rs`

The Seeker implements a state machine for event seeking:

```rust
pub enum SeekState {
    WaitingRelayList(PublicKey),  // need relay list first
    WaitingEvent,                 // have relays, waiting for the event
}
```

When seeking an event by ID + author:
1. If relay list is `NeverSought`: seek the relay list first, wait for it.
2. If `Stale`: seek relay list in background but use stale data immediately.
3. If `Fresh`: use cached relay list directly.
4. After 15 seconds of waiting for a relay list, give up and try READ relays.

---

## 6. Event Publishing (Write Side)

### Where to Post

**File**: `/tmp/outbox-research/gossip/gossip-lib/src/relay.rs`

```rust
pub fn relays_to_post_to(event: &Event) -> Result<Vec<RelayUrl>, Error> {
    let mut relays: Vec<RelayUrl> = Vec::new();

    // All of my outboxes (WRITE relays)
    relays.extend(Relay::choose_relay_urls(Relay::WRITE, |_| true)?);

    // Inbox relays of tagged people
    for pubkey in tagged_pubkeys.drain(..) {
        let user_relays = get_all_pubkey_inboxes(pubkey)?;
        if event.kind == EventKind::EncryptedDirectMessage {
            let dm_relays = get_dm_relays(pubkey)?;
            if dm_relays.is_empty() {
                relays.extend(user_relays);
            } else {
                relays.extend(dm_relays);
            }
        } else {
            relays.extend(user_relays);
        }
    }

    // Remove relays we've already posted to (seen_on)
    relays.retain(|r| !seen_on.contains(r));
    relays.sort();
    relays.dedup();
    Ok(relays)
}
```

For NIP-17 DMs (`prepare_post_nip17` in `/tmp/outbox-research/gossip/gossip-lib/src/post.rs`):
- Each recipient gets a giftwrapped copy sent to their DM relays (kind 10050).
- A copy is also sent to the user's own DM relays.
- If DM relays are not available, falls back to the recipient's write relays.

### Relay List Advertisement

The user's relay list (kind 10002) is published to all relays that pass `is_good_for_advertise()`:

```rust
pub fn is_good_for_advertise(&self) -> bool {
    if self.should_avoid() { return false; }
    self.has_usage_bits(Self::INBOX)
        || self.has_usage_bits(Self::OUTBOX)
        || self.has_usage_bits(Self::DISCOVER)
        || (self.rank > 0 && self.success_rate() > 0.50 && self.success_count > 15)
}
```

---

## 7. Bootstrapping

### Initial Setup Wizard

**File**: `/tmp/outbox-research/gossip/gossip-bin/src/ui/wizard/setup_relays.rs`

The wizard presents 36 hardcoded relay URLs as suggestions:

```rust
static DEFAULT_RELAYS: [&str; 36] = [
    "wss://nostr.mom/",
    "wss://e.nos.lol/",
    "wss://relay.primal.net/",
    "wss://nos.lol/",
    "wss://relay.nostr.band/",
    "wss://relay.damus.io/",
    // ... 30 more
];
```

The wizard guides users to configure:
- **At least 3 OUTBOX relays** (where they post notes)
- **At least 2 INBOX relays** (where people can reach them)
- **At least 4 DISCOVERY relays** (where relay lists are found)

### Relay Discovery Pipeline

On startup (`start_long_lived_subscriptions` in `/tmp/outbox-research/gossip/gossip-lib/src/overlord.rs`):

1. **Initialize the RelayPicker**: Computes scores for all followed pubkeys and picks relays.
2. **Subscribe to config events** on user's WRITE relays.
3. **Subscribe to inbox** on user's READ relays.
4. **Subscribe to giftwraps** on DM + INBOX relays.
5. **Subscribe to discover relay lists** for all followed pubkeys whose relay lists are stale (older than 20 minutes by default).

```rust
pub async fn start_long_lived_subscriptions(&mut self) -> Result<(), Error> {
    GLOBALS.relay_picker.init().await?;
    GLOBALS.connected_relays.clear();

    if !GLOBALS.db().read_setting_offline() {
        self.pick_relays().await;
    }

    self.subscribe_config(None)?;
    self.subscribe_inbox(None)?;
    self.subscribe_giftwraps()?;

    let followed = GLOBALS.people.get_subscribed_pubkeys_needing_relay_lists();
    self.subscribe_discover(followed, None)?;
    // ...
}
```

The discovery subscription fetches `EventKind::RelayList` and `EventKind::DmRelayList` from DISCOVER relays for all pubkeys that need relay list updates:

```rust
// FilterSet::Discover
Filter {
    authors: pubkeys.to_vec(),
    kinds: vec![EventKind::RelayList, EventKind::DmRelayList],
    ..Default::default()
}
```

### Relay List Staleness

**File**: `/tmp/outbox-research/gossip/gossip-lib/src/storage/mod.rs`

```rust
def_setting!(relay_list_becomes_stale_minutes, b"relay_list_becomes_stale_minutes", u64, 20);
```

Relay lists are re-fetched when older than 20 minutes (default). The `person_needs_relay_list()` function checks the `relay_list_last_sought` timestamp on the Person record.

---

## 8. Rate Limiting / Health Tracking

### Relay Health: Success/Failure Counting

**File**: `/tmp/outbox-research/gossip/gossip-lib/src/storage/types/relay3.rs`

```rust
pub struct Relay3 {
    pub success_count: u64,
    pub failure_count: u64,
    pub last_connected_at: Option<u64>,
    pub last_general_eose_at: Option<u64>,
    pub rank: u64,  // 0-9, default 3. 0 = do not use.
    pub avoid_until: Option<Unixtime>,
    // ...
}
```

Success rate feeds into the relay score:
```rust
pub fn success_rate(&self) -> f32 {
    let attempts = self.attempts();
    if attempts == 0 { return 0.5; }  // unknown = middle
    self.success_count as f32 / attempts as f32
}
```

### Exclusion / Penalty Box

When a minion exits (connection closes, errors out, etc.), the overlord computes an exclusion period:

**File**: `/tmp/outbox-research/gossip/gossip-lib/src/overlord.rs`

| Exit Reason | Exclusion |
|---|---|
| Got disconnected | 2 minutes |
| Got WS close | 2 minutes |
| Graceful shutdown | 0 (no penalty) |
| Subscriptions completed successfully | 0 |
| Subscriptions completed with failures | 2 minutes |
| Unknown | 2 minutes |
| Relay rejected us | 10 minutes |
| HTTP error (reqwest) | 10 minutes |
| Timeout | 1 minute |
| HTTP 5xx, 401, 403, 404, etc. | 10 minutes |
| HTTP 4xx (other) | 2 minutes |
| Connection closed (not error) | 15 seconds |
| Protocol reset without handshake | 1 minute |
| DNS lookup failure | 10 minutes |

The exclusion is:
1. Recorded in the relay's `avoid_until` field.
2. Also tracked in the RelayPicker's `excluded_relays` DashMap, which is checked during relay selection.

```rust
pub fn relay_disconnected(&self, url: &RelayUrl, penalty_seconds: i64) {
    if penalty_seconds > 0 {
        let hence = Unixtime::now().0 + penalty_seconds;
        self.excluded_relays.insert(url.to_owned(), hence);
    }
    // Remove from assignments, put pubkeys back into the "needing" pool
    if let Some((_key, assignment)) = self.relay_assignments.remove(url) {
        for pubkey in assignment.pubkeys.iter() {
            self.pubkey_counts.entry(pubkey.to_owned())
                .and_modify(|e| *e += 1)
                .or_insert(1);
        }
    }
}
```

### Relay Avoidance

**File**: `/tmp/outbox-research/gossip/gossip-lib/src/storage/types/relay3.rs`

```rust
pub fn should_avoid(&self) -> bool {
    if self.rank == 0 { true }
    else if /* connection requires approval and allow_connect == false */ { true }
    else if Storage::url_is_banned(&self.url) { true }
    else if let Some(when) = self.avoid_until { when >= Unixtime::now() }
    else { false }
}
```

### Banned Relays

**File**: `/tmp/outbox-research/gossip/gossip-lib/src/storage/mod.rs`

```rust
pub fn url_is_banned(url: &RelayUrl) -> bool {
    let s = url.as_str();
    // Infinite subdomain relays
    (s.contains("relay.nostr.band") && !s.ends_with("relay.nostr.band/"))
        || (s.contains("filter.nostr.wine") && !s.ends_with("filter.nostr.wine/"))
}
```

---

## Architecture Diagram

```
                    +-----------+
                    |  Overlord |  (coordinator)
                    +-----+-----+
                          |
            +-------------+-------------+
            |                           |
     +------+------+           +-------+--------+
     | RelayPicker  |           |    Manager     |
     | (scoring &   |           | (engage_minion)|
     |  assignment) |           +-------+--------+
     +------+------+                   |
            |                   +------+------+
     +------+------+           |  Minion per  |
     | PersonRelay  |          |  relay (WS)  |
     | (LMDB table) |          +--------------+
     +------+------+
            |
     +------+------+
     | process/     |  <-- processes incoming events
     | by_kind.rs   |  <-- updates PersonRelay from kind 10002, kind 3, NIP-05, hints
     +-------------+
```

## Key Observations

1. **Principled separation of declared vs. hinted relays**: The strong/weak split ensures that explicit relay list declarations (kind 10002, kind 3 content, NIP-05) are always preferred over implicit signals (event fetches, relay hints). This is architecturally sound.

2. **Temporal decay for non-declared signals**: The exponential decay (14-day halflife for fetches, 7-day for suggestions) prevents stale data from dominating. This is more sophisticated than most clients.

3. **No hardcoded fallback relays at runtime**: Unlike some clients, Gossip does not have hardcoded "always connect" relays. The wizard suggests 36 relays, but at runtime it is entirely data-driven. If a user has no relay data for a followed person, they may simply not see that person's events until relay discovery completes.

4. **Greedy set-cover for relay selection**: The algorithm tries to minimize total relay connections while covering all followed pubkeys. This is efficient but not globally optimal (a known property of greedy set-cover).

5. **Kind 10002 and kind 3 content are treated equivalently**: Both set the `read`/`write` boolean flags on PersonRelay. Kind 10002 is preferred because it is processed as a newer event (replaceable event semantics), but if only kind 3 content is available, it functions the same way.

6. **NIP-05 sets both read and write**: When NIP-05 relays are discovered, they get `read=true, write=true`, which is a simplification since NIP-05 does not distinguish inbox vs. outbox.

7. **The 0.125 threshold**: When computing "all outboxes" or "all inboxes" (for posting or information), the threshold of 0.125 is carefully chosen. A declared relay (association=1.0) at default rank (score ~0.33) with 50% success rate gives ~0.25, halved if not connected = 0.125. This ensures all declared relays are included down to moderate health.

8. **Relay rank is user-assignable**: Users can rank relays 0-9 (default 3), giving them explicit control. Rank 0 effectively bans a relay.
