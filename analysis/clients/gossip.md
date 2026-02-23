# Gossip (Rust, Desktop)

## Quick Facts
| Setting | Value |
|---------|-------|
| Algorithm | Greedy set-cover |
| Connection cap | 50 (`max_relays`) |
| Per-pubkey target | 2 (`num_relays_per_person`) |
| Fallback relays | None at runtime (data-driven only) |
| Health tracking | Success/failure counts + penalty box (15s–10min exclusion timers) |
| NIP-17 DM inbox | Yes (kind 10050) |
| Configurable | Yes (both caps user-adjustable, relay rank 0–9) |

## How It Works

Gossip uses a global RelayPicker singleton that runs greedy set-cover over all followed pubkeys. For each unassigned pubkey, it builds a scoreboard summing `association_score * adjusted_relay_score` per relay. Association score is 1.0 for declared relays (kind 10002, kind 3, NIP-05), 0.2 with 14-day halflife for relays where events were fetched, and 0.1 with 7-day halflife for relay hints. Relay score incorporates user-assignable rank (0–9), success rate, and connection status (halved if not connected). The picker iteratively selects the highest-scoring relay, assigns pubkeys scoring above threshold, and repeats until coverage or cap reached.

## Notable

- Only implementation with temporal decay on relay associations (14-day and 7-day halflife). Non-declared relays fade out if not re-confirmed.
- No hardcoded fallback relays at runtime. The setup wizard suggests 36 relays, but the runtime is entirely data-driven. If no relay data exists for a person, their events won't appear until discovery completes.
- Dedicated relay roles via bitmask flags: OUTBOX, INBOX, DISCOVER, DM, READ, WRITE, GLOBAL, SEARCH, SPAMSAFE. A single relay can serve multiple roles.
- Minion-per-relay architecture: each relay connection is its own async task coordinated by the Overlord through message passing.
- Penalty box assigns per-reason exclusion timers on disconnect: 15s (clean close) to 10min (DNS failure/rejection). Excluded relays release their pubkey assignments for reassignment.
