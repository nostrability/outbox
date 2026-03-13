/**
 * Relay score persistence for Thompson Sampling.
 *
 * Stores per-relay Beta distribution parameters (alpha, beta) that encode
 * historical delivery performance. Scores are window-specific since
 * relay quality for 7-day events differs from 3-year events.
 */

import type {
  DecayConfig,
  PubkeyBaseline,
  Pubkey,
  RelayUrl,
  RelayScoreDB,
  RelayScoreEntry,
} from "./types.ts";
import type { QueryCache, RelayOutcome } from "./relay-pool.ts";

const CACHE_DIR = ".cache";
const SCHEMA_VERSION = 1;
const DEFAULT_DECAY_FACTOR = 0.95; // exponential decay per session
const MAX_SESSION_HISTORY = 10; // keep last N session rates for trend
const TREND_MIN_SESSIONS = 3; // minimum sessions before computing trend

/** Compute effective decay multiplier based on config.
 *  "session" unit: factor^1 per call (unchanged from original).
 *  "hour" unit: factor^(elapsed_hours) since last update.   */
function computeDecay(db: RelayScoreDB, config?: DecayConfig): number {
  const factor = config?.factor ?? DEFAULT_DECAY_FACTOR;
  if (!config || config.unit === "session") {
    return factor;
  }
  // hour-based: compute elapsed hours since last session
  const elapsedMs = Date.now() - db.updatedAt;
  const elapsedHours = Math.max(elapsedMs / 3_600_000, 0);
  return Math.pow(factor, elapsedHours);
}

/** Minimum beta dampening factor for coverage-weighted scoring.
 *  Lower = more protection for sole-source relays (0 = no penalty, 1 = full penalty). */
const CW_BETA_DAMP_MIN = 0.5;

function scorePath(pubkeyPrefix: string, window: number, filterMode?: string, algorithmId?: string): string {
  const suffix = filterMode ? `_${filterMode}` : "";
  const algoSuffix = algorithmId ? `_${algorithmId}` : "";
  return `${CACHE_DIR}/relay_scores_${pubkeyPrefix}_${window}${suffix}${algoSuffix}.json`;
}

export function loadRelayScores(pubkey: string, windowSeconds: number, filterMode?: string, algorithmId?: string): RelayScoreDB {
  const prefix = pubkey.slice(0, 16);
  const path = scorePath(prefix, windowSeconds, filterMode, algorithmId);

  try {
    const raw = Deno.readTextFileSync(path);
    const db = JSON.parse(raw) as RelayScoreDB;
    if (db.schemaVersion !== SCHEMA_VERSION) {
      console.error(`[relay-scores] Schema mismatch, starting fresh`);
      return freshDB(pubkey, windowSeconds);
    }
    console.error(
      `[relay-scores] Loaded ${Object.keys(db.relays).length} relay priors ` +
      `(session ${db.sessionCount}, from ${new Date(db.updatedAt).toISOString()})`,
    );
    return db;
  } catch {
    return freshDB(pubkey, windowSeconds);
  }
}

function freshDB(pubkey: string, windowSeconds: number): RelayScoreDB {
  return {
    schemaVersion: 1,
    pubkey,
    windowSeconds,
    updatedAt: Date.now(),
    sessionCount: 0,
    relays: {},
  };
}

/**
 * Update relay scores from Phase 2 verification results.
 *
 * For each relay in the algorithm's selection, computes a delivery fraction
 * (events this relay had / baseline events for each assigned pubkey) and
 * updates the Beta distribution parameters.
 */
