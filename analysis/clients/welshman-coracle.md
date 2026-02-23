# Welshman / Coracle (TypeScript, Browser)

## Quick Facts
| Setting | Value |
|---------|-------|
| Algorithm | Weighted stochastic scoring |
| Connection cap | None (3 relays per routing scenario by default) |
| Per-pubkey target | 3 (`relay_limit`, configurable) |
| Fallback relays | relay.damus.io, nos.lol (env-configured) |
| Health tracking | Tiered error thresholds (1/min, 3/hr, 10/day = quality 0) |
| NIP-17 DM inbox | Yes (messaging mode via kind 10050) |
| Configurable | Yes (`relay_limit` user-adjustable) |

## How It Works

Welshman is a stateless Router library; all relay knowledge comes from injected callbacks. It creates RouterScenario instances that build weighted Selection arrays from scenarios (FromPubkeys for outbox reads, ForUser for inbox, PublishEvent for writes, etc.), merges them by summing weights per relay, then scores with `quality * (1 + log(weight)) * random()`. Top N relays selected per scenario. The `random()` factor means two identical queries may hit different relay sets — this stochastic variation distributes load and, as benchmarks show, accidentally produces the best archival event recall among deployed client algorithms (37.8% at 1yr). Coracle configures Welshman with static default, indexer, search, and signer relay lists via environment variables.

## Notable

- Only implementation with stochastic relay selection. The `random()` factor isn't just anti-centralization — benchmarks show it's the best archival strategy among deployed clients (37.8% recall at 1yr vs greedy's 16.3%).
- `Math.log(weight)` compresses hub bias: a relay in 100 users' lists scores ~5.6x vs 1 user, not 100x. Prevents popular relay domination without an explicit skip mechanism.
- Quality is a hard gate: blocked relays, recent errors, onion relays, and `ws://` URLs all get quality 0 (complete exclusion). Quality tiers: connected=1.0, seen=0.9, standard=0.8, weird URL=0.7.
- Lazy connect-on-send with 30s inactivity auto-close. No persistent connection pool — sockets open when needed, close when idle.
- Supports NIP-77 (negentropy) sync for bandwidth-efficient incremental updates on capable relays.
