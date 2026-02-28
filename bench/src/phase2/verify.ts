/**
 * Phase 2: Algorithm event verification against baseline.
 *
 * For each algorithm's selected relay set, count how many baseline events
 * are reachable through just those relays. Uses the query cache populated
 * during baseline collection — no additional network calls.
 */

import type { QueryCache, RelayOutcome } from "../relay-pool.ts";
import type {
  AlgorithmResult,
  AlgorithmLatencyStats,
  AlgorithmVerification,
  BenchmarkInput,
  ProfileViewLatencyStats,
  PubkeyBaseline,
  Pubkey,
  RelayUrl,
} from "../types.ts";
import { toSortedNumericArray, median, percentile, meanOf } from "../types.ts";

export function verifyAlgorithm(
  result: AlgorithmResult,
  baselines: Map<Pubkey, PubkeyBaseline>,
  cache: QueryCache,
  allBaselineRelays: Set<RelayUrl>,
  declaredRelays: Set<RelayUrl>,
  relayOutcomes?: ReadonlyMap<RelayUrl, RelayOutcome>,
  eoseTimeoutMs?: number,
  concurrency?: number,
): AlgorithmVerification {
  // Build author sets
  const headlineSet: Pubkey[] = [];
  const partialSet: Pubkey[] = [];

  for (const [pubkey, baseline] of baselines) {
    if (baseline.classification === "testable-reliable") {
      headlineSet.push(pubkey);
    } else if (baseline.classification === "testable-partial") {
      partialSet.push(pubkey);
    }
  }

  const secondarySet = [...headlineSet, ...partialSet];

  // Track out-of-baseline relays
  const outOfBaselineRelays: RelayUrl[] = [];
  for (const relay of result.relayAssignments.keys()) {
    if (!allBaselineRelays.has(relay)) {
      outOfBaselineRelays.push(relay);
    }
  }
  if (outOfBaselineRelays.length > 0) {
    console.error(
      `[verify] ${result.name}: ${outOfBaselineRelays.length} out-of-baseline relays (skipped)`,
    );
  }

  // Compute recall for a given author set
  function computeRecall(authors: Pubkey[]): {
    totalBaseline: number;
    totalFound: number;
    authorsWithEvents: number;
    perAuthorRates: number[];
  } {
    let totalBaseline = 0;
    let totalFound = 0;
    let authorsWithEvents = 0;
    const perAuthorRates: number[] = [];

    for (const pubkey of authors) {
      const baseline = baselines.get(pubkey)!;
      totalBaseline += baseline.eventIds.size;

      // Get assigned relays for this pubkey from this algorithm
      const assignedRelays = result.pubkeyAssignments.get(pubkey);
      if (!assignedRelays || assignedRelays.size === 0) {
        // Not assigned by this algorithm — found = empty
        perAuthorRates.push(0);
        continue;
      }

      // Collect events from assigned relays (excluding out-of-baseline)
      const outSet = new Set(outOfBaselineRelays);
      const foundIds = new Set<string>();
      for (const relay of assignedRelays) {
        if (outSet.has(relay)) continue;
        const ids = cache.get(relay, pubkey);
        if (ids) {
          for (const id of ids) foundIds.add(id);
        }
      }

      // Intersect with baseline
      let intersectionCount = 0;
      for (const id of foundIds) {
        if (baseline.eventIds.has(id)) intersectionCount++;
      }

      totalFound += intersectionCount;
      if (intersectionCount > 0) authorsWithEvents++;
      perAuthorRates.push(
        baseline.eventIds.size > 0 ? intersectionCount / baseline.eventIds.size : 0,
      );
    }

    perAuthorRates.sort((a, b) => a - b);
    return { totalBaseline, totalFound, authorsWithEvents, perAuthorRates };
  }

  const headline = computeRecall(headlineSet);
  const secondary = computeRecall(secondarySet);

  // Selected relay success rate:
  // Only consider declared relays (not extra relays) since only declared relays
  // have success/failure tracked in baseline.relaysSucceeded
  const selectedRelays = new Set(result.relayAssignments.keys());
  const outSet = new Set(outOfBaselineRelays);
  let selectedInBaseline = 0;
  let selectedSucceeded = 0;
  for (const relay of selectedRelays) {
    if (outSet.has(relay)) continue;
    // Only count declared relays to avoid biasing the metric downward
    if (!declaredRelays.has(relay)) continue;
    selectedInBaseline++;
    // A relay "succeeded" if any author's baseline shows it in relaysSucceeded
    let succeeded = false;
    for (const [, baseline] of baselines) {
      if (baseline.relaysSucceeded.has(relay)) {
        succeeded = true;
        break;
      }
    }
    if (succeeded) selectedSucceeded++;
  }

  const selectedRelaySuccessRate = selectedInBaseline > 0
    ? selectedSucceeded / selectedInBaseline
    : null;

  // Compute per-algorithm latency simulation if relay outcomes are available
  let latency: AlgorithmLatencyStats | undefined;
  if (relayOutcomes && relayOutcomes.size > 0) {
    latency = computeAlgorithmLatency(
      result, relayOutcomes, cache, baselines,
      eoseTimeoutMs, concurrency,
    );
  }

  return {
    algorithmName: result.name,
    eventRecallRate: headline.totalBaseline > 0
      ? headline.totalFound / headline.totalBaseline
      : 0,
    authorRecallRate: headlineSet.length > 0
      ? headline.authorsWithEvents / headlineSet.length
      : 0,
    eventRecallIncPartial: secondary.totalBaseline > 0
      ? secondary.totalFound / secondary.totalBaseline
      : 0,
    authorRecallIncPartial: secondarySet.length > 0
      ? secondary.authorsWithEvents / secondarySet.length
      : 0,
    selectedRelaySuccessRate,
    totalBaselineEventsReliable: headline.totalBaseline,
    totalBaselineEventsInclPartial: secondary.totalBaseline,
    totalFoundEventsReliable: headline.totalFound,
    totalFoundEventsInclPartial: secondary.totalFound,
    testableReliableAuthors: headlineSet.length,
    testablePartialAuthors: partialSet.length,
    authorsWithEvents: headline.authorsWithEvents,
    outOfBaselineRelays,
    perAuthorRecallRates: headline.perAuthorRates,
    latency,
  };
}

