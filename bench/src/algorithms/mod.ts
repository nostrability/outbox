import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
  RelaySelectionAlgorithm,
  StochasticStats,
  AlgorithmMetrics,
} from "../types.ts";
import { meanOf, stddev } from "../types.ts";
import { mulberry32 } from "../seed.ts";
import { computeMetrics } from "../metrics.ts";

import { greedySetCover } from "./greedy-set-cover.ts";
import { priorityBased } from "./priority-based.ts";
import { weightedStochastic } from "./weighted-stochastic.ts";
import { greedyCoverageSort } from "./greedy-coverage-sort.ts";
import { filterDecomposition } from "./filter-decomposition.ts";
import { directMapping } from "./direct-mapping.ts";
import { primalBaseline } from "./primal-baseline.ts";
import { popularPlusRandom } from "./popular-plus-random.ts";
import { ilpOptimal } from "./ilp-optimal.ts";
import { stochasticGreedy } from "./stochastic-greedy.ts";
import { mabRelay } from "./mab-relay.ts";
import { streamingCoverage } from "./streaming-coverage.ts";
import { bipartiteMatching } from "./bipartite-matching.ts";
import { spectralClustering } from "./spectral-clustering.ts";
import { hybridGreedyExplore } from "./hybrid-greedy-explore.ts";

export interface AlgorithmEntry {
  id: string;
  name: string;
  fn: RelaySelectionAlgorithm;
  /** Whether this algorithm uses a native connection cap */
  nativeCap: boolean;
  /** Whether this algorithm is stochastic */
  stochastic: boolean;
  /** Default params for this algorithm */
  defaults: AlgorithmParams;
}

export const ALGORITHM_REGISTRY: AlgorithmEntry[] = [
  {
    id: "greedy",
    name: "Greedy Set-Cover",
    fn: greedySetCover,
    nativeCap: true,
    stochastic: false,
    defaults: { maxConnections: 20, maxRelaysPerUser: 2 },
  },
  {
    id: "ndk",
    name: "Priority-Based (NDK)",
    fn: priorityBased,
    nativeCap: true,
    stochastic: false,
    defaults: { maxRelaysPerUser: 2 },
  },
  {
    id: "welshman",
    name: "Weighted Stochastic",
    fn: weightedStochastic,
    nativeCap: false,
    stochastic: true,
    defaults: { relayLimit: 3 },
  },
  {
    id: "nostur",
    name: "Greedy Coverage Sort",
    fn: greedyCoverageSort,
    nativeCap: true,
    stochastic: false,
    defaults: { maxRelaysPerUser: 2 },
  },
  {
    id: "rust-nostr",
    name: "Filter Decomposition",
    fn: filterDecomposition,
    nativeCap: false,
    stochastic: false,
    defaults: { writeLimit: 3 },
  },
  {
    id: "direct",
    name: "Direct Mapping",
    fn: directMapping,
    nativeCap: false,
    stochastic: false,
    defaults: {},
  },
  {
    id: "primal",
    name: "Primal Aggregator",
    fn: primalBaseline,
    nativeCap: true,
    stochastic: false,
    defaults: {},
  },
  {
    id: "popular-random",
    name: "Popular+Random",
    fn: popularPlusRandom,
    nativeCap: false,
    stochastic: false,
    defaults: {},
  },
  {
    id: "ilp",
    name: "ILP Optimal",
    fn: ilpOptimal,
    nativeCap: true,
    stochastic: false,
    defaults: {},
  },
  {
    id: "stochastic-greedy",
    name: "Stochastic Greedy",
    fn: stochasticGreedy,
    nativeCap: true,
    stochastic: true,
    defaults: {},
  },
  {
    id: "mab",
    name: "MAB-UCB Relay",
    fn: mabRelay,
    nativeCap: true,
    stochastic: true,
    defaults: {},
  },
  {
    id: "streaming",
    name: "Streaming Coverage",
    fn: streamingCoverage,
    nativeCap: true,
    stochastic: true,
    defaults: {},
  },
  {
    id: "matching",
    name: "Bipartite Matching",
    fn: bipartiteMatching,
    nativeCap: true,
    stochastic: false,
    defaults: {},
  },
  {
    id: "spectral",
    name: "Spectral Clustering",
    fn: spectralClustering,
    nativeCap: true,
    stochastic: true,
    defaults: {},
  },
  {
    id: "hybrid",
    name: "Hybrid Greedy+Explore",
    fn: hybridGreedyExplore,
    nativeCap: true,
    stochastic: true,
    defaults: {},
  },
];

export function getAlgorithms(ids: string[]): AlgorithmEntry[] {
  if (ids.includes("all")) return [...ALGORITHM_REGISTRY];
  return ids.map((id) => {
    const entry = ALGORITHM_REGISTRY.find((a) => a.id === id);
    if (!entry) throw new Error(`Unknown algorithm: ${id}`);
    return entry;
  });
}

/**
 * Post-process cap wrapper: takes an uncapped result and caps it to N relays.
 * Sorts relays by assignment edge count descending, tie-break by URL ascending.
 * Takes top N relays and recomputes coverage.
 */
