/**
 * NIP-66 RTT vs measured latency correlation analysis.
 *
 * Pairs NIP-66 monitor RTT data with actual relay outcomes from Phase 2,
 * computing Spearman rank correlation, Top-K overlap, and bias metrics.
 */

import type { RelayOutcome } from "../relay-pool.ts";
import type {
  LatencyCorrelationStats,
  Nip66CorrelationResult,
  Nip66RelayData,
  RelayUrl,
} from "../types.ts";
import { meanOf, median, toSortedNumericArray } from "../types.ts";

interface PairedRelay {
  url: RelayUrl;
  nip66Ms: number;
  measuredMs: number;
}

/** Assign fractional ranks (average of tied positions). */
function fractionalRanks(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);

  const ranks = new Array<number>(values.length);
  let pos = 0;
  while (pos < indexed.length) {
    let end = pos + 1;
    while (end < indexed.length && indexed[end].v === indexed[pos].v) end++;
    const avgRank = (pos + end - 1) / 2 + 1; // 1-based average
    for (let k = pos; k < end; k++) ranks[indexed[k].i] = avgRank;
    pos = end;
  }
  return ranks;
}

/** Spearman rank correlation: Pearson r on fractional ranks. */
function spearmanCorrelation(a: number[], b: number[]): number | null {
  if (a.length < 5) return null;
  const rankA = fractionalRanks(a);
  const rankB = fractionalRanks(b);

  const meanA = meanOf(rankA);
  const meanB = meanOf(rankB);

  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < rankA.length; i++) {
    const da = rankA[i] - meanA;
    const db = rankB[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den === 0 ? null : num / den;
}

/** Top-K overlap: fraction of fastest K relays that appear in both rankings. */
function topKOverlap(pairs: PairedRelay[], sortKeyNip66: (p: PairedRelay) => number, sortKeyMeasured: (p: PairedRelay) => number, k: number): number {
  if (pairs.length < k) return 0;
  const byNip66 = [...pairs].sort((a, b) => sortKeyNip66(a) - sortKeyNip66(b));
  const byMeasured = [...pairs].sort((a, b) => sortKeyMeasured(a) - sortKeyMeasured(b));
  const nip66Set = new Set(byNip66.slice(0, k).map((p) => p.url));
  const measuredSet = new Set(byMeasured.slice(0, k).map((p) => p.url));
  let overlap = 0;
  for (const url of nip66Set) {
    if (measuredSet.has(url)) overlap++;
  }
  return overlap / k;
}

function computeStats(
  pairs: PairedRelay[],
): LatencyCorrelationStats {
  const n = pairs.length;
  const nip66Values = pairs.map((p) => p.nip66Ms);
  const measuredValues = pairs.map((p) => p.measuredMs);

  const spearmanR = spearmanCorrelation(nip66Values, measuredValues);

  // MAE
  const absErrors = pairs.map((p) => Math.abs(p.measuredMs - p.nip66Ms));
  const maeMs = meanOf(absErrors);

  // Median bias ratio (measured / nip66)
  const ratios = pairs
    .filter((p) => p.nip66Ms > 0)
    .map((p) => p.measuredMs / p.nip66Ms);
  const medianRatio = ratios.length > 0
    ? median(toSortedNumericArray(ratios))
    : null;

  // Top-K overlap
  const ks = [5, 10, 20];
  const topKResult: Record<number, number> = {};
  for (const k of ks) {
    topKResult[k] = topKOverlap(
      pairs,
      (p) => p.nip66Ms,
      (p) => p.measuredMs,
      k,
    );
  }

  return { n, spearmanR, maeMs, medianRatio, topKOverlap: topKResult };
}

export function computeNip66Correlation(
  nip66Data: ReadonlyMap<RelayUrl, Nip66RelayData>,
  relayOutcomes: ReadonlyMap<RelayUrl, RelayOutcome>,
): Nip66CorrelationResult {
  // Pair: URL match where NIP-66 has rttOpenMs and outcome is connected
  const openPairs: PairedRelay[] = [];
  const readPairs: PairedRelay[] = [];
  const dataAges: number[] = [];
  const monitors = new Set<string>();
  const now = Math.floor(Date.now() / 1000);

  for (const [url, outcome] of relayOutcomes) {
    if (!outcome.connected) continue;
    const nip66 = nip66Data.get(url);
    if (!nip66) continue;

    monitors.add(nip66.monitorPubkey);
    dataAges.push(now - nip66.lastSeenAt);

    if (nip66.rttOpenMs != null) {
      openPairs.push({ url, nip66Ms: nip66.rttOpenMs, measuredMs: outcome.connectTimeMs });
    }
    if (nip66.rttReadMs != null) {
      readPairs.push({ url, nip66Ms: nip66.rttReadMs, measuredMs: outcome.queryTimeMs });
    }
  }

  const n = Math.max(openPairs.length, readPairs.length);

  const medianDataAgeMinutes = dataAges.length > 0
    ? median(toSortedNumericArray(dataAges)) / 60
    : null;

  return {
    n,
    openVsConnect: computeStats(openPairs),
    readVsQuery: computeStats(readPairs),
    medianDataAgeMinutes,
    monitorPubkeys: [...monitors],
  };
}
