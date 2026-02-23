# Measuring Outbox Effectiveness

**Key gap: No client measures per-author event coverage.** No analyzed implementation tracks the fraction of events received vs events that exist for a given followed author. This is the most important missing metric in the outbox ecosystem.

---

## 1. Coverage Metrics

| Metric | Definition | Directly Measurable? |
|--------|-----------|:---:|
| **Event coverage** | events_received / events_published per followed pubkey over a time window | No -- no ground truth for "events published" |
| **User coverage** | followed pubkeys with >= 1 selected relay / total followed pubkeys | Yes |
| **Relay count efficiency** | followed_pubkeys / relay_connections (higher = more efficient) | Yes |
| **Latency** | time_received - time_published for events from follows | Partially -- `created_at` is author-declared |
| **Staleness** | age of kind 10002 event used for routing decisions | Yes |
| **Connection overhead** | connections delivering >= 1 event / total connections | Yes |

Proxy measurements for event coverage:
- Compare events found on relay A vs relay B for the same author
- Compare outbox routing results vs a known-complete indexer relay
- Count follows with zero events received (complete miss rate)

---

## 2. Observable Metrics in Code

| Project | What It Tracks | File | Used for Scoring? |
|---------|---------------|------|:---:|
| **Welshman** | Per-relay: open/close/error counts, publish success/failure, event count, EOSE count, auth events. Quality = tiered error thresholds (1/min, 3/hr, 10/day = quality 0). | `welshman/packages/app/src/relayStats.ts` | Yes -- quality gates relay selection |
| **Gossip** | Per-relay: success/failure counts, success_rate(). Per-person-relay: last_fetched (14-day halflife), last_suggested (7-day halflife). | `gossip-lib/src/storage/types/relay3.rs`, `person_relay2.rs` | Yes -- score *= 0.5 + 0.5 * success_rate() |
| **Nosotros** | Per-relay: event count, connect count. Per-event: (eventId, relay, created_at) in `seen` table. | `nosotros/src/db/sqlite/sqlite.schemas.ts` | Yes -- sorts candidates by event count DESC |
| **Amethyst** | Per-relay: ping, compression, bytes, errors. Per-user-relay: frequency counter + lastEvent timestamp via `UserRelaysCache`. | `quartz/.../relay/client/stats/RelayStats.kt`, `UserRelaysCache.kt` | Partially -- frequency map used as fallback heuristic |
| **Applesauce/noStrudel** | Three-state health: online/offline/dead. Exponential backoff (base 5s noStrudel, 30s applesauce). Dead = 5 consecutive failures, permanent. | `applesauce/packages/relay/src/liveness.ts` | Yes -- dead/offline relays excluded from selection |
| **Voyage** | `EventRelayAuthorView`: which relay delivered events from which author. | `app/src/main/java/.../data/room/entity/` | Yes -- fills coverage gaps in autopilot event retrieval |
| **Welshman (tracker)** | Bidirectional maps: eventId -> Set\<relay\>, relay -> Set\<eventId\>. Persisted to IndexedDB in Coracle. | `welshman/packages/net/src/tracker.ts` | No -- used for deduplication and provenance |

Gossip's per-person-relay temporal tracking with exponential decay is the closest any implementation comes to measuring per-author delivery effectiveness.

---

## 3. noStrudel's Outbox Selection Debugger

The only analyzed implementation that makes outbox selection visible to end users.

**Files:** `nostrudel/src/components/outbox-relay-selection-modal.tsx`, `nostrudel/src/views/settings/outbox-selection/index.tsx`

- Shows coverage percentage with color coding (green >= 80%, yellow >= 50%, red < 50%)
- Per-relay table: URL, users covered, connection status, coverage percentage
- "Users by relay count" breakdown: how many users have 0, 1, 2, 3+ relays
- Lists users with missing relay lists (no kind 10002)
- Lists "orphaned" users whose relays were all dropped during optimization
- Settings: Max Connections slider (0-30, default 20), Max Relays Per User slider (0-30, default 5)

---

## 4. Failure Detection

| Project | Mechanism | File |
|---------|-----------|------|
| **Gossip (seeker)** | State machine: WaitingRelayList -> WaitingEvent. 15s timeout on relay list discovery, then falls back to user's own READ relays. | `gossip-lib/src/seeker.rs` |
| **Gossip (penalty box)** | Exclusion timers: disconnected 2min, rejected/HTTP error/DNS failure 10min, timeout 1min, clean close 15s. Excluded relays release pubkey assignments for reassignment. | `gossip-lib/src/overlord.rs` |
| **Nostur** | Outbox connections cleaned up after 10min idle, ephemeral after 35s. Misconfigured kind 10002 detection: write relays checked against known-bad list (localhost, blastr, NWC relays) -- entire event discarded if any match. | `Nostur/Relays/Network/ConnectionPool.swift` |
| **Applesauce/noStrudel** | 5 consecutive failures = dead (permanent exclusion). `ignoreUnhealthyRelaysOnPointers` operator reactively re-runs selection when relays go offline. | `applesauce/packages/relay/src/liveness.ts` |
| **NDK** | System-wide disconnect detection: >50% relays disconnect within 5s triggers coordinated reconnection with reset backoff. Prevents cascade from network-level events (sleep/wake). | `ndk/core/src/relay/pool/index.ts` |
| **Amethyst** | `cannotConnectRelays` set subtracted from all candidate sets. | `quartz/.../relay/client/accessories/RelayOfflineTracker.kt` |

---

## 5. Research Opportunities

1. **Per-author event coverage measurement.** Query multiple diverse relays (including indexers) for all events from each followed pubkey. Compare outbox-routed results vs broad query. Identify which follows the outbox model fails for, and why.

2. **Relay list propagation latency.** Publish a kind 10002 update, poll relays for the new version, record time-to-visibility. Reveals bottlenecks in relay list distribution.

3. **Coverage vs. connection count frontier.** For a given follow list, compute coverage at 5/10/15/20/25 connections. Plot diminishing returns. Compare algorithms (Gossip, Applesauce, NDK, Welshman). Answers: "How many connections for 95% coverage?"

4. **Relay list completeness in the wild.** What fraction of active users have kind 10002? How many relays listed? Are listed relays operational? Measurable from indexer data + NIP-11 probes.

5. **Cross-client consistency.** Configure multiple clients with the same follow list, run simultaneously, compare events received. Differences reveal algorithm-specific blind spots.

6. **Fallback relay dependency.** Intentionally remove kind 10002 data for a subset of follows, observe what events fallback relays find. Quantifies fallback chain importance.

7. **Relay hint accuracy.** Collect relay hints from tags and bech32 entities, query the hinted relay for the referenced event. Compute hint accuracy rate.

8. **The long tail problem.** What fraction of the follow graph is on relays used by <10 pubkeys? How does coverage differ for long-tail vs mainstream users?

9. **Real-time coverage dashboard.** Extend noStrudel's debugger with: live event coverage trending, per-follow health indicators, relay connection efficiency, relay list freshness distribution, automatic stale relay list detection.
