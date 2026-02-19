# Measuring Outbox Effectiveness

## Overview

How do you know the outbox model is working? Are you seeing all the events you should? Are you connecting to too many relays or too few? This document examines what metrics could measure outbox effectiveness, what statistics implementations already track, how failures are detected, and what research opportunities exist.

---

## 1. Coverage Metrics: What Could Be Measured

### 1a. Event Coverage (Completeness)

The most fundamental metric: what fraction of events published by followed accounts does a client actually receive?

**Definition:** For a set of followed pubkeys over a time window, event coverage = (events received) / (events published). A perfect outbox implementation would achieve 100% coverage.

**Challenges:**
- There is no ground truth for "events published" -- you cannot know what you do not know.
- Events may be deleted, expired, or NIP-70 protected.
- Replaceable events (kind 0, 3, 10002) only need the latest version, not all versions.

**Proxy measurements:**
- Compare events found on relay A vs relay B for the same author (coverage delta between relays).
- Compare events found via outbox routing vs a "known complete" indexer relay.
- Count authors with zero events received despite being followed (complete miss rate).

### 1b. User Coverage (Follow Reachability)

What fraction of followed pubkeys have at least one relay successfully selected for them?

**Definition:** user_coverage = (followed pubkeys with >= 1 selected relay) / (total followed pubkeys).

This is directly measurable in implementations that track relay selection assignments. It captures the "structural" effectiveness of the outbox model before any network activity.

### 1c. Relay Count Efficiency

How many relay connections are needed to achieve a given coverage level?

**Definition:** For N followed pubkeys, the relay selection algorithm produces M relay connections. The ratio N/M measures how many pubkeys each connection covers on average. Higher is more efficient.

**Related metrics:**
- Median pubkeys per relay connection
- Distribution of pubkeys across relays (is load balanced or concentrated?)
- Marginal coverage per additional relay (diminishing returns curve)

### 1d. Latency

How quickly do events arrive after publication?

**Definition:** time_received - time_published for events from followed accounts. Lower is better.