export function postProcessCap(
  result: AlgorithmResult,
  maxConnections: number,
): AlgorithmResult {
  if (result.relayAssignments.size <= maxConnections) return result;

  const start = performance.now();

  // Sort relays by load descending, tie-break URL ascending
  const sorted = [...result.relayAssignments.entries()].sort((a, b) => {
    if (a[1].size !== b[1].size) return b[1].size - a[1].size;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });

  const kept = sorted.slice(0, maxConnections);
  const keptRelays = new Set(kept.map(([url]) => url));

  // Rebuild assignments with only kept relays
  const newRelayAssignments = new Map<RelayUrl, Set<Pubkey>>();
  const newPubkeyAssignments = new Map<Pubkey, Set<RelayUrl>>();

  for (const [relay, pubkeys] of kept) {
    newRelayAssignments.set(relay, new Set(pubkeys));
    for (const pubkey of pubkeys) {
      const existing = newPubkeyAssignments.get(pubkey) ?? new Set<RelayUrl>();
      existing.add(relay);
      newPubkeyAssignments.set(pubkey, existing);
    }
  }

  // Recompute orphans from the original follow set
  const newOrphans = new Set<Pubkey>(result.orphanedPubkeys);
  // Add pubkeys that were covered but are no longer
  for (const [pubkey] of result.pubkeyAssignments) {
    if (!newPubkeyAssignments.has(pubkey)) {
      newOrphans.add(pubkey);
    }
  }

  const cappedName = `${result.name} (cap@${maxConnections})`;

  return {
    name: cappedName,
    relayAssignments: newRelayAssignments,
    pubkeyAssignments: newPubkeyAssignments,
    orphanedPubkeys: newOrphans,
    params: { ...result.params, maxConnections },
    executionTimeMs: result.executionTimeMs + (performance.now() - start),
    notes: [...(result.notes ?? []), `Post-processed: capped from ${result.relayAssignments.size} to ${maxConnections} relays`],
  };
}

/**
 * Run an algorithm with the proper cap strategy:
 * - Native cap algorithms: pass maxConnections directly
 * - Per-pubkey algorithms: run uncapped, then post-process cap
 */
export function runAlgorithm(
  entry: AlgorithmEntry,
  input: BenchmarkInput,
  params: AlgorithmParams,
  rng: () => number,
): AlgorithmResult {
  const mergedParams = { ...entry.defaults, ...params };
  let result = entry.fn(input, mergedParams, rng);

  // Post-process cap for non-native-cap algorithms
  if (
    !entry.nativeCap &&
    mergedParams.maxConnections &&
    mergedParams.maxConnections < Infinity
  ) {
    result = postProcessCap(result, mergedParams.maxConnections);
  }

  return result;
}

/**
 * Run a stochastic algorithm multiple times and compute stats.
 */
export function runStochastic(
  entry: AlgorithmEntry,
  input: BenchmarkInput,
  params: AlgorithmParams,
  seed: number,
  runs: number,
): { result: AlgorithmResult; metrics: AlgorithmMetrics; stochastic: StochasticStats } {
  const allMetrics: AlgorithmMetrics[] = [];
  let bestResult: AlgorithmResult | null = null;

  for (let i = 0; i < runs; i++) {
    const rng = mulberry32(seed + i);
    const result = runAlgorithm(entry, input, params, rng);
    const metrics = computeMetrics(result, input, params);
    allMetrics.push(metrics);
    if (!bestResult) bestResult = result;
  }

  // Compute mean/stddev/CI for numeric fields
  const numericKeys: (keyof AlgorithmMetrics)[] = [
    "totalRelaysSelected",
    "assignmentCoverage",
    "coveredPubkeys",
    "orphanedPubkeys",
    "structuralOrphans",
    "algorithmOrphans",
    "avgRelaysPerPubkey",
    "medianRelaysPerPubkey",
    "pubkeysPerRelay",
    "targetAttainmentRate",
    "top1RelayShare",
    "top5RelayShare",
    "hhi",
    "gini",
    "executionTimeMs",
  ];

  const meanMetrics: Partial<AlgorithmMetrics> = {};
  const stddevMetrics: Partial<AlgorithmMetrics> = {};
  const ci95Lower: Partial<AlgorithmMetrics> = {};
  const ci95Upper: Partial<AlgorithmMetrics> = {};

  for (const key of numericKeys) {
    const values = allMetrics.map((m) => m[key] as number);
    const m = meanOf(values);
    const s = stddev(values);
    const margin = 1.96 * s / Math.sqrt(runs);
    (meanMetrics as Record<string, number>)[key] = m;
    (stddevMetrics as Record<string, number>)[key] = s;
    (ci95Lower as Record<string, number>)[key] = m - margin;
    (ci95Upper as Record<string, number>)[key] = m + margin;
  }

  const stochastic: StochasticStats = {
    runs,
    seed,
    mean: meanMetrics,
    stddev: stddevMetrics,
    ci95: { lower: ci95Lower, upper: ci95Upper },
  };

  // Use mean metrics as the primary result
  const primaryMetrics = computeMetrics(bestResult!, input, params);
  primaryMetrics.stochastic = stochastic;

  // Override with mean values
  for (const key of numericKeys) {
    // deno-lint-ignore no-explicit-any
    (primaryMetrics as any)[key] = (meanMetrics as any)[key];
  }

  return { result: bestResult!, metrics: primaryMetrics, stochastic };
}
