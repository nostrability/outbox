import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
} from "../types.ts";

/**
 * Combinatorial Multi-Armed Bandit (CUCB) relay selection.
 *
 * Treats relay selection as an online learning problem. Starts with no
 * knowledge of the coverage function and learns which relay combinations
 * maximize coverage through exploration (UCB1) and exploitation.
 *
 * In our static benchmark, this simulates an agent that doesn't know
 * the relay-to-pubkey mapping a priori and must discover it.
 *
 * Reference: Chen et al., "Combinatorial Multi-Armed Bandit," ICML 2013.
 */
export function mabRelay(
  input: BenchmarkInput,
  params: AlgorithmParams,
  rng: () => number,
): AlgorithmResult {
  const start = performance.now();
  const maxConnections = params.maxConnections ?? 20;
  const rounds = 500;
  const c = 2.0; // UCB exploration constant

  // Index relays and pubkeys for fast access
  const relayList: RelayUrl[] = [...input.relayToWriters.keys()];
  const n = relayList.length;
  const k = Math.min(maxConnections, n);

  // Early return if no relays to select
  if (k === 0 || n === 0) {
    return {
      name: "MAB-UCB Relay",
      relayAssignments: new Map(),
      pubkeyAssignments: new Map(),
      orphanedPubkeys: new Set(input.follows),
      params,
      executionTimeMs: performance.now() - start,
      notes: ["No relays available"],
    };
  }

  // Follow set for coverage computation
  const followSet = new Set<Pubkey>(input.follows);

  // Precompute coverage sets (the "true" rewards — agent discovers these)
  const relayCoverageIdx = new Map<number, Set<Pubkey>>();
  for (let i = 0; i < n; i++) {
    const writers = input.relayToWriters.get(relayList[i])!;
    const relevant = new Set<Pubkey>();
    for (const w of writers) {
      if (followSet.has(w)) relevant.add(w);
    }
    relayCoverageIdx.set(i, relevant);
  }

  // Total coverable pubkeys (those with relay data)
  let totalCoverable = 0;
  for (const pubkey of input.follows) {
    const relays = input.writerToRelays.get(pubkey);
    if (relays && relays.size > 0) totalCoverable++;
  }

  // Early return if no follows have relay data
  if (totalCoverable === 0) {
    return {
      name: "MAB-UCB Relay",
      relayAssignments: new Map(),
      pubkeyAssignments: new Map(),
      orphanedPubkeys: new Set(input.follows),
      params,
      executionTimeMs: performance.now() - start,
      notes: ["No coverable pubkeys (follow set empty or no relay data)"],
    };
  }

  // UCB statistics per relay
  const pullCount = new Float64Array(n); // times this relay was in selected set
  const totalReward = new Float64Array(n); // cumulative marginal contribution

  // Initialize: pull each relay once (exploration phase)
  // We simulate this by selecting random sets and observing coverage
  const initRounds = Math.min(Math.ceil(n / k), 50);
  for (let r = 0; r < initRounds; r++) {
    // Random selection of k relays
    const indices = Array.from({ length: n }, (_, i) => i);
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(rng() * (indices.length - i));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    const selected = indices.slice(0, k);

    // Compute coverage
    const covered = new Set<Pubkey>();
    for (const idx of selected) {
      for (const p of relayCoverageIdx.get(idx)!) covered.add(p);
    }

    // Compute marginal contribution of each selected relay
    for (const idx of selected) {
      const relayPubkeys = relayCoverageIdx.get(idx)!;
      // Marginal = pubkeys covered ONLY by this relay in this selection
      let marginal = 0;
      for (const p of relayPubkeys) {
        if (!followSet.has(p)) continue;
        // Check if any other selected relay also covers this pubkey
        let coveredByOther = false;
        for (const other of selected) {
          if (other === idx) continue;
          if (relayCoverageIdx.get(other)!.has(p)) {
            coveredByOther = true;
            break;
          }
        }
        if (!coveredByOther) marginal++;
      }
      pullCount[idx]++;
      totalReward[idx] += marginal / totalCoverable; // Normalize to [0,1]
    }
  }

  // Main UCB rounds
  let bestCoverage = 0;
  let bestSelection: number[] = [];

  for (let round = 0; round < rounds; round++) {
    const t = initRounds * k + round + 1;

    // Compute UCB score for each relay
    const ucbScores = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (pullCount[i] === 0) {
        ucbScores[i] = Infinity; // Never tried — must explore
      } else {
        const meanReward = totalReward[i] / pullCount[i];
        const exploration = c * Math.sqrt(Math.log(t) / pullCount[i]);
        ucbScores[i] = meanReward + exploration;
      }
    }

    // Select top-k relays by UCB score
    const indices = Array.from({ length: n }, (_, i) => i);
    indices.sort((a, b) => ucbScores[b] - ucbScores[a]);
    const selected = indices.slice(0, k);

    // Observe coverage (the "reward")
    const covered = new Set<Pubkey>();
    for (const idx of selected) {
      for (const p of relayCoverageIdx.get(idx)!) covered.add(p);
    }
    const coverage = covered.size;

    // Track best
    if (coverage > bestCoverage) {
      bestCoverage = coverage;
      bestSelection = [...selected];
    }

    // Update statistics for selected relays
    for (const idx of selected) {
      const relayPubkeys = relayCoverageIdx.get(idx)!;
      let marginal = 0;
      for (const p of relayPubkeys) {
        if (!followSet.has(p)) continue;
        let coveredByOther = false;
        for (const other of selected) {
          if (other === idx) continue;
          if (relayCoverageIdx.get(other)!.has(p)) {
            coveredByOther = true;
            break;
          }
        }
        if (!coveredByOther) marginal++;
      }
      pullCount[idx]++;
      totalReward[idx] += marginal / totalCoverable;
    }
  }

  // Build result from best selection
  const relayAssignments = new Map<RelayUrl, Set<Pubkey>>();
  const pubkeyAssignments = new Map<Pubkey, Set<RelayUrl>>();
  const orphanedPubkeys = new Set<Pubkey>();
  const coveredPubkeys = new Set<Pubkey>();

  for (const idx of bestSelection) {
    const relay = relayList[idx];
    const pubkeys = new Set<Pubkey>();
    for (const p of relayCoverageIdx.get(idx)!) {
      pubkeys.add(p);
      coveredPubkeys.add(p);
      const existing = pubkeyAssignments.get(p) ?? new Set<RelayUrl>();
      existing.add(relay);
      pubkeyAssignments.set(p, existing);
    }
    relayAssignments.set(relay, pubkeys);
  }

  for (const pubkey of input.follows) {
    if (!coveredPubkeys.has(pubkey)) {
      orphanedPubkeys.add(pubkey);
    }
  }

  return {
    name: "MAB-UCB Relay",
    relayAssignments,
    pubkeyAssignments,
    orphanedPubkeys,
    params,
    executionTimeMs: performance.now() - start,
    notes: [
      `${rounds + initRounds} rounds, exploration c=${c}`,
      `Best coverage: ${bestCoverage}/${totalCoverable}`,
    ],
  };
}
