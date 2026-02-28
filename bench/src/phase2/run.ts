/**
 * Phase 2 orchestrator: baseline collection → algorithm verification.
 */

import { RelayPool, QueryCache, MAX_EVENTS_PER_PAIR } from "../relay-pool.ts";
import { collectBaseline } from "./baseline.ts";
import { verifyAlgorithm, computeProfileViewLatency } from "./verify.ts";
import { readPhase2Cache, writePhase2Cache } from "./cache.ts";
import type {
  AlgorithmResult,
  BenchmarkInput,
  Pubkey,
  Phase2Options,
  Phase2Result,
  PubkeyBaseline,
  RelayUrl,
} from "../types.ts";
import { meanOf, median, percentile, toSortedNumericArray } from "../types.ts";

const DEFAULT_OPTIONS: Phase2Options = {
  kinds: [1],
  windowSeconds: 86400,
  maxConcurrentConns: 20,
  maxOpenSockets: 50,
  maxEventsPerPair: MAX_EVENTS_PER_PAIR,
  batchSize: 50,
  eoseTimeoutMs: 15000,
  connectTimeoutMs: 10000,
};

export function mergePhase2Options(
  overrides?: Partial<Phase2Options>,
): Phase2Options {
  return { ...DEFAULT_OPTIONS, ...overrides };
}

