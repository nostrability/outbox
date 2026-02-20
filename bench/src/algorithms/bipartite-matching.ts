import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
} from "../types.ts";

/**
 * Weighted Bipartite b-Matching.
 *
 * Models relay selection as a bipartite matching problem where:
 * - Left nodes = pubkeys, right nodes = relays
 * - Edge weight = 1 / |declared_relays(pubkey)| (prioritizes hard-to-reach pubkeys)
 * - Each relay has capacity (max pubkeys it can serve)
 * - Each pubkey needs at least 1 relay assignment
 *
 * Selects k relays that maximize weighted coverage, with weights favoring
 * pubkeys that have fewer relay options (inverse frequency weighting).
 *
 * This is solved greedily on the weighted graph, but the weighting scheme
 * produces fundamentally different results than standard coverage maximization.
 */
export function bipartiteMatching(
  input: BenchmarkInput,
  params: AlgorithmParams,
  _rng: () => number,
): AlgorithmResult {
  const start = performance.now();
  const maxConnections = params.maxConnections ?? 20;

  const followSet = new Set<Pubkey>(input.follows);

  // Compute inverse-frequency weights for each pubkey
  // Pubkeys with fewer declared relays get higher weight
  const pubkeyWeight = new Map<Pubkey, number>();
  for (const pubkey of input.follows) {
    const relays = input.writerToRelays.get(pubkey);
    if (relays && relays.size > 0) {
      pubkeyWeight.set(pubkey, 1.0 / relays.size);
    }
  }

  // Build weighted relay scores
  // A relay's score = sum of weights of pubkeys it covers
  interface RelayScore {
    url: RelayUrl;
    pubkeys: Set<Pubkey>;
    weightedScore: number;
  }

  const relayScores: RelayScore[] = [];
  for (const [relay, writers] of input.relayToWriters) {
    const relevant = new Set<Pubkey>();
    let score = 0;
    for (const w of writers) {
      if (followSet.has(w) && pubkeyWeight.has(w)) {
        relevant.add(w);
        score += pubkeyWeight.get(w)!;
      }
    }
    if (relevant.size > 0) {
      relayScores.push({ url: relay, pubkeys: relevant, weightedScore: score });
    }
  }

  const k = Math.min(maxConnections, relayScores.length);

  // Iterative weighted greedy: pick relay with highest marginal weighted score
  const selectedRelays: RelayScore[] = [];
  const covered = new Set<Pubkey>();
  const used = new Set<RelayUrl>();

  for (let step = 0; step < k; step++) {
    let bestRelay: RelayScore | null = null;
    let bestMarginalWeight = 0;

    for (const rs of relayScores) {
      if (used.has(rs.url)) continue;

      // Marginal weighted score = sum of weights of UNCOVERED pubkeys this relay covers
      let marginalWeight = 0;
      for (const p of rs.pubkeys) {
        if (!covered.has(p)) {
          marginalWeight += pubkeyWeight.get(p)!;
        }
      }

      if (
        marginalWeight > bestMarginalWeight ||
        (marginalWeight === bestMarginalWeight &&
          (!bestRelay || rs.url < bestRelay.url))
      ) {
        bestMarginalWeight = marginalWeight;
        bestRelay = rs;
      }
    }

    if (!bestRelay || bestMarginalWeight === 0) break;

    selectedRelays.push(bestRelay);
    used.add(bestRelay.url);
    for (const p of bestRelay.pubkeys) covered.add(p);
  }

  // Build result
  const relayAssignments = new Map<RelayUrl, Set<Pubkey>>();
  const pubkeyAssignments = new Map<Pubkey, Set<RelayUrl>>();
  const orphanedPubkeys = new Set<Pubkey>();

  for (const rs of selectedRelays) {
    relayAssignments.set(rs.url, new Set(rs.pubkeys));
    for (const p of rs.pubkeys) {
      const existing = pubkeyAssignments.get(p) ?? new Set<RelayUrl>();
      existing.add(rs.url);
      pubkeyAssignments.set(p, existing);
    }
  }

  for (const pubkey of input.follows) {
    if (!pubkeyAssignments.has(pubkey)) {
      orphanedPubkeys.add(pubkey);
    }
  }

  return {
    name: "Bipartite Matching",
    relayAssignments,
    pubkeyAssignments,
    orphanedPubkeys,
    params,
    executionTimeMs: performance.now() - start,
    notes: [
      `Inverse-frequency weighted: prioritizes hard-to-reach pubkeys`,
      `Coverage: ${covered.size}/${pubkeyWeight.size}`,
    ],
  };
}