export function updateRelayScores(
  db: RelayScoreDB,
  algorithmName: string,
  relayAssignments: Map<RelayUrl, Set<Pubkey>>,
  _pubkeyAssignments: Map<Pubkey, Set<RelayUrl>>,
  baselines: Map<Pubkey, PubkeyBaseline>,
  cache: QueryCache,
  relayOutcomes?: ReadonlyMap<RelayUrl, RelayOutcome>,
  _writerToRelays?: ReadonlyMap<Pubkey, Set<RelayUrl>>,
  decayConfig?: DecayConfig,
): RelayScoreDB {
  // Apply decay to existing scores
  const decay = computeDecay(db, decayConfig);
  for (const entry of Object.values(db.relays)) {
    entry.alpha = 1 + (entry.alpha - 1) * decay;
    entry.beta = 1 + (entry.beta - 1) * decay;
  }

  // Compute new observations from this session
  const degrading: string[] = [];
  for (const [relay, pubkeys] of relayAssignments) {
    const entry: RelayScoreEntry = db.relays[relay] ?? {
      alpha: 1,
      beta: 1,
      lastQueried: 0,
      totalEvents: 0,
      totalExpected: 0,
    };

    entry.lastQueried = Date.now();

    let sessionDelivered = 0;
    let sessionExpected = 0;

    for (const pubkey of pubkeys) {
      const baseline = baselines.get(pubkey);
      if (!baseline || baseline.eventIds.size === 0) continue;

      const relayEvents = cache.get(relay, pubkey);
      const relayEventCount = relayEvents ? relayEvents.size : 0;
      const baselineCount = baseline.eventIds.size;

      // Fractional success/failure (clamp to [0,1] — relay can return
      // events not in baseline if baseline was incomplete)
      const delivered = Math.min(relayEventCount / baselineCount, 1);
      entry.alpha += delivered;
      entry.beta += (1 - delivered);
      entry.totalEvents += relayEventCount;
      entry.totalExpected += baselineCount;

      sessionDelivered += relayEventCount;
      sessionExpected += baselineCount;
    }

    // Track session delivery rate
    const sessionRate = sessionExpected > 0 ? sessionDelivered / sessionExpected : 0;
    const history = entry.sessionRates ?? [];
    history.push(sessionRate);
    if (history.length > MAX_SESSION_HISTORY) history.shift();
    entry.sessionRates = history;

    // Compute trend from session history
    entry.trend = computeTrend(history);
    if (entry.trend === "declining" && history.length >= TREND_MIN_SESSIONS) {
      degrading.push(relay);
    }

    // EWMA latency update from relay outcomes
    if (relayOutcomes) {
      const outcome = relayOutcomes.get(relay);
      if (outcome?.connected) {
        const measured = outcome.connectTimeMs + outcome.queryTimeMs;
        const prev = entry.latencyObservations ?? 0;
        entry.latencyMs = (prev === 0 || !Number.isFinite(entry.latencyMs))
          ? measured
          : (entry.latencyMs! * 0.7 + measured * 0.3);
        entry.latencyObservations = prev + 1;
      }
    }

    db.relays[relay] = entry;
  }

  db.sessionCount++;
  db.updatedAt = Date.now();

  console.error(
    `[relay-scores] Updated scores for ${algorithmName}: ` +
    `${Object.keys(db.relays).length} relays, session ${db.sessionCount}`,
  );
  if (degrading.length > 0) {
    console.error(
      `[relay-scores] Degrading relays (${degrading.length}): ${degrading.slice(0, 5).join(", ")}` +
      (degrading.length > 5 ? ` (+${degrading.length - 5} more)` : ""),
    );
  }

  return db;
}

/**
 * Coverage-Weighted variant of updateRelayScores.
 *
 * Dampens beta (failure penalty) based on how many alternative relays cover
 * each pubkey. Sole-source pubkeys get heavy dampening (betaDamp → CW_BETA_DAMP_MIN),
 * while highly-redundant pubkeys get near-full penalty.
 *
 * Formula: betaDamp = 1 - (1 / (alternatives + 1))
 *   1 alt → 0.5, 2 alt → 0.67, 3 alt → 0.75, 10 alt → 0.91
 */
