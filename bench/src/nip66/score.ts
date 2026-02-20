/**
 * NIP-66 relay quality scoring.
 *
 * Produces a 0.0-1.0 quality score for each relay based on NIP-66 monitor data.
 *
 * Scoring factors (weights sum to 1.0):
 *   - Uptime/liveness  (0.4) - Was the relay recently seen online by a monitor?
 *   - RTT              (0.3) - How fast is the relay? Lower RTT = higher score.
 *   - Freshness        (0.2) - How recent is the monitor observation?
 *   - NIP support      (0.1) - Does the relay support relevant NIPs?
 */

import type { Nip66RelayData, Nip66RelayScore, RelayUrl } from "../types.ts";

/** Weight configuration for scoring factors. */
export interface Nip66ScoreWeights {
  uptime: number;
  rtt: number;
  freshness: number;
  nipSupport: number;
}

export const DEFAULT_WEIGHTS: Nip66ScoreWeights = {
  uptime: 0.4,
  rtt: 0.3,
  freshness: 0.2,
  nipSupport: 0.1,
};

/** NIPs that are particularly relevant for outbox-model relay selection. */
const RELEVANT_NIPS = new Set([
  1,   // Basic protocol
  2,   // Follow list (deprecated but still used)
  9,   // Event deletion
  11,  // Relay information document
  15,  // Marketplace / generic lists
  40,  // Expiration
  42,  // Authentication
  50,  // Search
  65,  // Relay list metadata (NIP-65)
]);

/** Neutral score for relays with no NIP-66 data. */
const NEUTRAL_SCORE = 0.5;

/** RTT thresholds in ms for scoring. */
const RTT_EXCELLENT_MS = 100;
const RTT_GOOD_MS = 300;
const RTT_ACCEPTABLE_MS = 800;
const RTT_POOR_MS = 2000;

/** Freshness thresholds in seconds. */
const FRESH_THRESHOLD_S = 3600;       // 1 hour
const ACCEPTABLE_THRESHOLD_S = 21600; // 6 hours
const STALE_THRESHOLD_S = 86400;      // 24 hours

/**
 * Score a single relay based on NIP-66 data.
 *
 * @param relayUrl - Normalized relay URL
 * @param data - NIP-66 data map (relay URL -> data)
 * @param weights - Optional custom weights
 * @returns Score object with composite score and factor breakdown
 */
export function scoreRelay(
  relayUrl: RelayUrl,
  data: Map<RelayUrl, Nip66RelayData>,
  weights: Nip66ScoreWeights = DEFAULT_WEIGHTS,
): Nip66RelayScore {
  const entry = data.get(relayUrl);

  if (!entry) {
    // No data -> neutral score
    return {
      relayUrl,
      score: NEUTRAL_SCORE,
      factors: {
        uptime: NEUTRAL_SCORE,
        rtt: NEUTRAL_SCORE,
        freshness: NEUTRAL_SCORE,
        nipSupport: NEUTRAL_SCORE,
      },
    };
  }

  const uptimeScore = computeUptimeScore(entry);
  const rttScore = computeRttScore(entry);
  const freshnessScore = computeFreshnessScore(entry);
  const nipScore = computeNipSupportScore(entry);

  const composite =
    weights.uptime * uptimeScore +
    weights.rtt * rttScore +
    weights.freshness * freshnessScore +
    weights.nipSupport * nipScore;

  return {
    relayUrl,
    score: Math.max(0, Math.min(1, composite)),
    factors: {
      uptime: uptimeScore,
      rtt: rttScore,
      freshness: freshnessScore,
      nipSupport: nipScore,
    },
  };
}

/**
 * Score all relays in a set. Returns a map of relay URL -> score.
 */
export function scoreAllRelays(
  relayUrls: Iterable<RelayUrl>,
  data: Map<RelayUrl, Nip66RelayData>,
  weights: Nip66ScoreWeights = DEFAULT_WEIGHTS,
): Map<RelayUrl, Nip66RelayScore> {
  const scores = new Map<RelayUrl, Nip66RelayScore>();
  for (const url of relayUrls) {
    scores.set(url, scoreRelay(url, data, weights));
  }
  return scores;
}

// ---- Factor scoring functions ----

