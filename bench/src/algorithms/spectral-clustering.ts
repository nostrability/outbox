import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
} from "../types.ts";

/**
 * Spectral Clustering relay selection.
 *
 * Uses community detection on the pubkey-relay bipartite graph to identify
 * clusters of pubkeys that share relay infrastructure. Selects one
 * representative relay per cluster (highest coverage within the cluster).
 *
 * Uses label propagation for clustering (fast, no eigendecomposition needed)
 * followed by per-cluster relay selection.
 *
 * This exploits graph STRUCTURE rather than just frequency — could identify
 * "bridge" relays connecting otherwise-disconnected pubkey communities.
 */
export function spectralClustering(
  input: BenchmarkInput,
  params: AlgorithmParams,
  rng: () => number,
): AlgorithmResult {
  const start = performance.now();
  const maxConnections = params.maxConnections ?? 20;

  const followSet = new Set<Pubkey>(input.follows);

  // Build relay-relay similarity matrix (Jaccard similarity of pubkey sets)
  interface RelayInfo {
    url: RelayUrl;
    pubkeys: Set<Pubkey>;
  }

  const relayInfos: RelayInfo[] = [];
  for (const [relay, writers] of input.relayToWriters) {
    const relevant = new Set<Pubkey>();
    for (const w of writers) {
      if (followSet.has(w)) relevant.add(w);
    }
    if (relevant.size > 0) {
      relayInfos.push({ url: relay, pubkeys: relevant });
    }
  }

  const n = relayInfos.length;
  const k = Math.min(maxConnections, n);

  if (n <= k) {
    // Fewer relays than budget — use all
    return buildResult(relayInfos, input, params, start);
  }

  // --- Label Propagation Clustering ---
  // Initialize: each relay gets its own label
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i++) labels[i] = i;

  // Build adjacency: two relays are connected if they share pubkeys
  // Weight = number of shared pubkeys
  const adjacency: Map<number, { neighbor: number; weight: number }>[] = [];
  for (let i = 0; i < n; i++) adjacency.push(new Map());

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let shared = 0;
      // Count intersection (iterate smaller set)
      const [smaller, larger] =
        relayInfos[i].pubkeys.size <= relayInfos[j].pubkeys.size
          ? [relayInfos[i].pubkeys, relayInfos[j].pubkeys]
          : [relayInfos[j].pubkeys, relayInfos[i].pubkeys];
      for (const p of smaller) {
        if (larger.has(p)) shared++;
      }
      if (shared > 0) {
        adjacency[i].set(j, { neighbor: j, weight: shared });
        adjacency[j].set(i, { neighbor: i, weight: shared });
      }
    }
  }

  // Iterate label propagation
  const maxIterations = 20;
  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;

    // Process in random order
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    for (const i of order) {
      // Find most popular label among weighted neighbors
      const labelWeights = new Map<number, number>();
      for (const [, edge] of adjacency[i]) {
        const neighborLabel = labels[edge.neighbor];
        labelWeights.set(
          neighborLabel,
          (labelWeights.get(neighborLabel) ?? 0) + edge.weight,
        );
      }

      if (labelWeights.size === 0) continue;

      let bestLabel = labels[i];
      let bestWeight = 0;
      for (const [label, weight] of labelWeights) {
        if (weight > bestWeight || (weight === bestWeight && label < bestLabel)) {
          bestWeight = weight;
          bestLabel = label;
        }
      }

      if (bestLabel !== labels[i]) {
        labels[i] = bestLabel;
        changed = true;
      }
    }

    if (!changed) break;
  }

  // --- Cluster-aware relay selection ---
  // Group relays by cluster label
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const cl = labels[i];
    const existing = clusters.get(cl) ?? [];
    existing.push(i);
    clusters.set(cl, existing);
  }

  // Sort clusters by total coverage (descending)
  const clusterList = [...clusters.entries()].map(([label, members]) => {
    const allPubkeys = new Set<Pubkey>();
    for (const idx of members) {
      for (const p of relayInfos[idx].pubkeys) allPubkeys.add(p);
    }
    return { label, members, totalCoverage: allPubkeys.size };
  });
  clusterList.sort((a, b) => b.totalCoverage - a.totalCoverage);

  // Select relays: one per cluster first (the one with most coverage),
  // then fill remaining budget greedily across all clusters
  const selected: RelayInfo[] = [];
  const usedIndices = new Set<number>();
  const coveredPubkeys = new Set<Pubkey>();

  // Phase 1: one representative per cluster
  for (const cluster of clusterList) {
    if (selected.length >= k) break;

    // Pick relay in cluster with highest marginal coverage
    let bestIdx = -1;
    let bestMarginal = 0;
    for (const idx of cluster.members) {
      let marginal = 0;
      for (const p of relayInfos[idx].pubkeys) {
        if (!coveredPubkeys.has(p)) marginal++;
      }
      if (marginal > bestMarginal) {
        bestMarginal = marginal;
        bestIdx = idx;
      }
    }

    if (bestIdx >= 0 && bestMarginal > 0) {
      selected.push(relayInfos[bestIdx]);
      usedIndices.add(bestIdx);
      for (const p of relayInfos[bestIdx].pubkeys) coveredPubkeys.add(p);
    }
  }

  // Phase 2: fill remaining budget greedily (best marginal from any cluster)
  while (selected.length < k) {
    let bestIdx = -1;
    let bestMarginal = 0;

    for (let i = 0; i < n; i++) {
      if (usedIndices.has(i)) continue;
      let marginal = 0;
      for (const p of relayInfos[i].pubkeys) {
        if (!coveredPubkeys.has(p)) marginal++;
      }
      if (marginal > bestMarginal) {
        bestMarginal = marginal;
        bestIdx = i;
      }
    }

    if (bestIdx < 0 || bestMarginal === 0) break;

    selected.push(relayInfos[bestIdx]);
    usedIndices.add(bestIdx);
    for (const p of relayInfos[bestIdx].pubkeys) coveredPubkeys.add(p);
  }

  return buildResult(selected, input, params, start, [
    `${clusters.size} clusters detected via label propagation`,
    `Phase 1 (per-cluster): ${Math.min(clusterList.length, k)} relays`,
    `Phase 2 (greedy fill): ${selected.length - Math.min(clusterList.length, k)} relays`,
  ]);
}

function buildResult(
  selected: { url: RelayUrl; pubkeys: Set<Pubkey> }[],
  input: BenchmarkInput,
  params: AlgorithmParams,
  startTime: number,
  notes?: string[],
): AlgorithmResult {
  const relayAssignments = new Map<RelayUrl, Set<Pubkey>>();
  const pubkeyAssignments = new Map<Pubkey, Set<RelayUrl>>();
  const orphanedPubkeys = new Set<Pubkey>();
  const covered = new Set<Pubkey>();

  for (const ri of selected) {
    relayAssignments.set(ri.url, new Set(ri.pubkeys));
    for (const p of ri.pubkeys) {
      covered.add(p);
      const existing = pubkeyAssignments.get(p) ?? new Set<RelayUrl>();
      existing.add(ri.url);
      pubkeyAssignments.set(p, existing);
    }
  }

  for (const pubkey of input.follows) {
    if (!covered.has(pubkey)) {
      orphanedPubkeys.add(pubkey);
    }
  }

  return {
    name: "Spectral Clustering",
    relayAssignments,
    pubkeyAssignments,
    orphanedPubkeys,
    params,
    executionTimeMs: performance.now() - startTime,
    notes,
  };
}
