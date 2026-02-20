import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
} from "../types.ts";

/**
 * Greedy Coverage Sort (Nostur style)
 * Sort relays by coverage count, skip top N most popular, greedily assign.
 * No iterative recalculation.
 * Tie-break: lexicographically smaller URL.
 */
export function greedyCoverageSort(
  input: BenchmarkInput,
  params: AlgorithmParams,
  _rng: () => number,
): AlgorithmResult {
  const start = performance.now();
  const skipTopRelays = params.skipTopRelays ?? 3;
  const maxRelaysPerUser = params.maxRelaysPerUser ?? 2;
  const maxConnections = params.maxConnections ?? Infinity;

  const relayAssignments = new Map<RelayUrl, Set<Pubkey>>();
  const pubkeyAssignments = new Map<Pubkey, Set<RelayUrl>>();
  const orphanedPubkeys = new Set<Pubkey>();

  // Sort relays by coverage count descending, tie-break by URL ascending
  const sortedRelays = [...input.relayToWriters.entries()]
    .sort((a, b) => {
      if (a[1].size !== b[1].size) return b[1].size - a[1].size;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });

  // Skip top N most popular relays
  const candidateRelays = sortedRelays.slice(skipTopRelays);

  // Track assignment count per pubkey
  const pubkeyRelayCount = new Map<Pubkey, number>();
  const followsSet = new Set(input.follows);
  let selectedCount = 0;

  for (const [relay, writers] of candidateRelays) {
    if (selectedCount >= maxConnections) break;

    const assignedPubkeys = new Set<Pubkey>();
    for (const pubkey of writers) {
      if (!followsSet.has(pubkey)) continue;
      const count = pubkeyRelayCount.get(pubkey) ?? 0;
      if (count >= maxRelaysPerUser) continue;

      assignedPubkeys.add(pubkey);
      pubkeyRelayCount.set(pubkey, count + 1);

      const existing = pubkeyAssignments.get(pubkey) ?? new Set<RelayUrl>();
      existing.add(relay);
      pubkeyAssignments.set(pubkey, existing);
    }

    if (assignedPubkeys.size > 0) {
      relayAssignments.set(relay, assignedPubkeys);
      selectedCount++;
    }
  }

  // Identify orphans
  for (const pubkey of input.follows) {
    if (!pubkeyAssignments.has(pubkey)) {
      orphanedPubkeys.add(pubkey);
    }
  }

  return {
    name: "Greedy Coverage Sort",
    relayAssignments,
    pubkeyAssignments,
    orphanedPubkeys,
    params,
    executionTimeMs: performance.now() - start,
  };
}
