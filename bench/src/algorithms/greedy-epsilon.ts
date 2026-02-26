import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
} from "../types.ts";

/**
 * Greedy Set-Cover with epsilon-exploration.
 * Same as greedy-set-cover, but at each relay selection step,
 * with probability epsilon, pick a random relay instead of the best.
 */
export function greedyEpsilon(
  input: BenchmarkInput,
  params: AlgorithmParams,
  rng: () => number,
): AlgorithmResult {
  const start = performance.now();
  const maxConnections = params.maxConnections ?? 20;
  const maxRelaysPerUser = params.maxRelaysPerUser ?? Infinity;
  const epsilon = params.epsilon ?? 0.05;

  const relayAssignments = new Map<RelayUrl, Set<Pubkey>>();
  const pubkeyAssignments = new Map<Pubkey, Set<RelayUrl>>();
  const orphanedPubkeys = new Set<Pubkey>();

  // Track uncovered pubkeys (only those with relay data)
  const uncovered = new Set<Pubkey>();
  for (const pubkey of input.follows) {
    const relays = input.writerToRelays.get(pubkey);
    if (relays && relays.size > 0) {
      uncovered.add(pubkey);
    } else {
      orphanedPubkeys.add(pubkey);
    }
  }

  // Build mutable coverage map (relay -> uncovered pubkeys it can still cover)
  const relayCoverage = new Map<RelayUrl, Set<Pubkey>>();
  for (const [relay, writers] of input.relayToWriters) {
    const relevant = new Set<Pubkey>();
    for (const w of writers) {
      if (uncovered.has(w)) relevant.add(w);
    }
    if (relevant.size > 0) relayCoverage.set(relay, relevant);
  }

  // Track how many relays assigned per pubkey
  const pubkeyRelayCount = new Map<Pubkey, number>();

  let selectedCount = 0;
  while (uncovered.size > 0 && selectedCount < maxConnections) {
    let bestRelay: RelayUrl | null = null;

    if (rng() < epsilon && relayCoverage.size > 0) {
      // Epsilon-exploration: pick a random relay from remaining candidates
      const relays = [...relayCoverage.keys()];
      bestRelay = relays[Math.floor(rng() * relays.length)];
    } else {
      // Greedy: find relay covering most uncovered pubkeys
      let bestCount = 0;
      const relays = [...relayCoverage.keys()].sort();

      for (const relay of relays) {
        const covered = relayCoverage.get(relay)!;
        if (covered.size > bestCount || (covered.size === bestCount && (!bestRelay || relay < bestRelay))) {
          bestCount = covered.size;
          bestRelay = relay;
        }
      }

      if (bestCount === 0) break;
    }

    if (!bestRelay) break;

    // Select this relay
    const coveredByRelay = relayCoverage.get(bestRelay)!;
    const assignedPubkeys = new Set<Pubkey>();

    for (const pubkey of coveredByRelay) {
      assignedPubkeys.add(pubkey);
      const count = (pubkeyRelayCount.get(pubkey) ?? 0) + 1;
      pubkeyRelayCount.set(pubkey, count);

      const existing = pubkeyAssignments.get(pubkey) ?? new Set<RelayUrl>();
      existing.add(bestRelay);
      pubkeyAssignments.set(pubkey, existing);

      if (count >= maxRelaysPerUser) {
        uncovered.delete(pubkey);
      }
    }

    relayAssignments.set(bestRelay, assignedPubkeys);
    selectedCount++;

    // Remove covered pubkeys that hit their limit from all relay coverage sets
    relayCoverage.delete(bestRelay);
    for (const [relay, covered] of relayCoverage) {
      for (const pubkey of assignedPubkeys) {
        if ((pubkeyRelayCount.get(pubkey) ?? 0) >= maxRelaysPerUser) {
          covered.delete(pubkey);
        }
      }
      if (covered.size === 0) relayCoverage.delete(relay);
    }
  }

  // Any still-uncovered pubkeys that had relay data are algorithm orphans
  for (const pubkey of uncovered) {
    if (!pubkeyAssignments.has(pubkey)) {
      orphanedPubkeys.add(pubkey);
    }
  }

  return {
    name: `Greedy+ε-Explore (ε=${epsilon})`,
    relayAssignments,
    pubkeyAssignments,
    orphanedPubkeys,
    params,
    executionTimeMs: performance.now() - start,
  };
}
