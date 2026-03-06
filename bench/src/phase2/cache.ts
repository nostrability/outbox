/**
 * Phase 2 baseline disk cache.
 *
 * Persists baseline collection results so that different algorithm runs
 * and filter modes for the same profile + window can reuse the baseline
 * without re-querying relays.
 *
 * Cache key: pubkey_prefix + window + followCount + relayCount
 * TTL: 4 hours (relay state shouldn't change much in a benchmark session)
 */

import type { QueryCache } from "../relay-pool.ts";
import type {
  Pubkey,
  PubkeyBaseline,
  RelayUrl,
} from "../types.ts";

const CACHE_DIR = ".cache";
const SCHEMA_VERSION = 2;
const DEFAULT_TTL_MS = 4 * 3600 * 1000; // 4 hours

interface SerializedBaseline {
  pubkey: Pubkey;
  eventIds: string[];
  /** Per-relay event ID mappings — preserves which relay returned which events. */
  perRelayEventIds: Record<string, string[]>;
  relaysQueried: number;
  relaysSucceeded: string[];
  relaysFailed: string[];
  relaysWithEvents: string[];
  reliability: "reliable" | "partial";
  classification: PubkeyBaseline["classification"];
}

interface Phase2CacheEnvelope {
  schemaVersion: number;
  pubkey: string;
  windowSeconds: number;
  since: number;
  followCount: number;
  relayCount: number;
  fetchedAt: number;
  ttlMs: number;
  relaySuccessRate: number;
  totalRelaysQueried: number;
  totalRelaysSucceeded: number;
  baselines: SerializedBaseline[];
}

function cacheFilePath(
  pubkey: string,
  window: number,
  followCount: number,
  relayCount: number,
): string {
  const prefix = pubkey.slice(0, 16);
  return `${CACHE_DIR}/phase2_${prefix}_${window}_${followCount}_${relayCount}.json`;
}

function serializeBaseline(baseline: PubkeyBaseline, cache: QueryCache): SerializedBaseline {
  // Extract per-relay event IDs from the QueryCache
  const perRelayEventIds: Record<string, string[]> = {};
  for (const relay of baseline.relaysWithEvents) {
    const ids = cache.get(relay, baseline.pubkey);
    if (ids && ids.size > 0) {
      perRelayEventIds[relay] = [...ids];
    }
  }

  return {
    pubkey: baseline.pubkey,
    eventIds: [...baseline.eventIds],
    perRelayEventIds,
    relaysQueried: baseline.relaysQueried,
    relaysSucceeded: [...baseline.relaysSucceeded],
    relaysFailed: [...baseline.relaysFailed],
    relaysWithEvents: [...baseline.relaysWithEvents],
    reliability: baseline.reliability,
    classification: baseline.classification,
  };
}

function deserializeBaseline(s: SerializedBaseline): PubkeyBaseline {
  return {
    pubkey: s.pubkey,
    eventIds: new Set(s.eventIds),
    relaysQueried: s.relaysQueried,
    relaysSucceeded: new Set(s.relaysSucceeded),
    relaysFailed: new Set(s.relaysFailed),
    relaysWithEvents: new Set(s.relaysWithEvents),
    reliability: s.reliability,
    classification: s.classification,
  };
}

export interface Phase2CacheResult {
  baselines: Map<Pubkey, PubkeyBaseline>;
  /** Per-relay event ID mappings for populating the QueryCache accurately. */
  perRelayEventIds: Map<string, Map<string, Set<string>>>; // relay → pubkey → eventIds
}

export async function readPhase2Cache(
  pubkey: string,
  windowSeconds: number,
  followCount: number,
  relayCount: number,
): Promise<Phase2CacheResult | null> {
  const path = cacheFilePath(pubkey, windowSeconds, followCount, relayCount);

  try {
    const raw = await Deno.readTextFile(path);
    const envelope = JSON.parse(raw) as Phase2CacheEnvelope;

    if (envelope.schemaVersion !== SCHEMA_VERSION) {
      console.error(`[phase2-cache] Schema version mismatch (got ${envelope.schemaVersion}, need ${SCHEMA_VERSION}) — re-collecting`);
      return null;
    }

    const age = Date.now() - envelope.fetchedAt;
    if (age > envelope.ttlMs) {
      console.error(`[phase2-cache] Cache expired (${Math.round(age / 60000)}min old)`);
      return null;
    }

    // Warn on low relay success rate
    if (envelope.relaySuccessRate < 0.8) {
      console.error(
        `[phase2-cache] WARNING: cached baseline has ${Math.round(envelope.relaySuccessRate * 100)}% relay success rate ` +
        `(${envelope.totalRelaysSucceeded}/${envelope.totalRelaysQueried}). ` +
        `Some relays may have been unreachable. Use --no-phase2-cache to re-collect.`,
      );
    }

    const baselines = new Map<Pubkey, PubkeyBaseline>();
    const perRelayEventIds = new Map<string, Map<string, Set<string>>>();

    for (const s of envelope.baselines) {
      baselines.set(s.pubkey, deserializeBaseline(s));

      // Reconstruct per-relay event ID mappings
      for (const [relay, ids] of Object.entries(s.perRelayEventIds)) {
        let relayMap = perRelayEventIds.get(relay);
        if (!relayMap) {
          relayMap = new Map();
          perRelayEventIds.set(relay, relayMap);
        }
        relayMap.set(s.pubkey, new Set(ids));
      }
    }

    console.error(
      `[phase2-cache] Using cached baseline (${baselines.size} authors, ` +
      `fetched ${new Date(envelope.fetchedAt).toISOString()})`,
    );
    return { baselines, perRelayEventIds };
  } catch {
    return null;
  }
}

export async function writePhase2Cache(
  pubkey: string,
  windowSeconds: number,
  since: number,
  followCount: number,
  relayCount: number,
  baselines: Map<Pubkey, PubkeyBaseline>,
  cache: QueryCache,
): Promise<void> {
  await Deno.mkdir(CACHE_DIR, { recursive: true });

  // Compute relay success stats
  const relaysSeen = new Set<RelayUrl>();
  let totalQueried = 0;
  let totalSucceeded = 0;
  for (const baseline of baselines.values()) {
    for (const r of baseline.relaysSucceeded) {
      if (!relaysSeen.has(r)) { relaysSeen.add(r); totalQueried++; totalSucceeded++; }
    }
    for (const r of baseline.relaysFailed) {
      if (!relaysSeen.has(r)) { relaysSeen.add(r); totalQueried++; }
    }
  }

  const envelope: Phase2CacheEnvelope = {
    schemaVersion: SCHEMA_VERSION,
    pubkey,
    windowSeconds,
    since,
    followCount,
    relayCount,
    fetchedAt: Date.now(),
    ttlMs: DEFAULT_TTL_MS,
    relaySuccessRate: totalQueried > 0 ? totalSucceeded / totalQueried : 0,
    totalRelaysQueried: totalQueried,
    totalRelaysSucceeded: totalSucceeded,
    baselines: [...baselines.values()].map((b) => serializeBaseline(b, cache)),
  };

  // Write-to-temp-then-rename for crash safety
  const path = cacheFilePath(pubkey, windowSeconds, followCount, relayCount);
  const dir = path.substring(0, path.lastIndexOf("/"));
  const tmp = await Deno.makeTempFile({ dir });
  try {
    await Deno.writeTextFile(tmp, JSON.stringify(envelope));
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
  console.error(`[phase2-cache] Cached baseline to ${path}`);
}
