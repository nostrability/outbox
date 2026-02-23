import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
} from "../types.ts";

/**
 * Primal Baseline: route all authors to Primal's caching aggregator relay.
 * Tests: "what if you just used a big caching relay?"
 */
const PRIMAL_RELAY: RelayUrl = "wss://relay.primal.net";

export function primalBaseline(
  input: BenchmarkInput,
  params: AlgorithmParams,
  _rng: () => number,
): AlgorithmResult {
  const start = performance.now();

  const relayAssignments = new Map<RelayUrl, Set<Pubkey>>();
  const pubkeyAssignments = new Map<Pubkey, Set<RelayUrl>>();
  const orphanedPubkeys = new Set<Pubkey>();

  const primalWriters = new Set<Pubkey>();
  relayAssignments.set(PRIMAL_RELAY, primalWriters);

  for (const pubkey of input.follows) {
    const relays = input.writerToRelays.get(pubkey);
    if (!relays || relays.size === 0) {
      // Still assign to primal — it's an aggregator, may have their events anyway
      primalWriters.add(pubkey);
      pubkeyAssignments.set(pubkey, new Set([PRIMAL_RELAY]));
      continue;
    }

    primalWriters.add(pubkey);
    pubkeyAssignments.set(pubkey, new Set([PRIMAL_RELAY]));
  }

  return {
    name: "Primal Aggregator",
    relayAssignments,
    pubkeyAssignments,
    orphanedPubkeys,
    params,
    executionTimeMs: performance.now() - start,
  };
}
