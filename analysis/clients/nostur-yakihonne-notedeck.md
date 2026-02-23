# Outbox Implementation: Nostur, Yakihonne, Notedeck

## Summary

| Client | Language | Outbox Status | Scope | Approach |
|--------|----------|--------------|-------|----------|
| **Nostur** | Swift/iOS | Mature, opt-in ("Autopilot") | Follows + custom feeds only | Full NIP-65 outbox+inbox with request planning, write relay routing, and connection pooling |
| **Yakihonne** | Dart/Flutter | Partial / Display-only | Own relays only | Reads kind 10002 to display and self-configure relays; no outbox routing for feeds |
| **Notedeck** | Rust | Foundation only (PR #1288 in progress) | Own account's relay list | Parses NIP-65, manages own relay set from kind 10002; no outbox routing for follows yet |

Nostur is the only client of the three with a complete outbox implementation for reading and writing. Yakihonne uses kind 10002 for self-relay-management only. Notedeck has NIP-65 parsing in place but does not yet route requests per-author.

---

## Nostur (Swift/iOS)

Two-layer architecture:
- **NostrEssentials library** -- core outbox algorithms (`createRequestPlan`, `createWritePlan`, `pubkeysByRelay`)
- **Nostur app layer** -- `OutboxLoader`, `ConnectionPool`, settings, relay hint resolution

Called "Autopilot" in UI, **disabled by default**. Separate "Follow relay hints" toggle controls ephemeral connections from nostr links.

### Kind 10002 Processing

**File:** `/tmp/outbox-research/nostur/Nostur/Relays/Network/OutboxLoader.swift`

On load: fetches kind 10002 from CoreData for all followed pubkeys, sends REQ with `since:` optimization, passes results to `ConnectionPool.setPreferredRelays()`.

- Kind 10002 only fetched for follows + custom contact feed pubkeys with `.useOutbox` enabled
- Does NOT apply to arbitrary pubkeys discovered while browsing

**Misconfigured kind 10002 detection** -- hardcoded list of known-bad relay entries:

```swift
let DETECT_MISCONFIGURED_KIND10002_HELPER_LIST: Set<String> = [
    "ws://127.0.0.1",
    "ws://localhost",
    "wss://filter.nostr.wine",     // paid
    "wss://welcome.nostr.wine",    // special feed relay
    "wss://nostr.mutinywallet.com", // blastr (write-only)
    "wss://feeds.nostr.band",      // special feeds
    "wss://search.nos.today",
    "wss://relay.getalby.com",     // NWC only
    "sendit.nosflare.com",         // rejects REQs
]
```

If ANY write relay matches this list, the entire kind 10002 is discarded.

### Outbox Algorithm (NostrEssentials Library)

**File:** `/Users/e/Desktop/develop/nostrability/outbox/nostr-essentials-src/Sources/NostrEssentials/Outbox/Outbox.swift`

`pubkeysByRelay()` processes kind 10002 events into two maps:
- `findEventsRelays`: relay URL -> pubkeys whose kind 10002 marks that relay as "write" (or no marker = both)
- `reachUserRelays`: relay URL -> pubkeys whose kind 10002 marks that relay as "read" (or no marker = both)

`createRequestPlan()` generates per-relay REQ filters:
- Sorts relays by most pubkey coverage first
- **Skips top N relays** (`skipTopRelays: 3` for Following feed) to avoid centralizing on popular relays
- Single-pubkey requests: finds up to 2 relays
- Multi-pubkey requests: greedy assignment tracking which pubkeys are covered

```swift
public func createRequestPlan(
    pubkeys: Set<String>,
    reqFilters: [Filters],
    ourReadRelays: Set<String>,
    preferredRelays: PreferredRelays,
    skipTopRelays: Int = 0
) -> RequestPlan
```

`createWritePlan()` -- for each pubkey in `p` tags, finds their read relays, excludes relays already in user's write set, greedy assignment with most-covered relays first.

### Connection Management

**File:** `/tmp/outbox-research/nostur/Nostur/Relays/Network/ConnectionPool.swift`

Three separate connection pools:
1. **`connections`** -- User's configured relays (persistent)
2. **`outboxConnections`** -- Outbox-derived relays (auto-cleaned after 10 min idle)
3. **`ephemeralConnections`** -- Relay hint connections (auto-removed after 35 seconds)

```swift
guard SettingsStore.shared.enableOutboxRelays, vpnGuardOK() else { return }
guard let preferredRelays = self.preferredRelays else { return }

if message.type == .REQ && !preferredRelays.findEventsRelays.isEmpty {
    self.sendToOthersPreferredWriteRelays(...)
}
else if message.type == .EVENT && !preferredRelays.reachUserRelays.isEmpty {
    guard AccountsState.shared.bgFullAccountPubkeys.contains(pubkey) else { return }
    self.sendToOthersPreferredReadRelays(...)
}
```

- Max outbox connections: 50 (`maxPreferredRelays`)
- Special-purpose relay exclusion: `nostr.mutinywallet.com`, `filter.nostr.wine`, `purplepag.es`

### Relay Hint Resolution

**File:** `/tmp/outbox-research/nostur/Nostur/Relays/Network/OutboxLoader.swift`

Priority cascade when composing posts (quotes, replies):
1. Write relay (kind 10002) + connection stats + received-from relay
2. Write relay + received-from relay
3. Write relay + connection stats
4. Write relay alone

Excludes: localhost, non-wss, 127.0.x.x, "local", "iCloud", auth-required relays.

### Privacy and Resource Controls

- **VPN detection gate:** outbox connections only proceed when VPN detected (if enabled)
- **Low data mode:** disables all outbox routing
- **Outbox preview:** optional UI showing which additional relays will be used when composing

### Kind 10002 Publishing (Configuration Wizard)

**File:** `/tmp/outbox-research/nostur/Nostur/Relays/Kind10002ConfigurationWizard.swift`

Multi-step wizard: write relays (max 3), read relays (max 3), DM relays (max 3, kind 10050). Supports local signing and NSecBunker.

---

## Yakihonne (Dart/Flutter)

No outbox routing for feeds. Connects to 5 constant relays plus user's own kind 10002 relays.

### Constant Relays

**File:** `/tmp/outbox-research/yakihonne/lib/utils/constants.dart`

```dart
const constantRelays = [
  'wss://nostr-01.yakihonne.com',
  'wss://nostr-02.yakihonne.com',
  'wss://nostr-03.dorafactory.org',
  'wss://nostr-02.dorafactory.org',
  'wss://relay.damus.io',
];
```

These cannot be removed and are always connected.

### Kind 10002 Usage

**File:** `/tmp/outbox-research/yakihonne/lib/nostr/nips/nip_065.dart`

- Has a proper NIP-65 decoder (`Nip65.decodeRelaysList`) but it is never used for outbox routing
- On login: resets to `constantRelays`, fetches user's own kind 10002, connects to all relays from it (no read/write distinction)
- Does NOT fetch kind 10002 for other users

### On-Demand Event Lookup Fallback

**File:** `/tmp/outbox-research/yakihonne/lib/blocs/main_cubit/main_cubit.dart`

When an event cannot be found on connected relays, fetches the author's kind 10002, temporarily connects to their relays, fetches the event, then disconnects. Only triggers for individual event lookups (naddr/nevent resolution), not feeds.

### Kind 10002 Publishing

Publishes ALL relays as bare `["r", url]` tags with **no read/write markers**.

### What Yakihonne Does NOT Do

- No outbox routing for feeds (does not fetch follows' kind 10002)
- No per-author relay selection for subscriptions
- No inbox routing when publishing
- No read/write marker distinction in relay selection

---

## Notedeck (Rust)

NIP-65 parsing and relay configuration done. No outbox routing yet. PR #1288 pending.

### Kind 10002 Infrastructure

**File:** `/tmp/outbox-research/notedeck/crates/notedeck/src/account/relay.rs`

```rust
pub(crate) struct AccountRelayData {
    pub filter: Filter,
    pub local: BTreeSet<RelaySpec>,     // used locally but not advertised
    pub advertised: BTreeSet<RelaySpec>, // advertised via NIP-65
}
```

**File:** `/tmp/outbox-research/notedeck/crates/notedeck/src/relayspec.rs`

```rust
pub struct RelaySpec {
    pub url: String,
    pub has_read_marker: bool,
    pub has_write_marker: bool,
}

impl RelaySpec {
    pub fn is_readable(&self) -> bool {
        !self.has_write_marker // only "write" relays are not readable
    }
    pub fn is_writable(&self) -> bool {
        !self.has_read_marker // only "read" relays are not writable
    }
}
```

Handles NIP-65 edge case: if both markers set, both turned off (relay treated as both read+write).

### Relay Configuration

**File:** `/tmp/outbox-research/notedeck/crates/notedeck/src/account/relay.rs`

Priority: forced relays > local+advertised > bootstrap relays. Uses diff-based add/remove against pool. Kind 10002 changes tracked via nostrdb subscription with live updates.

Bootstrap relays: `relay.damus.io`, `nos.lol`, `nostr.wine`, `purplepag.es`

### Current State

- Flat relay pool -- all relays receive all messages (no per-relay filtering)
- `send_to()` method exists for targeted sending but unused for outbox routing
- `RelaySpec.is_readable()` / `is_writable()` exist but not used for routing
- Includes multicast relay for local network discovery between Notedeck instances

### What Notedeck Does NOT Yet Do

- No fetching kind 10002 for followed pubkeys (only own account)
- No per-author relay routing for subscriptions
- No inbox routing when publishing
- No relay hint following

PR #1288 likely builds on existing `AccountRelayData`, `RelaySpec`, `FilterStates` per-relay state machine, and `send_to()` method.

---

## Comparative Table

| Feature | Nostur | Yakihonne | Notedeck |
|---------|--------|-----------|----------|
| **Reading** | | | |
| Fetches kind 10002 for follows | Yes (up to 2000) | No | No (own account only) |
| Per-author relay routing | Yes (RequestPlan) | No | No |
| Skips centralized relays | Yes (skipTopRelays) | No | No |
| Connection limit | 50 outbox relays | N/A | N/A |
| **Writing** | | | |
| Publishes to p-tagged users' read relays | Yes (WritePlan) | No | No |
| Own kind 10002 publishing | Yes (wizard) | Yes (no markers) | Yes |
| Read/write marker support | Yes | No (bare "r" tags) | Yes |
| DM relay support (kind 10050) | Yes | No | No |
| **Relay Hints** | | | |
| Follows relay hints in events | Yes (opt-in) | Partial (event lookup only) | No |
| Relay hint in composed events | Yes (resolveRelayHint) | No | No |
| Ephemeral connections | Yes (35s timeout) | Yes (2s delay + disconnect) | No |
| **Privacy / Resources** | | | |
| VPN detection gate | Yes | No | No |
| Low data mode | Yes (disables outbox) | No | No |
| Outbox on/off toggle | Yes (default off) | N/A | N/A |
| Connection cleanup | Stale outbox: 10min, ephemeral: 35s | Manual disconnect | N/A |
| Penalty box for bad relays | Yes | No | No |
| **Misconfigured Kind 10002** | | | |
| Detects bad write relays | Yes (hardcoded list) | No | No |
| Discards garbage kind 10002 | Yes (entire event) | No | No |
| Validates relay URLs | Yes (filters localhost, non-wss) | No | Yes (URL parsing) |
