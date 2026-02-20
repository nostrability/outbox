/**
 * NIP-66 Weighted Greedy relay selection algorithm.
 *
 * A quality-aware variant of greedy set-cover that uses NIP-66 relay monitor
 * data (liveness, RTT, freshness, NIP support) to break ties and bias
 * selection toward higher-quality relays.
 *
 * Core idea: When two relays cover a similar number of uncovered pubkeys,
 * prefer the one with a higher NIP-66 quality score. This is implemented as
 * a weighted marginal-gain function:
 *
 *   gain(relay) = marginalCoverage * (1 + alpha * nip66Score)
 *
 * where alpha controls how strongly NIP-66 quality influences selection
 * (alpha=0 reduces to plain greedy set-cover).
 *
 * The algorithm fetches NIP-66 data lazily on first run and caches it.
 * If no NIP-66 data is available, it falls back to neutral scores (0.5)
 * for all relays, making it equivalent to standard greedy set-cover.
 */

import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Nip66RelayData,
  Nip66RelayScore,
  Pubkey,
  RelayUrl,
} from "../types.ts";
import { scoreAllRelays } from "../nip66/score.ts";
import { fetchNip66Data, generateSyntheticData } from "../nip66/fetch.ts";

/**
 * Module-level NIP-66 data cache. Populated on first algorithm invocation.
 * This avoids re-fetching on every algorithm call during a benchmark sweep.
 */
let cachedNip66Data: Map<RelayUrl, Nip66RelayData> | null = null;
let cacheInitialized = false;

/**
 * Pre-load NIP-66 data. Call this before running the algorithm to avoid
 * async operations inside the synchronous algorithm function.
 */
export async function initNip66Data(
  candidateRelays?: Iterable<RelayUrl>,
): Promise<void> {
  if (cacheInitialized) return;
  try {
    cachedNip66Data = await fetchNip66Data(candidateRelays);
  } catch (err) {
    console.error(`[nip66-algo] Failed to fetch NIP-66 data: ${err}`);
    cachedNip66Data = null;
  }
  cacheInitialized = true;
}

/**
 * Reset the module-level cache (useful for testing).
 */
export function resetNip66Cache(): void {
  cachedNip66Data = null;
  cacheInitialized = false;
}

/**
 * NIP-66 Weighted Greedy algorithm.
 *
 * @param input - Benchmark input with relay-to-writer mappings
 * @param params - Algorithm parameters (maxConnections, maxRelaysPerUser)
 * @param _rng - Random number generator (unused; algorithm is deterministic)
 */
export function nip66WeightedGreedy(
  input: BenchmarkInput,
  params: AlgorithmParams,
  _rng: () => number,
): AlgorithmResult {
  const start = performance.now();
  const maxConnections = params.maxConnections ?? 20;
  const maxRelaysPerUser = params.maxRelaysPerUser ?? Infinity;

  // Alpha controls quality influence: 0 = pure coverage, 1 = strong quality bias
  const alpha = 0.5;

  const relayAssignments = new Map<RelayUrl, Set<Pubkey>>();
  const pubkeyAssignments = new Map<Pubkey, Set<RelayUrl>>();
  const orphanedPubkeys = new Set<Pubkey>();

  // Get NIP-66 data (from module cache or generate synthetic)
  const nip66Data = cachedNip66Data ?? generateSyntheticData(input.relayToWriters.keys());

  // Score all candidate relays
  const allRelayUrls = [...input.relayToWriters.keys()];
  const scores = scoreAllRelays(allRelayUrls, nip66Data);

  // Collect notes about the data source for reporting
  const notes: string[] = [];
  if (!cachedNip66Data || cachedNip66Data.size === 0) {
    notes.push("NIP-66 data: synthetic (no live data available)");
  } else {
    const sourceTypes = new Set<string>();
    for (const entry of cachedNip66Data.values()) {
      sourceTypes.add(entry.monitorPubkey === "http-api" ? "http-api" :
                      entry.monitorPubkey === "synthetic" ? "synthetic" : "nostr");
    }
    const overlap = allRelayUrls.filter((r) => cachedNip66Data!.has(r)).length;
    notes.push(
      `NIP-66 data: ${cachedNip66Data.size} relays (source: ${[...sourceTypes].join("+")}), ` +
      `${overlap}/${allRelayUrls.length} candidate relays matched`
    );
  }

  // Score distribution summary
  const scoreValues = [...scores.values()].map((s) => s.score);
  if (scoreValues.length > 0) {
    const avg = scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length;
    const min = Math.min(...scoreValues);
    const max = Math.max(...scoreValues);
    notes.push(
      `Quality scores: avg=${avg.toFixed(3)}, min=${min.toFixed(3)}, max=${max.toFixed(3)}, alpha=${alpha}`
    );
  }

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
    // Find relay with best quality-weighted marginal coverage
    let bestRelay: RelayUrl | null = null;
    let bestGain = -1;

    // Sort relays for deterministic iteration
    const relays = [...relayCoverage.keys()].sort();

    for (const relay of relays) {
      const covered = relayCoverage.get(relay)!;
      const marginal = covered.size;
      if (marginal === 0) continue;

      // Quality-weighted gain
      const qualityScore = scores.get(relay)?.score ?? 0.5;
      const gain = marginal * (1 + alpha * qualityScore);

      if (
        gain > bestGain ||
        (gain === bestGain && (!bestRelay || relay < bestRelay))
      ) {
        bestGain = gain;
        bestRelay = relay;
      }
    }

    if (!bestRelay || bestGain <= 0) break;

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
    for (const [relay, covered] of relayCoverage) {
      for (const pubkey of assignedPubkeys) {
        if ((pubkeyRelayCount.get(pubkey) ?? 0) >= maxRelaysPerUser) {
          covered.delete(pubkey);
        }
      }
      if (covered.size === 0) relayCoverage.delete(relay);
    }
  }

  // Any still-uncovered pubkeys that had relay data are algorithm orphans
  for (const pubkey of uncovered) {
    if (!pubkeyAssignments.has(pubkey)) {
      orphanedPubkeys.add(pubkey);
    }
  }

  return {
    name: "NIP-66 Weighted Greedy",
    relayAssignments,
    pubkeyAssignments,
    orphanedPubkeys,
    params,
    executionTimeMs: performance.now() - start,
    notes,
  };
}