export function updateRelayScoresCW(
  db: RelayScoreDB,
  algorithmName: string,
  relayAssignments: Map<RelayUrl, Set<Pubkey>>,
  pubkeyAssignments: Map<Pubkey, Set<RelayUrl>>,
  baselines: Map<Pubkey, PubkeyBaseline>,
  cache: QueryCache,
  relayOutcomes?: ReadonlyMap<RelayUrl, RelayOutcome>,
  _writerToRelays?: ReadonlyMap<Pubkey, Set<RelayUrl>>,
  decayConfig?: DecayConfig,
): RelayScoreDB {
  // Apply decay to existing scores
  const decay = computeDecay(db, decayConfig);
  for (const entry of Object.values(db.relays)) {
    entry.alpha = 1 + (entry.alpha - 1) * decay;
    entry.beta = 1 + (entry.beta - 1) * decay;
  }

  // Compute new observations from this session
  const degrading: string[] = [];
  const cwDampened: string[] = [];
  for (const [relay, pubkeys] of relayAssignments) {
    const entry: RelayScoreEntry = db.relays[relay] ?? {
      alpha: 1,
      beta: 1,
      lastQueried: 0,
      totalEvents: 0,
      totalExpected: 0,
    };

    entry.lastQueried = Date.now();

    let sessionDelivered = 0;
    let sessionExpected = 0;

    for (const pubkey of pubkeys) {
      const baseline = baselines.get(pubkey);
      if (!baseline || baseline.eventIds.size === 0) continue;

      const relayEvents = cache.get(relay, pubkey);
      const relayEventCount = relayEvents ? relayEvents.size : 0;
      const baselineCount = baseline.eventIds.size;

      const delivered = Math.min(relayEventCount / baselineCount, 1);
      const alternatives = pubkeyAssignments.get(pubkey)?.size ?? 1;
      const betaDamp = Math.max(1 - (1 / (alternatives + 1)), CW_BETA_DAMP_MIN);
      entry.alpha += delivered;                           // full credit for delivery
      entry.beta += (1 - delivered) * betaDamp;           // dampened penalty for irreplaceable relays
      entry.totalEvents += relayEventCount;
      entry.totalExpected += baselineCount;

      sessionDelivered += relayEventCount;
      sessionExpected += baselineCount;
    }

    // Track session delivery rate
    const sessionRate = sessionExpected > 0 ? sessionDelivered / sessionExpected : 0;
    const history = entry.sessionRates ?? [];
    history.push(sessionRate);
    if (history.length > MAX_SESSION_HISTORY) history.shift();
    entry.sessionRates = history;

    // Compute trend from session history
    entry.trend = computeTrend(history);
    if (entry.trend === "declining" && history.length >= TREND_MIN_SESSIONS) {
      degrading.push(relay);
    }

    // EWMA latency update from relay outcomes
    if (relayOutcomes) {
      const outcome = relayOutcomes.get(relay);
      if (outcome?.connected) {
        const measured = outcome.connectTimeMs + outcome.queryTimeMs;
        const prev = entry.latencyObservations ?? 0;
        entry.latencyMs = (prev === 0 || !Number.isFinite(entry.latencyMs))
          ? measured
          : (entry.latencyMs! * 0.7 + measured * 0.3);
        entry.latencyObservations = prev + 1;
      }
    }

    // CW diagnostic: count sole-source pubkeys for this relay
    const soleSourceCount = [...pubkeys].filter(pk => (pubkeyAssignments.get(pk)?.size ?? 1) === 1).length;
    if (soleSourceCount > 0) {
      cwDampened.push(`${relay}(${soleSourceCount}/${pubkeys.size} sole-source)`);
    }

    db.relays[relay] = entry;
  }

  db.sessionCount++;
  db.updatedAt = Date.now();

  console.error(
    `[relay-scores-cw] Updated scores for ${algorithmName}: ` +
    `${Object.keys(db.relays).length} relays, session ${db.sessionCount}`,
  );
  if (degrading.length > 0) {
    console.error(
      `[relay-scores-cw] Degrading relays (${degrading.length}): ${degrading.slice(0, 5).join(", ")}` +
      (degrading.length > 5 ? ` (+${degrading.length - 5} more)` : ""),
    );
  }
  if (cwDampened.length > 0) {
    console.error(
      `[relay-scores-cw] CW-dampened relays (${cwDampened.length}): ${cwDampened.slice(0, 5).join(", ")}` +
      (cwDampened.length > 5 ? ` (+${cwDampened.length - 5} more)` : ""),
    );
  }

  return db;
}

