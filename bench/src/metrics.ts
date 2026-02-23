import type {
  AlgorithmMetrics,
  AlgorithmParams,
  AlgorithmResult,
  BenchmarkInput,
  Distribution,
} from "./types.ts";
import {
  meanOf,
  median,
  percentile,
  toSortedNumericArray,
} from "./types.ts";

/**
 * Compute all metrics for an algorithm result.
 */
export function computeMetrics(
  result: AlgorithmResult,
  input: BenchmarkInput,
  params: AlgorithmParams,
): AlgorithmMetrics {
  const totalFollows = input.follows.length;
  const coveredPubkeys = result.pubkeyAssignments.size;

  // Structural orphans: no relay list OR all URLs filtered out
  const structuralOrphans = input.followsMissingRelayList.length;

  // Algorithm orphans: had relay data but algorithm didn't select any
  const algorithmOrphans = totalFollows - coveredPubkeys - structuralOrphans;

  // Assignment coverage
  const assignmentCoverage =
    totalFollows > 0 ? coveredPubkeys / totalFollows : 0;

  // Relay counts per pubkey
  const relayCountsPerPubkey: number[] = [];
  for (const [, relays] of result.pubkeyAssignments) {
    relayCountsPerPubkey.push(relays.size);
  }
  const sortedRelayCounts = toSortedNumericArray(relayCountsPerPubkey);

  const avgRelaysPerPubkey = meanOf(relayCountsPerPubkey);
  const medianRelaysPerPubkey = median(sortedRelayCounts);

  // Pubkeys per relay
  const relayLoads: number[] = [];
  for (const [, pubkeys] of result.relayAssignments) {
    relayLoads.push(pubkeys.size);
  }
  const pubkeysPerRelay = meanOf(relayLoads);

  // Relay count distribution
  const pubkeyRelayCountDistribution: Record<number, number> = {};
  for (const count of relayCountsPerPubkey) {
    pubkeyRelayCountDistribution[count] =
      (pubkeyRelayCountDistribution[count] ?? 0) + 1;
  }

  // Relay load distribution
  const sortedLoads = toSortedNumericArray(relayLoads);
  const relayLoadDistribution: Distribution = {
    min: sortedLoads[0] ?? 0,
    max: sortedLoads[sortedLoads.length - 1] ?? 0,
    mean: meanOf(relayLoads),
    median: median(sortedLoads),
    p90: percentile(sortedLoads, 0.9),
    p99: percentile(sortedLoads, 0.99),
  };

  // Target attainment rate (Regime B)
  const target =
    params.relayGoalPerAuthor ??
    params.maxRelaysPerUser ??
    params.relayLimit ??
    params.writeLimit ??
    2;
  let attained = 0;
  for (const [, relays] of result.pubkeyAssignments) {
    if (relays.size >= target) attained++;
  }
  const targetAttainmentRate =
    coveredPubkeys > 0 ? attained / coveredPubkeys : 0;

  // Concentration metrics
  const { top1RelayShare, top5RelayShare, hhi, gini } = computeConcentration(
    result,
    coveredPubkeys,
  );

  return {
    name: result.name,
    totalRelaysSelected: result.relayAssignments.size,
    assignmentCoverage,
    coveredPubkeys,
    orphanedPubkeys: result.orphanedPubkeys.size,
    structuralOrphans,
    algorithmOrphans,
    avgRelaysPerPubkey,
    medianRelaysPerPubkey,
    pubkeysPerRelay,
    pubkeyRelayCountDistribution,
    relayLoadDistribution,
    targetAttainmentRate,
    top1RelayShare,
    top5RelayShare,
    hhi,
    gini,
    executionTimeMs: result.executionTimeMs,
  };
}

function computeConcentration(
  result: AlgorithmResult,
  coveredPubkeys: number,
): {
  top1RelayShare: number;
  top5RelayShare: number;
  hhi: number;
  gini: number;
} {
  if (coveredPubkeys === 0 || result.relayAssignments.size === 0) {
    return { top1RelayShare: 0, top5RelayShare: 0, hhi: 0, gini: 0 };
  }

  // Sort relays by load descending, tie-break URL ascending
  const sorted = [...result.relayAssignments.entries()].sort((a, b) => {
    if (a[1].size !== b[1].size) return b[1].size - a[1].size;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });

  // Top-1 relay share: unique pubkeys on top relay / covered pubkeys
  const top1Pubkeys = sorted[0]?.[1].size ?? 0;
  const top1RelayShare = top1Pubkeys / coveredPubkeys;

  // Top-5 relay share: set union of pubkeys on top-5 relays / covered pubkeys
  const top5Union = new Set<string>();
  for (let i = 0; i < Math.min(5, sorted.length); i++) {
    for (const pubkey of sorted[i][1]) {
      top5Union.add(pubkey);
    }
  }
  const top5RelayShare = top5Union.size / coveredPubkeys;

  // HHI: sum((load_i / total_edges)^2)
  const loads = sorted.map(([, pubkeys]) => pubkeys.size);
  const totalEdges = loads.reduce((sum, l) => sum + l, 0);
  let hhi = 0;
  for (const load of loads) {
    const share = load / totalEdges;
    hhi += share * share;
  }

  // Gini coefficient over relay loads
  const gini = computeGini(loads);

  return { top1RelayShare, top5RelayShare, hhi, gini };
}

function computeGini(values: number[]): number {
  if (values.length <= 1) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const total = sorted.reduce((sum, v) => sum + v, 0);
  if (total === 0) return 0;

  let sumOfDiffs = 0;
  for (let i = 0; i < n; i++) {
    sumOfDiffs += (2 * (i + 1) - n - 1) * sorted[i];
  }

  return sumOfDiffs / (n * total);
}
