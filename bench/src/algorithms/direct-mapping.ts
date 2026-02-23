import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
} from "../types.ts";

/**
 * Direct Mapping (Amethyst baseline)
 * Use ALL declared write relays. No optimization. Unoptimized upper bound.
 */
export function directMapping(
  input: BenchmarkInput,
  params: AlgorithmParams,
  _rng: () => number,
): AlgorithmResult {
  const start = performance.now();

  const relayAssignments = new Map<RelayUrl, Set<Pubkey>>();
  const pubkeyAssignments = new Map<Pubkey, Set<RelayUrl>>();
  const orphanedPubkeys = new Set<Pubkey>();

  for (const pubkey of input.follows) {
    const relays = input.writerToRelays.get(pubkey);
    if (!relays || relays.size === 0) {
      orphanedPubkeys.add(pubkey);
      continue;
    }

    pubkeyAssignments.set(pubkey, new Set(relays));
    for (const relay of relays) {
      const writers = relayAssignments.get(relay) ?? new Set<Pubkey>();
      writers.add(pubkey);
      relayAssignments.set(relay, writers);
    }
  }

  return {
    name: "Direct Mapping",
    relayAssignments,
    pubkeyAssignments,
    orphanedPubkeys,
    params,
    executionTimeMs: performance.now() - start,
  };
}