/**
 * Sole-Source Exclusion variant of updateRelayScores.
 *
 * Skips alpha/beta updates for pubkeys whose relay list has only one relay
 * (sole-source), so the relay's score reflects contested-pubkey performance
 * only. Uses writerToRelays (ground-truth data) not pubkeyAssignments
 * (selection) to detect sole-source status.
 *
 * When a relay has fewer than 3 contested-pubkey observations, falls back
 * to CW-style dampened scoring (betaDamp = 0.5) for a smoother transition.
 */
export function updateRelayScoresSE(
  db: RelayScoreDB,
  algorithmName: string,
  relayAssignments: Map<RelayUrl, Set<Pubkey>>,
  _pubkeyAssignments: Map<Pubkey, Set<RelayUrl>>,
  baselines: Map<Pubkey, PubkeyBaseline>,
  cache: QueryCache,
  relayOutcomes?: ReadonlyMap<RelayUrl, RelayOutcome>,
  writerToRelays?: ReadonlyMap<Pubkey, Set<RelayUrl>>,
  decayConfig?: DecayConfig,
): RelayScoreDB {
  // Apply decay to existing scores
  const decay = computeDecay(db, decayConfig);
  for (const entry of Object.values(db.relays)) {
    entry.alpha = 1 + (entry.alpha - 1) * decay;
    entry.beta = 1 + (entry.beta - 1) * decay;
  }

  // Compute new observations from this session
  const degrading: string[] = [];
  let totalSoleSourceSkipped = 0;
  let relaysWithSoleSource = 0;
  const forcedRelayScores: string[] = [];

  for (const [relay, pubkeys] of relayAssignments) {
    const entry: RelayScoreEntry = db.relays[relay] ?? {
      alpha: 1,
      beta: 1,
      lastQueried: 0,
      totalEvents: 0,
      totalExpected: 0,
    };

    // Snapshot pre-session alpha/beta for potential fallback rewind
    const preAlpha = entry.alpha;
    const preBeta = entry.beta;

    entry.lastQueried = Date.now();

    let sessionDelivered = 0;
    let sessionExpected = 0;
    let contestedCount = 0;
    let soleSourceSkipped = 0;

    for (const pubkey of pubkeys) {
      const baseline = baselines.get(pubkey);
      if (!baseline || baseline.eventIds.size === 0) continue;

      const relayEvents = cache.get(relay, pubkey);
      const relayEventCount = relayEvents ? relayEvents.size : 0;
      const baselineCount = baseline.eventIds.size;

      // Sole-source check: use data (writerToRelays), not selection (pubkeyAssignments)
      const authorRelays = writerToRelays?.get(pubkey);
      const alternatives = authorRelays?.size ?? 1;
      if (alternatives <= 1) {
        // Sole-source: skip alpha/beta — no alternative to compare against
        entry.totalEvents += relayEventCount;
        entry.totalExpected += baselineCount;
        sessionDelivered += relayEventCount;
        sessionExpected += baselineCount;
        soleSourceSkipped++;
        continue;
      }

      contestedCount++;
      const delivered = Math.min(relayEventCount / baselineCount, 1);
      entry.alpha += delivered;
      entry.beta += (1 - delivered);
      entry.totalEvents += relayEventCount;
      entry.totalExpected += baselineCount;

      sessionDelivered += relayEventCount;
      sessionExpected += baselineCount;
    }

    // Fallback: too few contested observations — rewind and re-process with dampening
    if (contestedCount < 3 && soleSourceSkipped > 0) {
      // Rewind alpha/beta to pre-session values
      entry.alpha = preAlpha;
      entry.beta = preBeta;

      // Re-process ALL pubkeys with CW-style dampening
      for (const pubkey of pubkeys) {
        const baseline = baselines.get(pubkey);
        if (!baseline || baseline.eventIds.size === 0) continue;

        const relayEvents = cache.get(relay, pubkey);
        const relayEventCount = relayEvents ? relayEvents.size : 0;
        const baselineCount = baseline.eventIds.size;

        const authorRelays = writerToRelays?.get(pubkey);
        const alternatives = authorRelays?.size ?? 1;
        const betaDamp = Math.max(1 - (1 / (alternatives + 1)), CW_BETA_DAMP_MIN);
        const delivered = Math.min(relayEventCount / baselineCount, 1);
        entry.alpha += delivered;
        entry.beta += (1 - delivered) * betaDamp;
      }

      console.error(`[relay-scores-se] Relay ${relay}: ${contestedCount} contested obs (fallback dampening applied)`);
    }

    if (soleSourceSkipped > 0) {
      totalSoleSourceSkipped += soleSourceSkipped;
      relaysWithSoleSource++;
      const e = entry.alpha / (entry.alpha + entry.beta);
      forcedRelayScores.push(`${relay}(E=${e.toFixed(3)})`);
    }

    // Track session delivery rate
    const sessionRate = sessionExpected > 0 ? sessionDelivered / sessionExpected : 0;
    const history = entry.sessionRates ?? [];
    history.push(sessionRate);
    if (history.length > MAX_SESSION_HISTORY) history.shift();
    entry.sessionRates = history;

    // Compute trend from session history
    entry.trend = computeTrend(history);
    if (entry.trend === "declining" && history.length >= TREND_MIN_SESSIONS) {
      degrading.push(relay);
    }

    // EWMA latency update from relay outcomes
    if (relayOutcomes) {
      const outcome = relayOutcomes.get(relay);
      if (outcome?.connected) {
        const measured = outcome.connectTimeMs + outcome.queryTimeMs;
        const prev = entry.latencyObservations ?? 0;
        entry.latencyMs = (prev === 0 || !Number.isFinite(entry.latencyMs))
          ? measured
          : (entry.latencyMs! * 0.7 + measured * 0.3);
        entry.latencyObservations = prev + 1;
      }
    }

    db.relays[relay] = entry;
  }

  db.sessionCount++;
  db.updatedAt = Date.now();

  console.error(
    `[relay-scores-se] Updated scores for ${algorithmName}: ` +
    `${Object.keys(db.relays).length} relays, session ${db.sessionCount}`,
  );
  if (totalSoleSourceSkipped > 0) {
    console.error(
      `[relay-scores-se] Skipped ${totalSoleSourceSkipped} sole-source observations across ${relaysWithSoleSource} relays`,
    );
  }
  if (forcedRelayScores.length > 0) {
    console.error(
      `[relay-scores-se] Force-included relays and scores: ${forcedRelayScores.slice(0, 10).join(", ")}` +
      (forcedRelayScores.length > 10 ? ` (+${forcedRelayScores.length - 10} more)` : ""),
    );
  }
  if (degrading.length > 0) {
    console.error(
      `[relay-scores-se] Degrading relays (${degrading.length}): ${degrading.slice(0, 5).join(", ")}` +
      (degrading.length > 5 ? ` (+${degrading.length - 5} more)` : ""),
    );
  }

  return db;
}