export async function runPhase2(
  input: BenchmarkInput,
  algorithmResults: AlgorithmResult[],
  overrides?: Partial<Phase2Options>,
  noPhase2Cache = false,
): Promise<Phase2Result> {
  const options = mergePhase2Options(overrides);
  const since = Math.floor(Date.now() / 1000) - options.windowSeconds;

  console.error("\n=== Phase 2: Event Verification ===");
  console.error(
    `Window: ${options.windowSeconds}s | Kinds: ${options.kinds} | Concurrency: ${options.maxConcurrentConns}`,
  );

  // 1. Create pool and cache
  const pool = new RelayPool({
    maxConcurrent: options.maxConcurrentConns,
    maxOpenSockets: options.maxOpenSockets,
    connectTimeoutMs: options.connectTimeoutMs,
    eoseTimeoutMs: options.eoseTimeoutMs,
    maxEventsPerPair: options.maxEventsPerPair,
  });
  const cache = new QueryCache();

  // 2. Collect extra relays needed by algorithms but not in declared write relays
  const declaredRelays = new Set<RelayUrl>(input.relayToWriters.keys());
  const extraRelays = new Map<RelayUrl, Set<Pubkey>>();
  for (const result of algorithmResults) {
    for (const [relay, pubkeys] of result.relayAssignments) {
      if (!declaredRelays.has(relay)) {
        const existing = extraRelays.get(relay) ?? new Set<Pubkey>();
        for (const pk of pubkeys) existing.add(pk);
        extraRelays.set(relay, existing);
      }
    }
  }

  if (extraRelays.size > 0) {
    console.error(
      `[phase2] ${extraRelays.size} extra relay(s) from algorithms (not in declared write relays): ${[...extraRelays.keys()].join(", ")}`,
    );
  }

  // 3. Try loading baseline from disk cache
  const startMs = performance.now();
  let baselines: Map<Pubkey, PubkeyBaseline>;
  let cacheHit = false;

  const followCount = input.writerToRelays.size;
  const relayCount = input.relayToWriters.size;

  if (!noPhase2Cache) {
    const cached = await readPhase2Cache(
      input.targetPubkey,
      options.windowSeconds,
      followCount,
      relayCount,
    );
    if (cached) {
      baselines = cached;
      cacheHit = true;
      // Populate QueryCache from cached baselines so verify can use it
      for (const baseline of baselines.values()) {
        for (const relay of baseline.relaysWithEvents) {
          // We know this relay had events for this pubkey, but we don't have
          // per-relay event IDs in the cache. Set the full event set for each
          // relay that had events (conservative: overestimates per-relay coverage,
          // but baseline eventIds is the union across all relays anyway).
          cache.set(relay, baseline.pubkey, baseline.eventIds);
        }
        // For relays that succeeded but had no events, set empty
        for (const relay of baseline.relaysSucceeded) {
          if (!baseline.relaysWithEvents.has(relay)) {
            cache.set(relay, baseline.pubkey, new Set());
          }
        }
      }
      console.error(`[phase2] Populated QueryCache from disk cache (${cache.totalEntries} entries)`);
    } else {
      baselines = await collectBaseline(input, pool, cache, options);
    }
  } else {
    baselines = await collectBaseline(input, pool, cache, options);
  }

  // 4. Query extra relays for their assigned pubkeys
  if (extraRelays.size > 0) {
    const extraSince = Math.floor(Date.now() / 1000) - options.windowSeconds;
    console.error(`[phase2] Querying ${extraRelays.size} extra relay(s)...`);
    const extraTasks = [...extraRelays.entries()].map(async ([relay, pubkeys]) => {
      const pubkeyList = [...pubkeys];
      await pool.queryBatched(
        relay,
        pubkeyList,
        { kinds: options.kinds, since: extraSince },
        options.batchSize,
        cache,
      );
    });
    await Promise.all(extraTasks);
  }

  const collectionTimeMs = performance.now() - startMs;

  // 5. Print diagnostics and close
  const diag = pool.diagnostics;
  if (diag.timeouts > 0) {
    console.error(`[phase2] Subscription timeouts (no EOSE): ${diag.timeouts}`);
  }
  if (diag.closedMessages.length > 0) {
    console.error(`[phase2] CLOSED messages received: ${diag.closedMessages.length}`);
    for (const c of diag.closedMessages.slice(0, 10)) {
      console.error(`  ${c.relay}: ${c.reason}`);
    }
  }
  if (diag.rateLimitNotices.length > 0) {
    console.error(`[phase2] Rate-limit NOTICE messages: ${diag.rateLimitNotices.length}`);
    for (const n of diag.rateLimitNotices.slice(0, 10)) {
      console.error(`  ${n.relay}: ${n.notice}`);
    }
  }
  // Compute timing stats from relay outcomes only for fresh runs (not cache hits)
  let timingStats: Phase2Result["baselineStats"]["timingStats"];
  if (!cacheHit) {
    const outcomes = pool.getAllOutcomes();
    const connectTimes: number[] = [];
    const queryTimes: number[] = [];
    let timeoutCount = 0;
    let timeoutRelayCount = 0;
    for (const outcome of outcomes.values()) {
      if (outcome.connected) {
        connectTimes.push(outcome.connectTimeMs);
        queryTimes.push(outcome.queryTimeMs);
      }
      if (outcome.timedOut) timeoutRelayCount++;
    }
    timeoutCount = diag.timeouts;

    const sortedConnect = toSortedNumericArray(connectTimes);
    const sortedQuery = toSortedNumericArray(queryTimes);
    timingStats = sortedConnect.length > 0
      ? {
          connectMs: {
            median: median(sortedConnect),
            p95: percentile(sortedConnect, 0.95),
            mean: meanOf(connectTimes),
          },
          queryMs: {
            median: median(sortedQuery),
            p95: percentile(sortedQuery, 0.95),
            mean: meanOf(queryTimes),
          },
          timeoutCount,
          timeoutRelayCount,
          totalRelayCount: outcomes.size,
        }
      : undefined;
  }

  pool.closeAll();

  // Write baseline to disk cache if we collected fresh data
  if (!cacheHit && !noPhase2Cache) {
    await writePhase2Cache(
      input.targetPubkey,
      options.windowSeconds,
      since,
      followCount,
      relayCount,
      baselines,
    ).catch((e) => console.error(`[phase2-cache] Write failed: ${e}`));
  }

  // 6. Classify authors
  let testableReliable = 0;
  let testablePartial = 0;
  let zeroBaseline = 0;
  let unreliable = 0;
  const testableEventCounts: number[] = [];
  let totalUniqueEvents = 0;

  // Collect all relays that were queried (baseline + extras)
  const allBaselineRelays = new Set<RelayUrl>(input.relayToWriters.keys());
  for (const relay of extraRelays.keys()) {
    allBaselineRelays.add(relay);
  }

  // Track relay success
  let relaysQueried = 0;
  let relaysSucceeded = 0;
  const relaysSeen = new Set<RelayUrl>();

  for (const [, baseline] of baselines) {
    switch (baseline.classification) {
      case "testable-reliable":
        testableReliable++;
        testableEventCounts.push(baseline.eventIds.size);
        totalUniqueEvents += baseline.eventIds.size;
        break;
      case "testable-partial":
        testablePartial++;
        testableEventCounts.push(baseline.eventIds.size);
        totalUniqueEvents += baseline.eventIds.size;
        break;
      case "zero-baseline":
        zeroBaseline++;
        break;
      case "unreliable":
        unreliable++;
        break;
    }

    for (const r of baseline.relaysSucceeded) {
      if (!relaysSeen.has(r)) { relaysSeen.add(r); relaysQueried++; relaysSucceeded++; }
    }
    for (const r of baseline.relaysFailed) {
      if (!relaysSeen.has(r)) { relaysSeen.add(r); relaysQueried++; }
    }
  }

  // Invariant check
  const total = testableReliable + testablePartial + zeroBaseline + unreliable;
  if (total !== input.writerToRelays.size) {
    console.error(
      `[phase2] WARNING: classification sum ${total} != writerToRelays.size ${input.writerToRelays.size}`,
    );
  }

  const sortedEventCounts = toSortedNumericArray(testableEventCounts);

  // 7. Verify each algorithm (pass relay outcomes for latency simulation on fresh runs)
  const outcomesForLatency = !cacheHit ? pool.getAllOutcomes() : undefined;
  const algorithms = algorithmResults.map((result) =>
    verifyAlgorithm(
      result, baselines, cache, allBaselineRelays, declaredRelays,
      outcomesForLatency, options.eoseTimeoutMs, options.maxConcurrentConns,
    )
  );

  // Invariant: testableReliable and totalBaselineEvents should be identical across algorithms
  for (const alg of algorithms) {
    if (alg.testableReliableAuthors !== testableReliable) {
      console.error(
        `[phase2] WARNING: ${alg.algorithmName} testableReliableAuthors=${alg.testableReliableAuthors} != ${testableReliable}`,
      );
    }
  }

  // 8. Profile-view latency simulation (algorithm-independent, fresh runs only)
  let profileViewLatency: Phase2Result["profileViewLatency"];
  if (outcomesForLatency) {
    profileViewLatency = computeProfileViewLatency(input, baselines, outcomesForLatency);
  }

  return {
    options,
    since,
    totalAuthorsWithRelayData: input.writerToRelays.size,
    testableReliableAuthors: testableReliable,
    testablePartialAuthors: testablePartial,
    authorsZeroBaseline: zeroBaseline,
    authorsUnreliableBaseline: unreliable,
    baselineStats: {
      totalRelaysQueried: relaysQueried,
      relaySuccessRate: relaysQueried > 0 ? relaysSucceeded / relaysQueried : 0,
      totalUniqueEvents,
      meanEventsPerTestableAuthor: meanOf(testableEventCounts),
      medianEventsPerTestableAuthor: median(sortedEventCounts),
      collectionTimeMs,
      timingStats,
    },
    algorithms,
    profileViewLatency,
    _baselines: baselines,
    _cache: cache,
  };
}
