/**
 * Tier 2 hint-relay probing: query hint relays for uncovered authors
 * and measure the recall delta vs Tier 1 verification.
 *
 * Fully isolated — does not modify Phase 2 types, run, verify, or report.
 */

import { RelayPool, QueryCache } from "../relay-pool.ts";
import type { HintMap } from "../hint-enrichment.ts";
import type {
  AlgorithmResult,
  AlgorithmVerification,
  PubkeyBaseline,
  Pubkey,
  RelayUrl,
} from "../types.ts";

const MAX_HINT_RELAYS_PER_AUTHOR = 2;

interface HintProbeResult {
  uncoveredAuthors: number;
  authorsWithHints: number;
  authorsRecovered: number;
  supplementaryRelaysQueried: number;
  eventsFound: number;
  perAlgorithm: {
    name: string;
    tier1EvtRecall: number;
    combinedEvtRecall: number;
    tier1AuthRecall: number;
    combinedAuthRecall: number;
  }[];
}

/**
 * After Phase 2 Tier 1, probe hint relays for uncovered authors and
 * report combined recall.
 */
export async function probeHintRelays(
  baselines: Map<Pubkey, PubkeyBaseline>,
  cache: QueryCache,
  algorithmResults: AlgorithmResult[],
  algorithmVerifications: AlgorithmVerification[],
  hintMap: HintMap,
  options: { kinds: number[]; windowSeconds: number; maxConcurrentConns: number },
): Promise<HintProbeResult> {
  // 1. Identify testable-reliable authors
  const reliableAuthors: Pubkey[] = [];
  for (const [pubkey, baseline] of baselines) {
    if (baseline.classification === "testable-reliable") {
      reliableAuthors.push(pubkey);
    }
  }

  if (reliableAuthors.length === 0) {
    console.log("\n=== Hint Tier 2: No testable-reliable authors — skipping ===");
    return {
      uncoveredAuthors: 0, authorsWithHints: 0, authorsRecovered: 0,
      supplementaryRelaysQueried: 0, eventsFound: 0, perAlgorithm: [],
    };
  }

  // 2. For each algorithm, find uncovered authors (0 events found through assigned relays)
  //    Union across algorithms to get the full set of authors to probe
  const uncoveredByAlgo = new Map<number, Set<Pubkey>>(); // algoIdx → set
  const allUncovered = new Set<Pubkey>();

  for (let i = 0; i < algorithmResults.length; i++) {
    const result = algorithmResults[i];
    const uncovered = new Set<Pubkey>();

    for (const pubkey of reliableAuthors) {
      const baseline = baselines.get(pubkey)!;
      const assigned = result.pubkeyAssignments.get(pubkey);

      if (!assigned || assigned.size === 0) {
        // Orphaned — no assigned relays
        uncovered.add(pubkey);
        continue;
      }

      // Check if any events were found through assigned relays
      let foundAny = false;
      for (const relay of assigned) {
        const ids = cache.get(relay, pubkey);
        if (ids && ids.size > 0) {
          // Intersect with baseline
          for (const id of ids) {
            if (baseline.eventIds.has(id)) {
              foundAny = true;
              break;
            }
          }
          if (foundAny) break;
        }
      }

      if (!foundAny) {
        uncovered.add(pubkey);
      }
    }

    uncoveredByAlgo.set(i, uncovered);
    for (const pk of uncovered) allUncovered.add(pk);
  }

  // 3. For each uncovered author, pick top hint relays not already queried in baseline
  const probeTargets = new Map<RelayUrl, Set<Pubkey>>(); // relay → pubkeys to query
  let authorsWithHints = 0;

  for (const pubkey of allUncovered) {
    const hints = hintMap.get(pubkey);
    if (!hints || hints.size === 0) continue;

    // Relays already in the baseline (already queried)
    const baseline = baselines.get(pubkey)!;
    const alreadyQueried = new Set<RelayUrl>([
      ...baseline.relaysSucceeded,
      ...baseline.relaysFailed,
    ]);

    // Sort hints by count descending, take top N not already queried
    const candidates = [...hints.entries()]
      .filter(([url]) => !alreadyQueried.has(url))
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_HINT_RELAYS_PER_AUTHOR);

    if (candidates.length === 0) continue;
    authorsWithHints++;

    for (const [relayUrl] of candidates) {
      const pubkeys = probeTargets.get(relayUrl) ?? new Set();
      pubkeys.add(pubkey);
      probeTargets.set(relayUrl, pubkeys);
    }
  }

  if (probeTargets.size === 0) {
    console.log(`\n=== Hint Tier 2: ${allUncovered.size} uncovered authors but no new hint relays to probe ===`);
    return {
      uncoveredAuthors: allUncovered.size, authorsWithHints: 0, authorsRecovered: 0,
      supplementaryRelaysQueried: 0, eventsFound: 0, perAlgorithm: [],
    };
  }

  // 4. Query hint relays
  console.error(`\n=== Hint Tier 2: Probing ===`);
  console.error(`Uncovered authors: ${allUncovered.size} | With hints: ${authorsWithHints} | Hint relays: ${probeTargets.size}`);

  const pool = new RelayPool({
    maxConcurrent: options.maxConcurrentConns,
    maxOpenSockets: options.maxConcurrentConns + 10,
    connectTimeoutMs: 10000,
    eoseTimeoutMs: 15000,
  });
  const probeCache = new QueryCache();
  const since = Math.floor(Date.now() / 1000) - options.windowSeconds;

  const tasks = [...probeTargets.entries()].map(async ([relay, pubkeys]) => {
    await pool.queryBatched(
      relay,
      [...pubkeys],
      { kinds: options.kinds, since },
      50,
      probeCache,
    );
  });
  await Promise.all(tasks);
  pool.closeAll();

  // 5. Compute per-algorithm combined recall
  let totalEventsFound = 0;
  let totalAuthorsRecovered = 0;
  const perAlgorithm: HintProbeResult["perAlgorithm"] = [];

  for (let i = 0; i < algorithmResults.length; i++) {
    const result = algorithmResults[i];
    const verification = algorithmVerifications[i];
    const uncovered = uncoveredByAlgo.get(i)!;

    let tier2Found = 0;
    let authorsRecovered = 0;

    for (const pubkey of uncovered) {
      const baseline = baselines.get(pubkey)!;
      if (baseline.eventIds.size === 0) continue;

      // Collect events from hint relays for this pubkey
      const hintRelays = [...(probeTargets.keys())].filter(
        (relay) => probeTargets.get(relay)!.has(pubkey),
      );
      const foundIds = new Set<string>();
      for (const relay of hintRelays) {
        const ids = probeCache.get(relay, pubkey);
        if (ids) {
          for (const id of ids) {
            if (baseline.eventIds.has(id)) foundIds.add(id);
          }
        }
      }

      if (foundIds.size > 0) {
        tier2Found += foundIds.size;
        authorsRecovered++;
      }
    }

    const totalBaseline = verification.totalBaselineEventsReliable;
    const tier1Found = verification.totalFoundEventsReliable;
    const combinedFound = tier1Found + tier2Found;

    const tier1AuthRecall = verification.authorRecallRate;
    const combinedAuthRecall = reliableAuthors.length > 0
      ? (verification.authorsWithEvents + authorsRecovered) / reliableAuthors.length
      : 0;

    perAlgorithm.push({
      name: result.name,
      tier1EvtRecall: totalBaseline > 0 ? tier1Found / totalBaseline : 0,
      combinedEvtRecall: totalBaseline > 0 ? combinedFound / totalBaseline : 0,
      tier1AuthRecall,
      combinedAuthRecall,
    });

    totalEventsFound += tier2Found;
    if (i === 0) totalAuthorsRecovered = authorsRecovered;
  }

  // 6. Print results
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  console.log(`\n=== Hint Tier 2: Combined Recall ===`);
  console.log(`Uncovered authors: ${allUncovered.size} | With hints: ${authorsWithHints} | Relays probed: ${probeTargets.size}`);
  console.log(`Events found in Tier 2: ${totalEventsFound} | Authors recovered: ${totalAuthorsRecovered}`);
  console.log("");

  const headers = ["Algorithm", "T1 EvtR", "T1+T2 EvtR", "T1 AuthR", "T1+T2 AuthR"];
  const widths = [32, 10, 12, 10, 12];
  const pad = (s: string, w: number, left = false) => left ? s.padEnd(w) : s.padStart(w);
  const headerRow = headers.map((h, i) => pad(h, widths[i], i === 0)).join(" | ");
  const separator = widths.map((w) => "-".repeat(w)).join("-+-");

  console.log(`  ${headerRow}`);
  console.log(`  ${separator}`);

  for (const alg of perAlgorithm) {
    const row = [
      pad(alg.name, widths[0], true),
      pad(pct(alg.tier1EvtRecall), widths[1]),
      pad(pct(alg.combinedEvtRecall), widths[2]),
      pad(pct(alg.tier1AuthRecall), widths[3]),
      pad(pct(alg.combinedAuthRecall), widths[4]),
    ].join(" | ");
    console.log(`  ${row}`);
  }

  return {
    uncoveredAuthors: allUncovered.size,
    authorsWithHints,
    authorsRecovered: totalAuthorsRecovered,
    supplementaryRelaysQueried: probeTargets.size,
    eventsFound: totalEventsFound,
    perAlgorithm,
  };
}