**Challenges:**
- Requires accurate timestamps (event `created_at` is author-declared, not verified).
- Network propagation delays vary by relay.
- Clients that connect lazily (Welshman's connect-on-send) have inherent first-event latency.

### 1e. Staleness

How fresh is the relay list data used for routing decisions?

**Definition:** age_of_relay_list = now - relay_list_event.created_at for each followed pubkey's kind 10002 event. Also: age_since_last_check = now - last_time_we_fetched_this_relay_list.

**Relevance:** A user who changed their relay list 6 months ago and has not been re-fetched may be routed to dead relays.

### 1f. Connection Overhead

What fraction of relay connections are productive (delivering events)?

**Definition:** productive_connections = connections that delivered >= 1 event / total connections. Also: bytes_wasted = data transferred from relays that contributed zero events to the user's feed.

---

## 2. Observable Metrics in Code

### 2a. Welshman's RelayStats

**File:** `welshman/packages/app/src/relayStats.ts`

The most comprehensive per-relay statistics tracking:

```typescript
type RelayStats = {
  url: string
  first_seen: number
  recent_errors: number[]        // timestamps of last 10 errors
  open_count: number             // times opened
  close_count: number            // times closed
  publish_count: number          // EVENTs sent
  request_count: number          // REQs sent
  event_count: number            // events received
  last_open: number
  last_close: number
  last_error: number
  last_publish: number
  last_request: number
  last_event: number
  last_auth: number
  publish_success_count: number  // OK responses
  publish_failure_count: number  // rejected publishes
  eose_count: number             // EOSE messages received
  notice_count: number           // NOTICE messages
}
```

**Quality calculation** uses error-based exclusion with tiered thresholds:
- Any error in the last minute: quality = 0
- More than 3 errors in the last hour: quality = 0
- More than 10 errors in the last day: quality = 0
- Currently connected: quality = 1.0
- Previously connected: quality = 0.9
- Unknown standard relay: quality = 0.8
- Unusual URL: quality = 0.7

Stats are collected via `trackRelayStats()` which listens to socket events (Send, Receive, Status). Error timestamps are stored in a `recent_errors` array capped at 10 entries. Stats are batched and updated every 1000ms.

**What this enables:** Connection success rates, publish success rates, error frequency, and relay responsiveness can all be computed from these stats. However, there is no per-author metric -- you cannot tell from RelayStats whether relay X is delivering events from author Y.

### 2b. Gossip's Success/Failure Counting

**File:** `gossip-lib/src/storage/types/relay3.rs`

```rust
pub struct Relay3 {
    pub success_count: u64,
    pub failure_count: u64,
    pub last_connected_at: Option<u64>,
    pub last_general_eose_at: Option<u64>,
    pub rank: u64,  // 0-9, user-assignable
}

pub fn success_rate(&self) -> f32 {
    let attempts = self.attempts();
    if attempts == 0 { return 0.5; }  // unknown = middle
    self.success_count as f32 / attempts as f32
}
```

The success rate feeds directly into relay scoring: `score *= 0.5 + 0.5 * success_rate()`. This means relay health is a first-class input to outbox relay selection. A relay with 0% success rate gets a 0.5x multiplier (halved score), while a relay with 100% success rate gets 1.0x (full score).

**Additionally, Gossip tracks per-person-relay temporal data:**

```rust
pub struct PersonRelay2 {
    pub last_fetched: Option<u64>,    // last time we got this person's event from this relay
    pub last_suggested: Option<u64>,  // last time someone hinted this person-relay pair
}
```

With exponential decay (14-day halflife for fetches, 7-day for suggestions), this provides a per-author signal that fades over time. This is the closest any analyzed implementation comes to tracking per-author event delivery effectiveness.

### 2c. Nosotros's Relay Stats

**File:** `nosotros/src/db/sqlite/sqlite.schemas.ts`

Nosotros tracks per-relay statistics in a `relayStats` table, including events count per relay. The `selectRelays()` function in `selectRelays.ts` sorts relay candidates by events count descending:

```typescript
.toSorted((a, b) => {
    const events1 = stats?.[a.relay]?.events || 0
    const events2 = stats?.[b.relay]?.events || 0
    return events2 - events1
})
```

Additionally, the `seen` table tracks `(eventId, relay, created_at)` -- which relay delivered which event. This could theoretically be used to compute per-relay-per-author delivery rates, though no such computation is currently performed.

### 2d. Amethyst's Relay Tracking

**File:** `quartz/src/commonMain/kotlin/com/vitorpamplona/quartz/nip01Core/relay/client/stats/RelayStats.kt`

Per-relay statistics via an LRU cache:
- `pingInMs` -- connection latency
- `compression` -- whether relay uses compression
- Bytes sent/received
- Error messages, notices, rejected events, subscription closures

**File:** `commons/src/commonMain/kotlin/com/vitorpamplona/amethyst/commons/model/nip01Core/UserRelaysCache.kt`

Per-user relay frequency map:
```kotlin
class UserRelaysCache {
    var data: Map<NormalizedRelayUrl, RelayInfo> = mapOf()
}
data class RelayInfo(var lastEvent: Long, var counter: Int)
```

Every event received increments the counter for the author-relay pair. `mostUsed()` returns relays sorted by counter descending. This is a per-author delivery tracking mechanism, though it is used as a fallback heuristic rather than a coverage metric.

### 2e. Applesauce/noStrudel's RelayLiveness

**File:** `applesauce/packages/relay/src/liveness.ts`

Three-state health model: `online`, `offline`, `dead`.

```
online -> offline (on connection failure)
offline -> online (on reconnection success)
offline -> dead (after maxFailuresBeforeDead consecutive failures, default 5)
dead: permanent (ignored even on success)
```

Exponential backoff: `baseDelay * 2^(failureCount-1)`, capped at `maxDelay`. Default: base 30s, max 5min (noStrudel overrides base to 5s).

Health data is persisted to localforage in noStrudel, enabling relay health history across sessions.

### 2f. Voyage's Event-Relay Tracking

**File:** `app/src/main/java/com/dluvian/voyage/data/room/entity/`

`EventRelayAuthorView` in Room (SQLite) tracks which relay delivered events from which author. This is used in the autopilot Phase 2 to fill coverage gaps: relays that have historically delivered events from an author are preferred over unknown relays.

### 2g. Welshman's Event Tracker

**File:** `welshman/packages/net/src/tracker.ts`

Bidirectional maps: `eventId -> Set<relay>` and `relay -> Set<eventId>`. This enables:
- **Deduplication**: Has this event already been seen?
- **Provenance**: Which relays have a given event?
- **Coverage analysis**: For a given event, how many relays had it?

The tracker is persisted to IndexedDB in Coracle via `TrackerStorageAdapter`. When a publish fails on a relay, the tracker entry for that relay is removed, maintaining accurate provenance.

---

## 3. Coverage Visualization: noStrudel's Outbox Selection Debugger

noStrudel provides the most user-facing visibility into outbox effectiveness through its **Outbox Relay Selection Debugger Modal**.

**File:** `nostrudel/src/components/outbox-relay-selection-modal.tsx`

**Displayed statistics:**
- Total selected relays
- Total connected relays (of the selected set)
- **Coverage percentage**: fraction of followed users with at least one selected relay
- Total users tracked

**UI elements:**
- Progress bar showing user coverage (green >= 80%, yellow >= 50%, red < 50%)
- Per-relay table with:
  - Relay URL
  - Number of users covered by this relay
  - Connection status (connected/disconnected)
  - Percentage of total users this relay covers
- "Users by relay count" breakdown: how many users have 0, 1, 2, 3, etc. relays selected for them
- "Missing relay list" users: followed accounts with no kind 10002 event
- "Orphaned" users: accounts that had relay data but none of their relays were selected after optimization

**File:** `nostrudel/src/views/settings/outbox-selection/index.tsx`

**Settings view includes:**
- Max Connections slider (0-30, default 20)
- Max Relays Per User slider (0-30, default 5)
- The same relay selection table showing coverage per relay
- User grouping by relay count
- Lists of users with missing relay lists or orphaned status

This is the only analyzed implementation that makes the outbox selection process visible and debuggable by end users. It answers the questions: "Am I connected to enough relays?" and "Are any of my follows unreachable?"

---

## 4. Failure Detection

### 4a. Gossip's Seeker Timeout

**File:** `gossip-lib/src/seeker.rs`

The Seeker implements a state machine for fetching specific events:

```rust
pub enum SeekState {
    WaitingRelayList(PublicKey),  // need relay list first
    WaitingEvent,                 // have relays, waiting for the event
}
```

Timeout behavior:
- When seeking an event by ID + author, if the author's relay list is `NeverSought`, the seeker first requests the relay list.
- If no relay list arrives within **15 seconds**, the seeker gives up on relay list discovery and falls back to the user's own READ relays.
- This is an explicit timeout-based failure detection: "if we cannot find the relay list, try broader relays."

### 4b. Gossip's Exclusion / Penalty Box

**File:** `gossip-lib/src/overlord.rs`

When a relay connection fails, the overlord computes an exclusion period:

| Exit Reason | Exclusion Duration |
|---|---|
| Got disconnected | 2 minutes |
| Relay rejected us | 10 minutes |
| HTTP error (5xx, auth) | 10 minutes |
| DNS lookup failure | 10 minutes |
| Timeout | 1 minute |
| Connection closed cleanly | 15 seconds |
| Graceful shutdown | 0 (no penalty) |

Excluded relays are tracked in both `Relay3.avoid_until` and `RelayPicker.excluded_relays`. When a relay is excluded, its pubkey assignments are released back to the "needing" pool for reassignment to other relays.

### 4c. Nostur's Fallback Chains

**File:** `Nostur/Relays/Network/ConnectionPool.swift`

Nostur detects missing events through its connection pool lifecycle:
- Outbox connections idle for 10 minutes are cleaned up.
- Ephemeral (relay hint) connections are removed after 35 seconds.
- If a relay fails to connect or deliver events, Nostur falls back to the user's configured relays (which always run in parallel with outbox connections).

Nostur also detects misconfigured kind 10002 events: if any write relay matches a known-bad list (localhost, paid relays, write-only relays like blastr, NWC relays), the entire kind 10002 is discarded. This is a form of pre-emptive failure detection.

### 4d. Applesauce/noStrudel's Dead Relay Detection

**File:** `applesauce/packages/relay/src/liveness.ts`

After 5 consecutive connection failures, a relay is marked `dead` and permanently excluded from relay selection. This prevents the outbox system from repeatedly trying to connect to permanently-offline relays.

The `ignoreUnhealthyRelaysOnPointers` RxJS operator reactively removes unhealthy relays from outbox selection. When a relay goes offline, the pipeline automatically re-runs selection with the reduced relay set, potentially selecting replacement relays.

### 4e. NDK's System-Wide Disconnection Detection

**File:** `ndk/core/src/relay/pool/index.ts`

NDK detects when >50% of relays disconnect within 5 seconds, treating this as a network-level event (sleep/wake, network change). It triggers coordinated reconnection with reset backoff timers. This prevents individual relay failure detection from cascading into a full disconnection when the underlying network is temporarily down.

### 4f. Amethyst's Relay Offline Tracker

**File:** `quartz/src/commonMain/kotlin/com/vitorpamplona/quartz/nip01Core/relay/client/accessories/RelayOfflineTracker.kt`

Maintains a `cannotConnectRelays` set. The relay discovery code (`pickRelaysToLoadUsers`) subtracts offline relays from candidate sets, avoiding repeated attempts to connect to known-dead relays.

---

## 5. Research Opportunities

### 5a. Per-Author Event Coverage Measurement

No analyzed implementation tracks per-author event coverage (events received vs events that exist). This is the most important missing metric. A research tool could:

1. For each followed pubkey, query multiple diverse relays (including indexers) for all events in a time window.
2. Compare the events found via outbox routing vs the "ground truth" from the broad query.
3. Compute per-author coverage rate and identify systematic gaps.

This would answer: "For which follows is the outbox model failing, and why?"

### 5b. Relay List Propagation Latency

When a user publishes a new kind 10002, how long does it take for different clients/indexers to see it? This could be measured by:

1. Publishing a kind 10002 update.
2. Polling indexer relays and general relays for the updated version.
3. Recording time-to-visibility at each relay.

This would reveal bottlenecks in the relay list distribution pipeline.

### 5c. Coverage vs. Connection Count Frontier

The tradeoff between coverage and connections is central to outbox design, but no implementation measures it explicitly. A research tool could:

1. For a given follow list, compute the coverage achieved at 5, 10, 15, 20, 25 connections.
2. Plot the diminishing returns curve.
3. Compare algorithms (Gossip's greedy set-cover, Applesauce's set-cover, NDK's popularity ranking, Welshman's weighted scoring).

This would empirically answer: "How many connections does the average user need for 95% coverage?" and "Which algorithm achieves the best coverage/connection ratio?"

### 5d. Relay List Completeness in the Wild

What fraction of active Nostr users have published a kind 10002 event? For those who have, how many relays do they list? Are the listed relays actually operational?

This is measurable from indexer relay data:

1. Query an indexer relay for all kind 10002 events.
2. For each, check if the listed relays are online (NIP-11 probe or connect test).
3. Compute statistics on relay list completeness, size distribution, and relay availability.

This would reveal how much of the network is actually reachable via the outbox model.

### 5e. Cross-Client Consistency

Do different outbox implementations reach the same events for the same follow list? This could be tested by:

1. Configuring multiple clients (Gossip, Coracle, NDK-based, Amethyst) with the same follow list.
2. Running them simultaneously for a period.
3. Comparing which events each client received.

Differences would reveal algorithm-specific blind spots and implementation bugs.

### 5f. Fallback Relay Dependency

When outbox routing fails, how often does the fallback actually find the missing events? This could be measured by:

1. Intentionally removing kind 10002 data for a subset of follows.
2. Observing which events are found via fallback relays vs outbox relays.
3. Computing the "fallback rescue rate."

This would quantify how important the fallback chain is to overall coverage.

### 5g. Relay Hint Accuracy

How often do relay hints in event tags actually point to a relay that has the referenced event? This could be measured by:

1. Collecting relay hints from e-tags, p-tags, and NIP-19 entities.
2. Querying the hinted relay for the referenced event or pubkey's events.
3. Computing the "hint accuracy rate."

Low accuracy would suggest that relay hints are stale or unreliable, while high accuracy would validate them as a useful supplementary heuristic.

### 5h. The Long Tail Problem

Users on obscure or single-operator relays are hardest to reach. What fraction of the follow graph is "long tail" (on relays used by fewer than 10 pubkeys)? How does coverage differ for long-tail vs mainstream users?

This requires combining relay list data with follow graph data to identify which users are on isolated relays and whether those relays are reliably included in outbox selection.

### 5i. Real-Time Coverage Dashboard

Building on noStrudel's outbox selection debugger, a more comprehensive dashboard could display:
- Live event coverage rate (events received / expected) with trending
- Per-follow health indicators (green = recent events seen, yellow = stale, red = no events)
- Relay connection efficiency (events delivered per connection per hour)
- Relay list freshness distribution across follows
- Automatic detection of follows whose relay lists have changed since last fetch

This would transform the outbox model from an opaque system into an observable, debuggable one.
