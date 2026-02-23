import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
} from "../types.ts";

/**
 * Filter Decomposition (rust-nostr style)
 * Per-pubkey: select up to N WRITE relays. No global optimization.
 * Selection order: deterministic lexicographic relay URL order.
 */
export function filterDecomposition(
  input: BenchmarkInput,
  params: AlgorithmParams,
  _rng: () => number,
): AlgorithmResult {
  const start = performance.now();
  const writeLimit = params.writeLimit ?? 3;

  const relayAssignments = new Map<RelayUrl, Set<Pubkey>>();
  const pubkeyAssignments = new Map<Pubkey, Set<RelayUrl>>();
  const orphanedPubkeys = new Set<Pubkey>();

  for (const pubkey of input.follows) {
    const authorRelays = input.writerToRelays.get(pubkey);
    if (!authorRelays || authorRelays.size === 0) {
      orphanedPubkeys.add(pubkey);
      continue;
    }

    // Sort lexicographically for deterministic selection
    const sorted = [...authorRelays].sort();
    const selected = sorted.slice(0, writeLimit);

    const pubkeyRelays = new Set<RelayUrl>(selected);
    pubkeyAssignments.set(pubkey, pubkeyRelays);

    for (const relay of selected) {
      const writers = relayAssignments.get(relay) ?? new Set<Pubkey>();
      writers.add(pubkey);
      relayAssignments.set(relay, writers);
    }
  }

  return {
    name: "Filter Decomposition",
    relayAssignments,
    pubkeyAssignments,
    orphanedPubkeys,
    params,
    executionTimeMs: performance.now() - start,
  };
}