/**
 * Simulate parallel relay queries for an algorithm's relay set.
 * Uses per-relay timing from baseline collection to estimate what
 * latency would look like if only these relays were queried simultaneously.
 */
function computeAlgorithmLatency(
  result: AlgorithmResult,
  relayOutcomes: ReadonlyMap<RelayUrl, RelayOutcome>,
  cache: QueryCache,
  baselines: Map<Pubkey, PubkeyBaseline>,
  eoseTimeoutMs = 15000,
  concurrency = 20,
): AlgorithmLatencyStats {
  const algRelays = new Set(result.relayAssignments.keys());

  let relaysWithOutcomes = 0;
  let relaysConnected = 0;
  let relaysWithEvents = 0;
  let timeoutCount = 0;
  let totalEvents = 0;

  // Collect timing arrays for percentile computation
  const queryTimes: number[] = [];

  // For TTFE: find the earliest first-event arrival across relays
  // Simulate as if all relays start simultaneously:
  //   effective arrival = connectTimeMs + firstEventMs
  let minTtfe: number | null = null;
  let minTtfeConnectOnly: number | null = null;

  for (const relay of algRelays) {
    const outcome = relayOutcomes.get(relay);
    if (!outcome) continue;

    relaysWithOutcomes++;

    if (outcome.connected) {
      relaysConnected++;
      // Total wall-clock for this relay (connect + query)
      const wallClock = outcome.connectTimeMs + outcome.queryTimeMs;
      queryTimes.push(wallClock);

      if (outcome.eventCount !== undefined && outcome.eventCount > 0) {
        relaysWithEvents++;
        totalEvents += outcome.eventCount;

        // TTFE with firstEventMs precision
        if (outcome.firstEventMs !== undefined) {
          // firstEventMs is already relative to query start (which is after connect)
          // So simulated TTFE = connectTimeMs + firstEventMs
          const ttfe = outcome.connectTimeMs + outcome.firstEventMs;
          if (minTtfe === null || ttfe < minTtfe) minTtfe = ttfe;
        }

        // TTFE fallback: use connectTimeMs as approximation
        // (assumes events arrive shortly after connection)
        if (minTtfeConnectOnly === null || outcome.connectTimeMs < minTtfeConnectOnly) {
          minTtfeConnectOnly = outcome.connectTimeMs;
        }
      }
    }

    if (outcome.timedOut) timeoutCount++;
  }

  const sorted = toSortedNumericArray(queryTimes);
  const relaysConnectedNoEvents = relaysConnected - relaysWithEvents;

  // Timeout tax: dead relays block concurrency slots.
  // If we have more timeouts than concurrency, each batch of timeouts
  // adds eoseTimeoutMs to the wall-clock.
  const timeoutTaxMs = timeoutCount > 0
    ? Math.ceil(timeoutCount / concurrency) * eoseTimeoutMs
    : 0;

  // Progressive completeness: simulate event arrival curve.
  // Model: all events from a relay arrive at its EOSE time (connectTimeMs + queryTimeMs).
  // Sort relays by completion time, accumulate unique events, compute completeness at windows.
  let progressiveCompleteness: Record<number, number> | undefined;
  let eoseRace: Record<number, { cutoffMs: number; completeness: number }> | undefined;
  if (totalEvents > 0) {
    // Build relay completion timeline: [{wallClockMs, relay}] sorted by time
    const timeline: { wallClockMs: number; relay: RelayUrl }[] = [];
    for (const relay of algRelays) {
      const outcome = relayOutcomes.get(relay);
      if (!outcome || !outcome.connected) continue;
      if (outcome.eventCount === undefined || outcome.eventCount === 0) continue;
      const wallClock = outcome.connectTimeMs + outcome.queryTimeMs;
      timeline.push({ wallClockMs: wallClock, relay });
    }
    timeline.sort((a, b) => a.wallClockMs - b.wallClockMs);

    // Walk timeline, accumulate unique events from baseline intersection
    const seenEvents = new Set<string>();
    // Count total findable events for this algorithm (its eventual recall)
    const totalFindable = new Set<string>();
    for (const [pubkey] of result.pubkeyAssignments) {
      const baseline = baselines.get(pubkey);
      if (!baseline) continue;
      const assignedRelays = result.pubkeyAssignments.get(pubkey);
      if (!assignedRelays) continue;
      for (const relay of assignedRelays) {
        const ids = cache.get(relay, pubkey);
        if (ids) {
          for (const id of ids) {
            if (baseline.eventIds.has(id)) totalFindable.add(id);
          }
        }
      }
    }

    if (totalFindable.size > 0) {
      // For each relay in timeline order, add its contribution
      const timePoints: { ms: number; completeness: number }[] = [];
      for (const { wallClockMs, relay } of timeline) {
        // Add events from this relay
        const pubkeys = result.relayAssignments.get(relay);
        if (!pubkeys) continue;
        for (const pubkey of pubkeys) {
          const baseline = baselines.get(pubkey);
          if (!baseline) continue;
          const ids = cache.get(relay, pubkey);
          if (ids) {
            for (const id of ids) {
              if (baseline.eventIds.has(id)) seenEvents.add(id);
            }
          }
        }
        timePoints.push({
          ms: wallClockMs,
          completeness: seenEvents.size / totalFindable.size,
        });
      }

      // Sample at standard windows
      const windows = [1, 2, 5, 10, 15];
      progressiveCompleteness = {};
      for (const sec of windows) {
        const ms = sec * 1000;
        // Find the last time point <= ms
        let comp = 0;
        for (const tp of timePoints) {
          if (tp.ms <= ms) comp = tp.completeness;
          else break;
        }
        progressiveCompleteness[sec] = comp;
      }

      // EOSE-race simulation: first relay EOSE + grace period
      if (timePoints.length > 0) {
        const firstEoseMs = timePoints[0].ms;
        const gracePeriods = [0, 200, 500, 1000, 2000];
        eoseRace = {};
        for (const grace of gracePeriods) {
          const cutoffMs = firstEoseMs + grace;
          let comp = 0;
          for (const tp of timePoints) {
            if (tp.ms <= cutoffMs) comp = tp.completeness;
            else break;
          }
          eoseRace[grace] = { cutoffMs, completeness: comp };
        }
      }
    }
  }

  return {
    ttfeMs: minTtfe,
    ttfeConnectOnlyMs: minTtfeConnectOnly,
    queryP50Ms: sorted.length > 0 ? median(sorted) : null,
    queryP80Ms: sorted.length > 0 ? percentile(sorted, 0.80) : null,
    queryMaxMs: sorted.length > 0 ? sorted[sorted.length - 1] : null,
    timeoutCount,
    relaysWithOutcomes,
    relaysConnected,
    relaysWithEvents,
    totalEvents,
    timeoutTaxMs,
    relaysConnectedNoEvents,
    progressiveCompleteness,
    eoseRace,
  };
}