/**
 * Partial-Weight Sole-Source variant of updateRelayScores.
 *
 * Instead of fully excluding sole-source observations (0x weight as in SE),
 * applies a reduced weight (0.3x) so Thompson still learns from them.
 * Removes the fallback rewind mechanism — with partial weight, even relays
 * with only sole-source observations accumulate meaningful signal.
 */
export function updateRelayScoresPW(
  db: RelayScoreDB,
  algorithmName: string,
  relayAssignments: Map<RelayUrl, Set<Pubkey>>,
  _pubkeyAssignments: Map<Pubkey, Set<RelayUrl>>,
  baselines: Map<Pubkey, PubkeyBaseline>,
  cache: QueryCache,
  relayOutcomes?: ReadonlyMap<RelayUrl, RelayOutcome>,
  writerToRelays?: ReadonlyMap<Pubkey, Set<RelayUrl>>,
  decayConfig?: DecayConfig,
): RelayScoreDB {
  const SOLE_SOURCE_WEIGHT = 0.3;

  // Apply decay to existing scores
  const decay = computeDecay(db, decayConfig);
  for (const entry of Object.values(db.relays)) {
    entry.alpha = 1 + (entry.alpha - 1) * decay;
    entry.beta = 1 + (entry.beta - 1) * decay;
  }

  // Compute new observations from this session
  const degrading: string[] = [];
  let totalSoleSourceWeighted = 0;
  let relaysWithSoleSource = 0;
  const forcedRelayScores: string[] = [];

  for (const [relay, pubkeys] of relayAssignments) {
    const entry: RelayScoreEntry = db.relays[relay] ?? {
      alpha: 1,
      beta: 1,
      lastQueried: 0,
      totalEvents: 0,
      totalExpected: 0,
    };

    entry.lastQueried = Date.now();

    let sessionDelivered = 0;
    let sessionExpected = 0;
    let soleSourceWeighted = 0;

    for (const pubkey of pubkeys) {
      const baseline = baselines.get(pubkey);
      if (!baseline || baseline.eventIds.size === 0) continue;

      const relayEvents = cache.get(relay, pubkey);
      const relayEventCount = relayEvents ? relayEvents.size : 0;
      const baselineCount = baseline.eventIds.size;

      // Sole-source check: use data (writerToRelays), not selection (pubkeyAssignments)
      const authorRelays = writerToRelays?.get(pubkey);
      const alternatives = authorRelays?.size ?? 1;
      if (alternatives <= 1) {
        // Sole-source: partial weight (0.3x) instead of full exclusion
        const delivered = Math.min(relayEventCount / baselineCount, 1);
        entry.alpha += delivered * SOLE_SOURCE_WEIGHT;
        entry.beta += (1 - delivered) * SOLE_SOURCE_WEIGHT;
        entry.totalEvents += relayEventCount;
        entry.totalExpected += baselineCount;
        sessionDelivered += relayEventCount;
        sessionExpected += baselineCount;
        soleSourceWeighted++;
        continue;
      }

      const delivered = Math.min(relayEventCount / baselineCount, 1);
      entry.alpha += delivered;
      entry.beta += (1 - delivered);
      entry.totalEvents += relayEventCount;
      entry.totalExpected += baselineCount;

      sessionDelivered += relayEventCount;
      sessionExpected += baselineCount;
    }

    if (soleSourceWeighted > 0) {
      totalSoleSourceWeighted += soleSourceWeighted;
      relaysWithSoleSource++;
      const e = entry.alpha / (entry.alpha + entry.beta);
      forcedRelayScores.push(`${relay}(E=${e.toFixed(3)})`);
    }

    // Track session delivery rate
    const sessionRate = sessionExpected > 0 ? sessionDelivered / sessionExpected : 0;
    const history = entry.sessionRates ?? [];
    history.push(sessionRate);
    if (history.length > MAX_SESSION_HISTORY) history.shift();
    entry.sessionRates = history;

    // Compute trend from session history
    entry.trend = computeTrend(history);
    if (entry.trend === "declining" && history.length >= TREND_MIN_SESSIONS) {
      degrading.push(relay);
    }

    // EWMA latency update from relay outcomes
    if (relayOutcomes) {
      const outcome = relayOutcomes.get(relay);
      if (outcome?.connected) {
        const measured = outcome.connectTimeMs + outcome.queryTimeMs;
        const prev = entry.latencyObservations ?? 0;
        entry.latencyMs = (prev === 0 || !Number.isFinite(entry.latencyMs))
          ? measured
          : (entry.latencyMs! * 0.7 + measured * 0.3);
        entry.latencyObservations = prev + 1;
      }
    }

    db.relays[relay] = entry;
  }

  db.sessionCount++;
  db.updatedAt = Date.now();

  console.error(
    `[relay-scores-pw] Updated scores for ${algorithmName}: ` +
    `${Object.keys(db.relays).length} relays, session ${db.sessionCount}`,
  );
  if (totalSoleSourceWeighted > 0) {
    console.error(
      `[relay-scores-pw] Partial-weighted ${totalSoleSourceWeighted} sole-source observations across ${relaysWithSoleSource} relays (${SOLE_SOURCE_WEIGHT}x)`,
    );
  }
  if (forcedRelayScores.length > 0) {
    console.error(
      `[relay-scores-pw] Sole-source relays and scores: ${forcedRelayScores.slice(0, 10).join(", ")}` +
      (forcedRelayScores.length > 10 ? ` (+${forcedRelayScores.length - 10} more)` : ""),
    );
  }
  if (degrading.length > 0) {
    console.error(
      `[relay-scores-pw] Degrading relays (${degrading.length}): ${degrading.slice(0, 5).join(", ")}` +
      (degrading.length > 5 ? ` (+${degrading.length - 5} more)` : ""),
    );
  }

  return db;
}

