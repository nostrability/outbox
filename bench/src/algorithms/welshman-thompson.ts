import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
} from "../types.ts";

/**
 * Sample from a Beta(alpha, beta) distribution using the Jöhnk algorithm.
 * Returns a value in [0, 1].
 */
function sampleBeta(alpha: number, beta: number, rng: () => number): number {
  // For alpha=1, beta=1 (uniform prior), just return rng()
  if (alpha === 1 && beta === 1) return rng();

  // Jöhnk's algorithm for general alpha, beta
  if (alpha < 1 && beta < 1) {
    while (true) {
      const u = rng();
      const v = rng();
      const x = Math.pow(u, 1 / alpha);
      const y = Math.pow(v, 1 / beta);
      if (x + y <= 1) {
        if (x + y > 0) return x / (x + y);
        // Handle underflow by taking logs
        const logX = Math.log(u) / alpha;
        const logY = Math.log(v) / beta;
        const logM = logX > logY ? logX : logY;
        return Math.exp(logX - logM) / (Math.exp(logX - logM) + Math.exp(logY - logM));
      }
    }
  }

  // For larger alpha/beta, use gamma sampling approach
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  return x / (x + y);
}

/**
 * Sample from a Gamma(shape, 1) distribution using Marsaglia and Tsang's method.
 */
function sampleGamma(shape: number, rng: () => number): number {
  if (shape < 1) {
    // Boost: Gamma(shape) = Gamma(shape+1) * U^(1/shape)
    return sampleGamma(shape + 1, rng) * Math.pow(rng(), 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  while (true) {
    let x: number;
    let v: number;
    do {
      // Box-Muller for normal sample
      x = Math.sqrt(-2 * Math.log(rng())) * Math.cos(2 * Math.PI * rng());
      v = 1 + c * x;
    } while (v <= 0);

    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

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
  const priorsTotal = relayPriors ? relayPriors.size : 0;

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

      const score = (1 + Math.log(weight)) * sample;
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

  return {
    name: "Welshman+Thompson",
    relayAssignments,
    pubkeyAssignments,
    orphanedPubkeys,
    params,
    executionTimeMs: performance.now() - start,
    notes,
  };
}
