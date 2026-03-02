import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
} from "../types.ts";
import { sampleBeta } from "./beta.ts";

/**
 * Welshman + Thompson Sampling
 *
 * Same structure as Weighted Stochastic (Welshman/Coracle), but replaces
 * the uniform rng() with a Beta distribution sample per relay, where the
 * Beta parameters come from historical delivery performance.
 *
 * Cold start (no priors): sampleBeta(1, 1) = uniform, equivalent to baseline Welshman.
 * Warm start: relays that historically delivered well get higher samples.
 */
export function welshmanThompson(
  input: BenchmarkInput,
  params: AlgorithmParams,
  rng: () => number,
): AlgorithmResult {
  const start = performance.now();
  const relayLimit = params.relayLimit ?? params.maxRelaysPerUser ?? 3;
  const relayPriors = params.relayPriors;

  const relayAssignments = new Map<RelayUrl, Set<Pubkey>>();
  const pubkeyAssignments = new Map<Pubkey, Set<RelayUrl>>();
  const orphanedPubkeys = new Set<Pubkey>();

  // Precompute relay weights (number of follows that write to each relay)
  const relayWeight = new Map<RelayUrl, number>();
  for (const [relay, writers] of input.relayToWriters) {
    relayWeight.set(relay, writers.size);
  }

  let priorsUsed = 0;
  let latencyUsed = 0;
  const priorsTotal = relayPriors ? relayPriors.size : 0;
  const relayLatencies = params.relayLatencies;

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
      const prior = relayPriors?.get(relay);
      const sample = prior
        ? sampleBeta(prior.alpha, prior.beta, rng)
        : sampleBeta(1, 1, rng); // uniform = rng()

      if (prior) priorsUsed++;

      const latMs = relayLatencies?.get(relay);
      const discount = latMs !== undefined ? 1 / (1 + latMs / 1000) : 1.0;
      if (latMs !== undefined) latencyUsed++;

      const score = (1 + Math.log(weight)) * sample * discount;
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

  const notes: string[] = [];
  if (relayPriors && relayPriors.size > 0) {
    notes.push(`Thompson Sampling: ${priorsTotal} relay priors loaded, ${priorsUsed} prior lookups used`);
  } else {
    notes.push("Thompson Sampling: cold start (uniform priors)");
  }
  if (relayLatencies?.size) {
    notes.push(`Latency discount: ${relayLatencies.size} relays with latency data, ${latencyUsed} lookups applied`);
  }

  return {
    name: relayLatencies?.size ? "Welshman+Thompson+Latency" : "Welshman+Thompson",
    relayAssignments,
    pubkeyAssignments,
    orphanedPubkeys,
    params,
    executionTimeMs: performance.now() - start,
    notes,
  };
}
