import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
} from "../types.ts";
import { sampleBeta } from "./beta.ts";

/**
 * Greedy Set-Cover + Thompson Sampling
 *
 * Same iterative structure as greedy-set-cover: at each step, pick the relay
 * that maximizes a score, repeat until maxConnections or full coverage.
 *
 * Key difference: score = coveredCount × sampleBeta(prior.alpha, prior.beta).
 * Thompson priors let the algorithm sometimes prefer a relay with fewer
 * uncovered pubkeys if that relay has a strong delivery track record.
 *
 * Cold start (no priors): sampleBeta(1, 1) = uniform random multiplier,
 * making this a stochastic greedy (coverage × U(0,1)).
 */
export function greedyThompson(
  input: BenchmarkInput,
  params: AlgorithmParams,
  rng: () => number,
): AlgorithmResult {
  const start = performance.now();
  const maxConnections = params.maxConnections ?? 20;
  const maxRelaysPerUser = params.maxRelaysPerUser ?? Infinity;
  const relayPriors = params.relayPriors;

  const relayAssignments = new Map<RelayUrl, Set<Pubkey>>();
  const pubkeyAssignments = new Map<Pubkey, Set<RelayUrl>>();
  const orphanedPubkeys = new Set<Pubkey>();

  let priorsUsed = 0;
  const priorsTotal = relayPriors ? relayPriors.size : 0;

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
    // Score each candidate relay: coveredCount × Thompson sample
    let bestRelay: RelayUrl | null = null;
    let bestScore = -1;

    const relays = [...relayCoverage.keys()].sort();

    for (const relay of relays) {
      const covered = relayCoverage.get(relay)!;
      if (covered.size === 0) continue;

      const prior = relayPriors?.get(relay);
      const sample = prior
        ? sampleBeta(prior.alpha, prior.beta, rng)
        : sampleBeta(1, 1, rng);

      if (prior) priorsUsed++;

      const score = covered.size * sample;

      if (score > bestScore || (score === bestScore && (!bestRelay || relay < bestRelay))) {
        bestScore = score;
        bestRelay = relay;
      }
    }

    if (!bestRelay || bestScore <= 0) break;

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

      // Remove from uncovered if reached maxRelaysPerUser
      if (count >= maxRelaysPerUser) {
        uncovered.delete(pubkey);
      }
    }

    relayAssignments.set(bestRelay, assignedPubkeys);
    selectedCount++;

    // Remove covered pubkeys that hit their limit from all relay coverage sets
    relayCoverage.delete(bestRelay);
    for (const [_relay, covered] of relayCoverage) {
      for (const pubkey of assignedPubkeys) {
        if ((pubkeyRelayCount.get(pubkey) ?? 0) >= maxRelaysPerUser) {
          covered.delete(pubkey);
        }
      }
      if (covered.size === 0) relayCoverage.delete(_relay);
    }
  }

  // Any still-uncovered pubkeys that had relay data are algorithm orphans
  for (const pubkey of uncovered) {
    if (!pubkeyAssignments.has(pubkey)) {
      orphanedPubkeys.add(pubkey);
    }
  }

  const notes: string[] = [];
  if (relayPriors && relayPriors.size > 0) {
    notes.push(`Greedy+Thompson: ${priorsTotal} relay priors loaded, ${priorsUsed} prior lookups used`);
  } else {
    notes.push("Greedy+Thompson: cold start (uniform priors)");
  }

  return {
    name: "Greedy+Thompson",
    relayAssignments,
    pubkeyAssignments,
    orphanedPubkeys,
    params,
    executionTimeMs: performance.now() - start,
    notes,
  };
}