export async function saveRelayScores(db: RelayScoreDB, filterMode?: string, algorithmId?: string): Promise<void> {
  await Deno.mkdir(CACHE_DIR, { recursive: true });
  const prefix = db.pubkey.slice(0, 16);
  const path = scorePath(prefix, db.windowSeconds, filterMode, algorithmId);
  const tmp = await Deno.makeTempFile({ dir: CACHE_DIR });
  try {
    await Deno.writeTextFile(tmp, JSON.stringify(db, null, 2));
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
  console.error(`[relay-scores] Saved to ${path}`);
}

/**
 * Compute trend from session rate history using simple linear regression slope.
 * Returns "declining" if slope is significantly negative, "improving" if positive, else "stable".
 */
function computeTrend(rates: number[]): "improving" | "declining" | "stable" {
  if (rates.length < TREND_MIN_SESSIONS) return "stable";
  // Simple linear regression: slope of rate over session index
  const n = rates.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += rates[i];
    sumXY += i * rates[i];
    sumX2 += i * i;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  // Threshold: >5% per-session change is significant
  const threshold = 0.05;
  if (slope < -threshold) return "declining";
  if (slope > threshold) return "improving";
  return "stable";
}

/**
 * Build per-relay priors map for Thompson Sampling from the score DB.
 */
export function getRelayPriors(
  db: RelayScoreDB,
): Map<RelayUrl, { alpha: number; beta: number }> {
  const priors = new Map<RelayUrl, { alpha: number; beta: number }>();
  for (const [relay, entry] of Object.entries(db.relays)) {
    priors.set(relay, { alpha: entry.alpha, beta: entry.beta });
  }
  return priors;
}

/**
 * Build per-relay latency map from the score DB.
 * Only includes relays with at least one latency observation.
 */
export function getRelayLatencies(
  db: RelayScoreDB,
): Map<RelayUrl, number> {
  const latencies = new Map<RelayUrl, number>();
  for (const [relay, entry] of Object.entries(db.relays)) {
    if (entry.latencyMs !== undefined && (entry.latencyObservations ?? 0) > 0) {
      latencies.set(relay, entry.latencyMs);
    }
  }
  return latencies;
}