/**
 * Uptime score: a relay present in NIP-66 data was seen online by a monitor.
 * The score is based on how recently it was seen.
 *
 * - Seen in last hour: 1.0
 * - Seen in last 6 hours: 0.8
 * - Seen in last 24 hours: 0.6
 * - Older: 0.3
 *
 * Synthetic/HTTP-API entries (no real monitor) get 0.7 if recent.
 */
function computeUptimeScore(entry: Nip66RelayData): number {
  const ageS = Math.floor(Date.now() / 1000) - entry.lastSeenAt;

  // Synthetic data gets a muted score
  if (entry.monitorPubkey === "synthetic") return 0.5;
  if (entry.monitorPubkey === "http-api") {
    return ageS <= FRESH_THRESHOLD_S ? 0.7 : 0.5;
  }

  // Real monitor data
  if (ageS <= FRESH_THRESHOLD_S) return 1.0;
  if (ageS <= ACCEPTABLE_THRESHOLD_S) return 0.8;
  if (ageS <= STALE_THRESHOLD_S) return 0.6;
  return 0.3;
}

/**
 * RTT score: lower round-trip time = higher score.
 * Uses the open RTT as primary, falling back to read RTT.
 *
 * Scoring curve (piecewise linear):
 *   <= 100ms: 1.0
 *   100-300ms: 0.8-1.0 (interpolated)
 *   300-800ms: 0.5-0.8 (interpolated)
 *   800-2000ms: 0.2-0.5 (interpolated)
 *   > 2000ms: 0.1
 *   No data: 0.5 (neutral)
 */
function computeRttScore(entry: Nip66RelayData): number {
  const rtt = entry.rttOpenMs ?? entry.rttReadMs ?? null;
  if (rtt === null) return NEUTRAL_SCORE;
  if (rtt <= 0) return NEUTRAL_SCORE; // invalid

  if (rtt <= RTT_EXCELLENT_MS) return 1.0;
  if (rtt <= RTT_GOOD_MS) {
    return lerp(1.0, 0.8, (rtt - RTT_EXCELLENT_MS) / (RTT_GOOD_MS - RTT_EXCELLENT_MS));
  }
  if (rtt <= RTT_ACCEPTABLE_MS) {
    return lerp(0.8, 0.5, (rtt - RTT_GOOD_MS) / (RTT_ACCEPTABLE_MS - RTT_GOOD_MS));
  }
  if (rtt <= RTT_POOR_MS) {
    return lerp(0.5, 0.2, (rtt - RTT_ACCEPTABLE_MS) / (RTT_POOR_MS - RTT_ACCEPTABLE_MS));
  }
  return 0.1;
}

/**
 * Freshness score: how recent is the NIP-66 observation?
 * More recent data is more trustworthy.
 *
 *   <= 1 hour: 1.0
 *   1-6 hours: 0.7-1.0
 *   6-24 hours: 0.4-0.7
 *   > 24 hours: 0.2
 */
function computeFreshnessScore(entry: Nip66RelayData): number {
  const ageS = Math.floor(Date.now() / 1000) - entry.lastSeenAt;

  if (ageS <= FRESH_THRESHOLD_S) return 1.0;
  if (ageS <= ACCEPTABLE_THRESHOLD_S) {
    return lerp(1.0, 0.7, (ageS - FRESH_THRESHOLD_S) / (ACCEPTABLE_THRESHOLD_S - FRESH_THRESHOLD_S));
  }
  if (ageS <= STALE_THRESHOLD_S) {
    return lerp(0.7, 0.4, (ageS - ACCEPTABLE_THRESHOLD_S) / (STALE_THRESHOLD_S - ACCEPTABLE_THRESHOLD_S));
  }
  return 0.2;
}

/**
 * NIP support score: does the relay advertise support for relevant NIPs?
 *
 * Score = fraction of RELEVANT_NIPS that are supported.
 * If no NIP data is available, returns neutral (0.5).
 */
function computeNipSupportScore(entry: Nip66RelayData): number {
  if (entry.supportedNips.length === 0) return NEUTRAL_SCORE;

  const supported = new Set(entry.supportedNips);
  let matches = 0;
  for (const nip of RELEVANT_NIPS) {
    if (supported.has(nip)) matches++;
  }

  return matches / RELEVANT_NIPS.size;
}

// ---- Utility ----

/** Linear interpolation between a and b. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}
