import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
} from "../types.ts";

/**
 * Weighted Stochastic (Welshman/Coracle style)
 * Per-pubkey scoring: quality * (1 + log(weight)) * random(), select top N.
 * Phase 1: quality = 1.0 for all relays.
 * Effective formula: (1 + log(weight)) * rng()
 * weight = how many follows write to this relay (global popularity).
 */
export function weightedStochastic(
  input: BenchmarkInput,
  params: AlgorithmParams,
  rng: () => number,
): AlgorithmResult {
  const start = performance.now();
  const relayLimit = params.relayLimit ?? params.maxRelaysPerUser ?? 3;

  const relayAssignments = new Map<RelayUrl, Set<Pubkey>>();
  const pubkeyAssignments = new Map<Pubkey, Set<RelayUrl>>();
  const orphanedPubkeys = new Set<Pubkey>();

  // Precompute relay weights (number of follows that write to each relay)
  const relayWeight = new Map<RelayUrl, number>();
  for (const [relay, writers] of input.relayToWriters) {
    relayWeight.set(relay, writers.size);
  }

  for (const pubkey of input.follows) {
    const authorRelays = input.writerToRelays.get(pubkey);
    if (!authorRelays || authorRelays.size === 0) {
      orphanedPubkeys.add(pubkey);
      continue;
    }

    // Score each relay
    const scored: { relay: RelayUrl; score: number }[] = [];
    for (const relay of authorRelays) {
      const weight = relayWeight.get(relay) ?? 1;
      const score = (1 + Math.log(weight)) * rng();
      scored.push({ relay, score });
    }

    // Sort by score descending, tie-break by URL ascending
    scored.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.relay < b.relay ? -1 : a.relay > b.relay ? 1 : 0;
    });

    // Select top N
    const limit = Math.min(relayLimit, scored.length);
    const selected = new Set<RelayUrl>();

    for (let i = 0; i < limit; i++) {
      const relay = scored[i].relay;
      selected.add(relay);

      const writers = relayAssignments.get(relay) ?? new Set<Pubkey>();
      writers.add(pubkey);
      relayAssignments.set(relay, writers);
    }

    pubkeyAssignments.set(pubkey, selected);
  }

  return {
    name: "Weighted Stochastic",
    relayAssignments,
    pubkeyAssignments,
    orphanedPubkeys,
    params,
    executionTimeMs: performance.now() - start,
  };
}
