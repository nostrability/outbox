/**
 * Relay score persistence for Thompson Sampling.
 *
 * Stores per-relay Beta distribution parameters (alpha, beta) that encode
 * historical delivery performance. Scores are window-specific since
 * relay quality for 7-day events differs from 3-year events.
 */

import type {
  PubkeyBaseline,
  Pubkey,
  RelayUrl,
  RelayScoreDB,
  RelayScoreEntry,
} from "./types.ts";
import type { QueryCache } from "./relay-pool.ts";

const CACHE_DIR = ".cache";
const SCHEMA_VERSION = 1;
const DECAY_FACTOR = 0.95; // exponential decay per session
const MAX_SESSION_HISTORY = 10; // keep last N session rates for trend
const TREND_MIN_SESSIONS = 3; // minimum sessions before computing trend

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
): RelayScoreDB {
  // Apply decay to existing scores
  for (const entry of Object.values(db.relays)) {
    entry.alpha = 1 + (entry.alpha - 1) * DECAY_FACTOR;
    entry.beta = 1 + (entry.beta - 1) * DECAY_FACTOR;
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
