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

function scorePath(pubkeyPrefix: string, window: number, filterMode?: string): string {
  const suffix = filterMode ? `_${filterMode}` : "";
  return `${CACHE_DIR}/relay_scores_${pubkeyPrefix}_${window}${suffix}.json`;
}

export function loadRelayScores(pubkey: string, windowSeconds: number, filterMode?: string): RelayScoreDB {
  const prefix = pubkey.slice(0, 16);
  const path = scorePath(prefix, windowSeconds, filterMode);

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
  for (const [relay, pubkeys] of relayAssignments) {
    const entry: RelayScoreEntry = db.relays[relay] ?? {
      alpha: 1,
      beta: 1,
      lastQueried: 0,
      totalEvents: 0,
      totalExpected: 0,
    };

    entry.lastQueried = Date.now();

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
    }

    db.relays[relay] = entry;
  }

  db.sessionCount++;
  db.updatedAt = Date.now();

  console.error(
    `[relay-scores] Updated scores for ${algorithmName}: ` +
    `${Object.keys(db.relays).length} relays, session ${db.sessionCount}`,
  );

  return db;
}

export async function saveRelayScores(db: RelayScoreDB, filterMode?: string): Promise<void> {
  await Deno.mkdir(CACHE_DIR, { recursive: true });
  const prefix = db.pubkey.slice(0, 16);
  const path = scorePath(prefix, db.windowSeconds, filterMode);
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
