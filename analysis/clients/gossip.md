# Gossip Client -- Outbox Model Implementation Analysis

## Key Observations

- **Declared vs. hinted relays are strictly separated.** Kind 10002, kind 3 content, and NIP-05 all set binary `read`/`write` flags (score = 1.0). Hinted relays (event fetches, 'p' tag hints) use decaying scores (0.2 and 0.1 base) and are only used when no declared relays exist.
- **Greedy set-cover for relay selection.** Iteratively picks the relay covering the most unassigned pubkeys. Efficient but not globally optimal (known property of greedy set-cover).
- **No hardcoded fallback relays at runtime.** The wizard suggests 36 relays, but runtime is entirely data-driven. If no relay data exists for a followed person, their events won't appear until discovery completes.
- **Kind 10002 and kind 3 content treated equivalently.** Both set `read`/`write` booleans on PersonRelay. Kind 10002 wins via replaceable event semantics when both exist.
- **NIP-05 sets both read and write** -- a simplification since NIP-05 doesn't distinguish inbox vs. outbox.
- **Relay rank is user-assignable** (0-9, default 3). Rank 0 bans a relay.
- **Temporal decay for non-declared signals**: 14-day halflife for fetches, 7-day for suggestions. More sophisticated than most clients.
- **The 0.125 threshold** for "all outboxes/inboxes" ensures all declared relays are included down to moderate health. A declared relay at default rank with 50% success rate and not connected = ~0.125.

---

## 1. Relay Selection and Scoring

### Greedy Set-Cover Algorithm

**File**: `/tmp/outbox-research/gossip/gossip-lib/src/relay_picker.rs`

The `RelayPicker` is a global singleton maintaining per-person scored relay lists, current assignments, excluded relays, and remaining pubkey needs.

