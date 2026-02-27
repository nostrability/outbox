import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
} from "../types.ts";

/**
 * Big Relays baseline: assign follows only to relay.damus.io and nos.lol
 * if they declare those as write relays. Tests: "what if you just used
 * the two biggest relays?"
 */
const BIG_RELAY_URLS = [
  "wss://relay.damus.io",
  "wss://relay.damus.io/",
  "wss://nos.lol",
  "wss://nos.lol/",
];

export function bigRelaysBaseline(
  input: BenchmarkInput,
  params: AlgorithmParams,
  _rng: () => number,
): AlgorithmResult {
  const start = performance.now();

  const relayAssignments = new Map<RelayUrl, Set<Pubkey>>();
  const pubkeyAssignments = new Map<Pubkey, Set<RelayUrl>>();
  const orphanedPubkeys = new Set<Pubkey>();

  const bigRelaySet = new Set(BIG_RELAY_URLS);

  for (const pubkey of input.follows) {
    const relays = input.writerToRelays.get(pubkey);
    if (!relays || relays.size === 0) {
      orphanedPubkeys.add(pubkey);
      continue;
    }

    const matched = new Set<RelayUrl>();
    for (const relay of relays) {
      if (bigRelaySet.has(relay)) {
        matched.add(relay);
      }
    }

    if (matched.size === 0) {
      orphanedPubkeys.add(pubkey);
      continue;
    }

    pubkeyAssignments.set(pubkey, matched);
    for (const relay of matched) {
      const existing = relayAssignments.get(relay) ?? new Set<Pubkey>();
      existing.add(pubkey);
      relayAssignments.set(relay, existing);
    }
  }

  return {
    name: "Big Relays (damus+nos.lol)",
    relayAssignments,
    pubkeyAssignments,
    orphanedPubkeys,
    params,
    executionTimeMs: performance.now() - start,
  };
}
