import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
} from "../types.ts";

/**
 * Stochastic Greedy (Lazier Than Lazy Greedy).
 *
 * At each step, instead of evaluating ALL relays, samples a random subset
 * of size (n/k) * ln(1/epsilon) and picks the best from that sample.
 * Achieves (1 - 1/e - epsilon) approximation in O(n * ln(1/epsilon)) time.
 *
 * Reference: Mirzasoleiman et al., "Lazier Than Lazy Greedy," AAAI 2015.
 *
 * For large follow lists, this is 10-100x faster than standard greedy
 * with negligible quality loss.
 */
export function stochasticGreedy(
  input: BenchmarkInput,
  params: AlgorithmParams,
  rng: () => number,
): AlgorithmResult {
  const start = performance.now();
  const maxConnections = params.maxConnections ?? 20;
  const epsilon = 0.1; // Controls tradeoff: smaller = closer to greedy, larger = faster

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

  // Available relays
  const availableRelays = [...input.relayToWriters.keys()];
  const used = new Set<RelayUrl>();
  const n = availableRelays.length;
  const k = Math.min(maxConnections, n);

  // Sample size per step: (n/k) * ln(1/epsilon)
  const sampleSize = Math.max(1, Math.ceil((n / k) * Math.log(1 / epsilon)));

  for (let step = 0; step < k && uncovered.size > 0; step++) {
    // Sample random subset of available relays
    const candidates: RelayUrl[] = [];
    const remaining = availableRelays.filter((r) => !used.has(r));
    const actualSampleSize = Math.min(sampleSize, remaining.length);

    if (actualSampleSize === remaining.length) {
      // Sample everything if sample >= remaining
      candidates.push(...remaining);
    } else {
      // Fisher-Yates partial shuffle for sampling
      const arr = [...remaining];
      for (let i = 0; i < actualSampleSize; i++) {
        const j = i + Math.floor(rng() * (arr.length - i));
        [arr[i], arr[j]] = [arr[j], arr[i]];
        candidates.push(arr[i]);
      }
    }

    // Find best relay in sample by marginal coverage
    let bestRelay: RelayUrl | null = null;
    let bestMarginal = 0;

    for (const relay of candidates) {
      const writers = input.relayToWriters.get(relay);
      if (!writers) continue;
      let marginal = 0;
      for (const w of writers) {
        if (uncovered.has(w)) marginal++;
      }
      if (
        marginal > bestMarginal ||
        (marginal === bestMarginal && (!bestRelay || relay < bestRelay))
      ) {
        bestMarginal = marginal;
        bestRelay = relay;
      }
    }

    if (!bestRelay || bestMarginal === 0) break;

    // Select this relay
    used.add(bestRelay);
    const writers = input.relayToWriters.get(bestRelay)!;
    const assignedPubkeys = new Set<Pubkey>();

    for (const pubkey of writers) {
      if (uncovered.has(pubkey)) {
        assignedPubkeys.add(pubkey);
        uncovered.delete(pubkey);

        const existing =
          pubkeyAssignments.get(pubkey) ?? new Set<RelayUrl>();
        existing.add(bestRelay);
        pubkeyAssignments.set(pubkey, existing);
      }
    }

    relayAssignments.set(bestRelay, assignedPubkeys);
  }

  // Remaining uncovered are algorithm orphans
  for (const pubkey of uncovered) {
    if (!pubkeyAssignments.has(pubkey)) {
      orphanedPubkeys.add(pubkey);
    }
  }

  return {
    name: "Stochastic Greedy",
    relayAssignments,
    pubkeyAssignments,
    orphanedPubkeys,
    params,
    executionTimeMs: performance.now() - start,
    notes: [`Sample size per step: ${sampleSize}, epsilon: ${epsilon}`],
  };
}