The pick loop:
1. Build a scoreboard for all known relays (start at 0.0).
2. For each unassigned pubkey, add its per-relay scores to the scoreboard.
3. Skip excluded relays and (if at max connections) unconnected relays.
4. Pick the highest-scoring relay.
5. Assign pubkeys that scored for that relay (skip if score <= 5.0 and not in person's top 3).
6. Decrement each assigned pubkey's remaining-needed count.
7. Repeat until no progress.

### Composite Score

The final score for a (person, relay) pair:

```
composite = association_score * adjusted_relay_score
```

**File**: `/tmp/outbox-research/gossip/gossip-lib/src/relay.rs`

Declared relays (association >= 1.0) are strongly preferred. "Weak" relays (only known from hints/fetches) are only used if no declared relays exist.

### Association Score

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
| Kind 10002 relay list (read/write) | **1.0** | None -- binary flag |
| Kind 3 contact list content | **1.0** (via read/write flags) | None -- binary flag |
| NIP-05 relays | **1.0** (sets both read+write) | None -- binary flag |
| Successful event fetch | **0.2** base | Exponential, 14-day halflife |
| Relay hint ('p' tag) | **0.1** base | Exponential, 7-day halflife |

### Relay Score

**File**: `/tmp/outbox-research/gossip/gossip-lib/src/storage/types/relay3.rs`

```rust
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

Base relay score = `(rank / 9) * (0.5 + 0.5 * success_rate)`. A typical good relay at default rank (3) scores ~0.33.

---

## 2. PersonRelay Table

**Storage**: LMDB (not SQLite), database `"person_relays2"`, composite key of `pubkey_bytes + url_bytes`.

**File**: `/tmp/outbox-research/gossip/gossip-lib/src/storage/types/person_relay2.rs`

```rust
pub struct PersonRelay2 {
    pub pubkey: PublicKey,
    pub url: RelayUrl,
    pub read: bool,       // Set from kind 10002, kind 3 content, or NIP-05 (inbox)
    pub write: bool,      // Set from kind 10002, kind 3 content, or NIP-05 (outbox)
    pub dm: bool,         // Set from kind 10050 (NIP-17 DM relay list)
    pub last_fetched: Option<u64>,    // Last successful event fetch from this relay
    pub last_suggested: Option<u64>,  // Last 3rd-party suggestion (e.g. 'p' tag hint)
}
```

**Population sources**: events seen on relay, relay hints in 'p' tags, NIP-05 validation, kind 10002 relay lists, kind 3 contact list content, kind 10050 DM relay lists, nprofile bech32 references in content.

---

## 3. Connection Management and Health

### Limits

**File**: `/tmp/outbox-research/gossip/gossip-lib/src/storage/mod.rs`

- **num_relays_per_person**: Default **2**. Each followed pubkey ideally assigned to 2 relays.
- **max_relays**: Default **50**. At this limit, the picker only considers already-connected relays.

### Architecture

Minion-per-relay: each relay connection is its own async task. The `Overlord` coordinates minions through message passing.

**File**: `/tmp/outbox-research/gossip/gossip-lib/src/manager.rs`

Two dispatch modes:
- **`run_jobs_on_all_relays`**: Connects to every relay in the list (inbox, giftwraps, discovery).
- **`run_jobs_on_some_relays`**: Connects to `count` relays, skipping failures (person feeds).

### Penalty Box

When a minion exits, the overlord assigns an exclusion period:

**File**: `/tmp/outbox-research/gossip/gossip-lib/src/overlord.rs`

| Exit Reason | Exclusion |
|---|---|
| Disconnected / WS close / unknown | 2 min |
| Subscriptions completed with failures | 2 min |
| Graceful shutdown / success | 0 |
| Rejected / HTTP error / DNS failure | 10 min |
| Timeout / protocol reset | 1 min |
| Connection closed (not error) | 15 sec |

Exclusions are recorded in the relay's `avoid_until` field and the RelayPicker's `excluded_relays` map. On disconnect, assigned pubkeys are returned to the "needing" pool.

### Relay Avoidance

A relay is avoided if: rank == 0, connection requires unapproved approval, URL is banned, or `avoid_until` hasn't passed. Two URLs are banned: infinite-subdomain patterns for `relay.nostr.band` and `filter.nostr.wine`.

---

## 4. Fallback Behavior

When no relay list exists for a person:
1. Relays where events were previously fetched (`last_fetched`, 0.2 base, 14-day decay)
2. Relays suggested by others' hints (`last_suggested`, 0.1 base, 7-day decay)
3. After 15 seconds of waiting for a relay list, falls back to the user's READ relays

**File**: `/tmp/outbox-research/gossip/gossip-lib/src/seeker.rs`

The Seeker state machine for event seeking:
- `NeverSought`: seek relay list first, wait for it
- `Stale`: seek relay list in background, use stale data immediately
- `Fresh`: use cached relay list directly

---

## 5. Event Publishing

**File**: `/tmp/outbox-research/gossip/gossip-lib/src/relay.rs`

Publishes to:
- All of the user's OUTBOX (write) relays
- INBOX relays of each tagged pubkey
- For DMs: recipient's DM relays (kind 10050), falling back to their write relays

Already-seen relays are excluded via `seen_on`. The user's relay list (kind 10002) is published to all relays passing `is_good_for_advertise()` -- any INBOX/OUTBOX/DISCOVER relay, or any relay with rank > 0, success rate > 50%, and 15+ successful connections.

---

## 6. Bootstrapping

**File**: `/tmp/outbox-research/gossip/gossip-bin/src/ui/wizard/setup_relays.rs`

The setup wizard presents 36 hardcoded relay URLs and guides users to configure:
- At least 3 OUTBOX relays
- At least 2 INBOX relays
- At least 4 DISCOVERY relays

**Relay role separation**: OUTBOX, INBOX, DISCOVER, DM, READ, WRITE, GLOBAL, SEARCH, SPAMSAFE -- via bitmask flags.

On startup (`start_long_lived_subscriptions`):
1. Initialize RelayPicker (compute scores, pick relays)
2. Subscribe to config on WRITE relays
3. Subscribe to inbox on READ relays
4. Subscribe to giftwraps on DM + INBOX relays
5. Discover relay lists for followed pubkeys with stale data (default staleness: 20 minutes)

Discovery fetches `EventKind::RelayList` and `EventKind::DmRelayList` from DISCOVER relays.
