# Nostur, Yakihonne, Notedeck

---

## Nostur (Swift, iOS)

### Quick Facts
| Setting | Value |
|---------|-------|
| Algorithm | Greedy coverage sort with skipTopRelays |
| Connection cap | 50 (`maxPreferredRelays`, outbox pool) |
| Per-pubkey target | 2 |
| Fallback relays | User's own configured relays (always queried in parallel) |
| Health tracking | Misconfigured kind 10002 detection + stale relay cleanup (10min idle) |
| NIP-17 DM inbox | Partial (publishes kind 10050 via wizard, doesn't route outgoing DMs to recipients' 10050 relays) |
| Configurable | No (Autopilot on/off toggle; low data mode disables outbox) |

### How It Works
Nostur uses a two-layer architecture: the NostrEssentials library provides pure outbox algorithms (`createRequestPlan`, `createWritePlan`), and the Nostur app layer handles loading, connection pooling, and settings. Called "Autopilot" in the UI, disabled by default. The request plan sorts relays by pubkey coverage count, skips the top 3 relays (`skipTopRelays`) to avoid centralizing on popular relays, then greedily assigns pubkeys. Three separate connection pools: persistent (user's relays), outbox (auto-cleaned after 10min idle), and ephemeral (relay hints, 35s timeout).

### Notable
- Only client that skips top-N popular relays to force anti-centralization. Costs 5–12% assignment coverage vs standard greedy, but distributes load to smaller relays.
- Aggressive misconfigured kind 10002 detection: if ANY write relay matches a 9-entry known-bad list (localhost, filter.nostr.wine, blastr, NWC relays, etc.), the entire kind 10002 is discarded.
- VPN detection gate: outbox connections silently skipped if VPN detection is enabled and no VPN detected. Prevents IP leakage to untrusted relays.
- Low data mode disables outbox entirely for bandwidth/battery savings.

---

## Yakihonne (Dart, Flutter)

### Quick Facts
| Setting | Value |
|---------|-------|
| Algorithm | None (static relay list) |
| Connection cap | N/A |
| Per-pubkey target | N/A |
| Fallback relays | 4 Yakihonne/Dorafactory relays + relay.damus.io (constant, cannot be removed) |
| Health tracking | None |
| NIP-17 DM inbox | No |
| Configurable | No |

### How It Works
Yakihonne has no outbox routing for feeds. It connects to 5 constant relays plus the user's own kind 10002 relays. It has a proper NIP-65 decoder but never uses it for per-author routing. When a specific event cannot be found on connected relays, it fetches the author's kind 10002, temporarily connects to their relays (~2s), fetches the event, then disconnects.

### Notable
- Constant relays (4 Yakihonne/Dorafactory + relay.damus.io) cannot be removed by the user. Most centralized relay configuration among analyzed clients.
- Publishes kind 10002 with ALL relays as bare `["r", url]` tags — no read/write markers, which violates the NIP-65 intent for role separation.
- On-demand event lookup is the only outbox-adjacent feature: temporarily connects to an author's relays for individual event resolution, not feeds.

---

## Notedeck (Rust, Desktop/Mobile)

### Quick Facts
| Setting | Value |
|---------|-------|
| Algorithm | None (flat pool, all relays get all messages) |
| Connection cap | N/A |
| Per-pubkey target | N/A |
| Fallback relays | relay.damus.io, nos.lol, nostr.wine, purplepag.es |
| Health tracking | None |
| NIP-17 DM inbox | No |
| Configurable | No |

### How It Works
Notedeck has NIP-65 infrastructure in place but no outbox routing yet (PR #1288 pending). It parses kind 10002 into RelaySpec structs with read/write markers and manages the user's own relay set, but does not fetch kind 10002 for followed pubkeys or route requests per-author. All relays receive all messages uniformly via a flat pool.

### Notable
- NIP-65 parsing is complete: `RelaySpec` handles read/write markers correctly (both markers set = treated as both read+write). Infrastructure is ready for outbox routing.
- Priority system for relay selection: forced relays > local + advertised > bootstrap relays. Uses diff-based add/remove against the pool.
- Includes multicast relay for local network discovery between Notedeck instances.