/**
 * Simulate profile-view queries for followed authors.
 * For each author with relay data, simulate querying their top 3 write relays
 * in parallel and compute TTFE. This is algorithm-independent — it measures
 * the "tap on a profile" latency using outbox routing.
 *
 * @param maxRelaysPerProfile Max write relays to query per author (default 3)
 */
export function computeProfileViewLatency(
  input: BenchmarkInput,
  baselines: Map<Pubkey, PubkeyBaseline>,
  relayOutcomes: ReadonlyMap<RelayUrl, RelayOutcome>,
  maxRelaysPerProfile = 3,
): ProfileViewLatencyStats {
  const ttfes: number[] = [];
  let totalRelaysQueried = 0;
  let totalRelaysWithEvents = 0;
  let totalTimeouts = 0;
  let hits = 0;
  let authorCount = 0;

  for (const [pubkey, baseline] of baselines) {
    // Only simulate for testable authors (ones with baseline events)
    if (baseline.classification !== "testable-reliable" &&
        baseline.classification !== "testable-partial") continue;

    const writeRelays = input.writerToRelays.get(pubkey);
    if (!writeRelays || writeRelays.size === 0) continue;

    authorCount++;

    // Take top N write relays (sorted by those that delivered events first)
    const relayList = [...writeRelays].slice(0, maxRelaysPerProfile);
    totalRelaysQueried += relayList.length;

    let authorTtfe: number | null = null;
    let authorHasEvents = false;
    let authorTimeouts = 0;

    for (const relay of relayList) {
      const outcome = relayOutcomes.get(relay);
      if (!outcome) continue;

      if (outcome.timedOut) authorTimeouts++;

      if (outcome.connected && outcome.eventCount !== undefined && outcome.eventCount > 0) {
        totalRelaysWithEvents++;
        authorHasEvents = true;

        // TTFE for this relay (simulated parallel start)
        const relayTtfe = outcome.firstEventMs !== undefined
          ? outcome.connectTimeMs + outcome.firstEventMs
          : outcome.connectTimeMs;

        if (authorTtfe === null || relayTtfe < authorTtfe) {
          authorTtfe = relayTtfe;
        }
      }
    }

    totalTimeouts += authorTimeouts;

    if (authorHasEvents && authorTtfe !== null) {
      ttfes.push(authorTtfe);
      hits++;
    }
  }

  const sorted = toSortedNumericArray(ttfes);

  return {
    authorCount,
    meanTtfeMs: sorted.length > 0 ? meanOf(ttfes) : null,
    medianTtfeMs: sorted.length > 0 ? median(sorted) : null,
    p95TtfeMs: sorted.length > 0 ? percentile(sorted, 0.95) : null,
    meanRelaysQueried: authorCount > 0 ? totalRelaysQueried / authorCount : 0,
    meanRelaysWithEvents: authorCount > 0 ? totalRelaysWithEvents / authorCount : 0,
    hitRate: authorCount > 0 ? hits / authorCount : 0,
    meanTimeouts: authorCount > 0 ? totalTimeouts / authorCount : 0,
  };
}
