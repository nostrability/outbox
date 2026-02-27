import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
} from "../types.ts";
import { sampleBeta } from "./beta.ts";

/**
 * Filter Decomposition + Thompson Sampling
 *
 * Same per-author structure as Filter Decomposition (rust-nostr): select up
 * to N write relays per author, no global optimization. But instead of
 * lexicographic ordering, rank relays by Beta-sampled scores from delivery
 * history.
 *
 * Key difference from Welshman+Thompson: no popularity weight (1 + log(weight)).
 * Score = sampleBeta(alpha, beta) only. This avoids biasing toward high-volume
 * relays that prune aggressively — learning purely from delivery.
 *
 * Cold start: sampleBeta(1,1) = uniform random, equivalent to random selection.
 * Warm start: relays that delivered well get higher Beta parameters.
 */
export function fdThompson(
  input: BenchmarkInput,
  params: AlgorithmParams,
  rng: () => number,
): AlgorithmResult {
  const start = performance.now();
  const writeLimit = params.writeLimit ?? params.relayLimit ?? 3;
  const relayPriors = params.relayPriors;

  const relayAssignments = new Map<RelayUrl, Set<Pubkey>>();
  const pubkeyAssignments = new Map<Pubkey, Set<RelayUrl>>();
  const orphanedPubkeys = new Set<Pubkey>();

  let priorsUsed = 0;
  const priorsTotal = relayPriors ? relayPriors.size : 0;

  for (const pubkey of input.follows) {
    const authorRelays = input.writerToRelays.get(pubkey);
    if (!authorRelays || authorRelays.size === 0) {
      orphanedPubkeys.add(pubkey);
      continue;
    }

    // Score each relay purely by Beta sample (no popularity weight)
    const scored: { relay: RelayUrl; score: number }[] = [];
    for (const relay of authorRelays) {
      const prior = relayPriors?.get(relay);
      const sample = prior
        ? sampleBeta(prior.alpha, prior.beta, rng)
        : sampleBeta(1, 1, rng); // uniform = rng()

      if (prior) priorsUsed++;
      scored.push({ relay, score: sample });
    }

    // Sort by score descending, tie-break by URL ascending (deterministic)
    scored.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.relay < b.relay ? -1 : a.relay > b.relay ? 1 : 0;
    });

    // Select top N
    const limit = Math.min(writeLimit, scored.length);
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
    notes.push(`FD+Thompson: ${priorsTotal} relay priors loaded, ${priorsUsed} prior lookups used`);
  } else {
    notes.push("FD+Thompson: cold start (uniform priors)");
  }

  return {
    name: "FD+Thompson",
    relayAssignments,
    pubkeyAssignments,
    orphanedPubkeys,
    params,
    executionTimeMs: performance.now() - start,
    notes,
  };
}
