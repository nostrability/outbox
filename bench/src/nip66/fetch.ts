/**
 * NIP-66 (kind 30166) relay monitor data fetcher.
 *
 * Fetches relay liveness/quality data from:
 * 1. Nostr relays via kind 30166 events (primary)
 * 2. nostr.watch HTTP API (fallback)
 * 3. Synthetic scores from benchmark observations (last resort)
 *
 * NIP-66 spec: https://github.com/nostr-protocol/nips/blob/master/66.md
 */

import {
  connectToRelay,
  subscribeAndCollect,
  closeRelay,
} from "../fetch.ts";
import type { NostrEvent } from "../fetch.ts";
import { normalizeRelayUrl } from "../normalize.ts";
import type {
  Nip66RelayData,
  Nip66CacheEnvelope,
  Nip66RelayDataSerialized,
  RelayUrl,
} from "../types.ts";

const NIP66_CACHE_DIR = ".cache";
const NIP66_CACHE_FILE = "nip66_relay_data.json";
const NIP66_MONITOR_CACHE_FILE = "nip66_monitor_data.json";
const NIP66_SCHEMA_VERSION = 1;
const NIP66_TTL_MS = 3600 * 1000; // 1 hour

/** Well-known relays that carry kind 30166 events (per nostr.watch dev). */
const NIP66_SOURCE_RELAYS = [
  "wss://relaypag.es",
  "wss://relay.nostr.watch",
  "wss://monitorlizard.nostr1.com",
];

// ---- Cache ----

async function ensureCacheDir(): Promise<void> {
  await Deno.mkdir(NIP66_CACHE_DIR, { recursive: true });
}

function cachePath(): string {
  return `${NIP66_CACHE_DIR}/${NIP66_CACHE_FILE}`;
}

export async function readNip66Cache(): Promise<Map<RelayUrl, Nip66RelayData> | null> {
  try {
    const raw = await Deno.readTextFile(cachePath());
    const envelope = JSON.parse(raw) as Nip66CacheEnvelope;

    if (envelope.schemaVersion !== NIP66_SCHEMA_VERSION) return null;

    const age = Date.now() - envelope.fetchedAt;
    if (age > NIP66_TTL_MS) return null;

    const map = new Map<RelayUrl, Nip66RelayData>();
    for (const entry of envelope.relays) {
      map.set(entry.relayUrl, entry);
    }
    return map;
  } catch {
    return null;
  }
}

export async function writeNip66Cache(
  data: Map<RelayUrl, Nip66RelayData>,
  source: "nostr" | "http-api" | "synthetic",
): Promise<void> {
  await ensureCacheDir();
  const serialized: Nip66RelayDataSerialized[] = [];
  for (const entry of data.values()) {
    serialized.push({
      relayUrl: entry.relayUrl,
      rttOpenMs: entry.rttOpenMs,
      rttReadMs: entry.rttReadMs,
      rttWriteMs: entry.rttWriteMs,
      supportedNips: entry.supportedNips,
      network: entry.network,
      lastSeenAt: entry.lastSeenAt,
      monitorPubkey: entry.monitorPubkey,
    });
  }

  const envelope: Nip66CacheEnvelope = {
    schemaVersion: NIP66_SCHEMA_VERSION,
    fetchedAt: Date.now(),
    ttlSeconds: NIP66_TTL_MS / 1000,
    source,
    relays: serialized,
  };
  await Deno.writeTextFile(cachePath(), JSON.stringify(envelope, null, 2));
}

// ---- Monitor cache (excludes synthetic data) ----

export function monitorCachePath(cacheDir = NIP66_CACHE_DIR): string {
  return `${cacheDir}/${NIP66_MONITOR_CACHE_FILE}`;
}

export async function readNip66MonitorCache(
  cacheDir = NIP66_CACHE_DIR,
  ttlMs = NIP66_TTL_MS,
): Promise<Map<RelayUrl, Nip66RelayData> | null> {
  try {
    const raw = await Deno.readTextFile(monitorCachePath(cacheDir));
    const envelope = JSON.parse(raw) as Nip66CacheEnvelope;

    if (envelope.schemaVersion !== NIP66_SCHEMA_VERSION) return null;
    if (envelope.source === "synthetic") return null; // defense-in-depth

    const age = Date.now() - envelope.fetchedAt;
    if (age > ttlMs) return null;

    const map = new Map<RelayUrl, Nip66RelayData>();
    for (const entry of envelope.relays) {
      if (entry.monitorPubkey === "synthetic") continue; // defense-in-depth
      map.set(entry.relayUrl, entry);
    }
    return map;
  } catch {
    return null;
  }
}

export async function writeNip66MonitorCache(
  data: Map<RelayUrl, Nip66RelayData>,
  source: "nostr" | "http-api",
  cacheDir = NIP66_CACHE_DIR,
): Promise<void> {
  await Deno.mkdir(cacheDir, { recursive: true });
  const serialized: Nip66RelayDataSerialized[] = [];
  for (const entry of data.values()) {
    if (entry.monitorPubkey === "synthetic") continue;
    serialized.push({
      relayUrl: entry.relayUrl,
      rttOpenMs: entry.rttOpenMs,
      rttReadMs: entry.rttReadMs,
      rttWriteMs: entry.rttWriteMs,
      supportedNips: entry.supportedNips,
      network: entry.network,
      lastSeenAt: entry.lastSeenAt,
      monitorPubkey: entry.monitorPubkey,
    });
  }

  const envelope: Nip66CacheEnvelope = {
    schemaVersion: NIP66_SCHEMA_VERSION,
    fetchedAt: Date.now(),
    ttlSeconds: NIP66_TTL_MS / 1000,
    source,
    relays: serialized,
  };
  await Deno.writeTextFile(
    monitorCachePath(cacheDir),
    JSON.stringify(envelope, null, 2),
  );
}

/**
 * Fetch NIP-66 monitor data for liveness filtering.
 * Combines NIP-66 kind 30166/1066 events with the nostr.watch HTTP API.
 * NIP-66 events take priority (have RTT data); HTTP API fills gaps.
 *
 * Returns a merged map. If both sources fail, returns empty map (caller skips filter).
 */
export async function fetchNip66MonitorData(
  ttlMs?: number,
): Promise<Map<RelayUrl, Nip66RelayData>> {
  // 1. Try monitor cache (rejects synthetic)
  const cached = await readNip66MonitorCache(NIP66_CACHE_DIR, ttlMs ?? NIP66_TTL_MS);
  if (cached && cached.size > 0) {
    console.error(`[nip66] Using cached monitor data (${cached.size} relays)`);
    return cached;
  }

  // 2. Fetch from Nostr (kind 30166+1066)
  const nostrData = await fetchFromNostrRelays();

  // 3. Fetch HTTP API online list and merge
  const httpData = await fetchFromHttpApi();

  // Merge: NIP-66 events take priority (richer data), HTTP API fills gaps
  const merged = new Map(nostrData);
  let httpOnly = 0;
  for (const [url, entry] of httpData) {
    if (!merged.has(url)) {
      merged.set(url, entry);
      httpOnly++;
    }
  }

  if (nostrData.size > 0 || httpData.size > 0) {
    console.error(
      `[nip66] Fetched NIP-66 data for ${nostrData.size} relays via Nostr` +
        (httpOnly > 0 ? ` + ${httpOnly} via HTTP API (${merged.size} total)` : ""),
    );
    const source = nostrData.size > 0 ? "nostr" : "http-api" as const;
    await writeNip66MonitorCache(merged, source).catch((e) =>
      console.error(`[nip66] Monitor cache write failed: ${e}`),
    );
  }

  return merged;
}

// ---- Parse kind 30166 events ----

function parseNip66Event(event: NostrEvent): Nip66RelayData | null {
  // The "d" tag contains the relay URL
  let relayUrl: string | null = null;
  let rttOpenMs: number | null = null;
  let rttReadMs: number | null = null;
  let rttWriteMs: number | null = null;
  const supportedNips: number[] = [];
  let network: string | null = null;

  for (const tag of event.tags) {
    switch (tag[0]) {
      case "d":
        relayUrl = tag[1] ?? null;
        break;
      case "rtt-open": {
        const v = tag[1] ? parseInt(tag[1], 10) : NaN;
        rttOpenMs = isNaN(v) || v < 0 ? null : v;
        break;
      }
      case "rtt-read": {
        const v = tag[1] ? parseInt(tag[1], 10) : NaN;
        rttReadMs = isNaN(v) || v < 0 ? null : v;
        break;
      }
      case "rtt-write": {
        const v = tag[1] ? parseInt(tag[1], 10) : NaN;
        rttWriteMs = isNaN(v) || v < 0 ? null : v;
        break;
      }
      case "N": {
        const nip = tag[1] ? parseInt(tag[1], 10) : NaN;
        if (!isNaN(nip)) supportedNips.push(nip);
        break;
      }
      case "n":
        network = tag[1] ?? null;
        break;
    }
  }

  if (!relayUrl) return null;

  // Normalize the relay URL
  const normalized = normalizeRelayUrl(relayUrl);
  if (!normalized) return null;

  return {
    relayUrl: normalized,
    rttOpenMs,
    rttReadMs,
    rttWriteMs,
    supportedNips,
    network,
    lastSeenAt: event.created_at,
    monitorPubkey: event.pubkey,
  };
}

// ---- Parse kind 1066 (uptime) events ----

/**
 * Kind 1066 events are undocumented uptime check events used by nostr.watch.
 * They contain a relay URL in the "d" or first "r" tag and serve as a
 * liveness signal (the relay was reachable at event.created_at).
 */
function parseKind1066Event(event: NostrEvent): Nip66RelayData | null {
  let relayUrl: string | null = null;

  for (const tag of event.tags) {
    if ((tag[0] === "d" || tag[0] === "r") && tag[1]) {
      relayUrl = tag[1];
      break;
    }
  }

  if (!relayUrl) return null;
  const normalized = normalizeRelayUrl(relayUrl);
  if (!normalized) return null;

  return {
    relayUrl: normalized,
    rttOpenMs: null,
    rttReadMs: null,
    rttWriteMs: null,
    supportedNips: [],
    network: "clearnet",
    lastSeenAt: event.created_at,
    monitorPubkey: event.pubkey,
  };
}

// ---- Fetch via Nostr (kind 30166) ----

async function fetchFromNostrRelays(): Promise<Map<RelayUrl, Nip66RelayData>> {
  const result = new Map<RelayUrl, Nip66RelayData>();

  console.error(`[nip66] Connecting to ${NIP66_SOURCE_RELAYS.length} relays for kind 30166 events...`);

  for (const relayUrl of NIP66_SOURCE_RELAYS) {
    let conn: Awaited<ReturnType<typeof connectToRelay>> | null = null;
    try {
      conn = await connectToRelay(relayUrl);

      if (conn.errors.length > 0 || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
        console.error(`[nip66] ${relayUrl}: connection failed (${conn.errors.join(", ")})`);
        continue;
      }

      console.error(`[nip66] ${relayUrl}: connected (${Math.round(conn.connectTimeMs)}ms)`);

      // Fetch recent kind 30166 (relay monitor) and kind 1066 (uptime) events.
      const since = Math.floor(Date.now() / 1000) - 86400 * 7; // last 7 days
      const events = await subscribeAndCollect(conn, "nip66", {
        kinds: [30166, 1066],
        since,
        limit: 5000,
      });

      const k30166 = events.filter((e) => e.kind === 30166);
      const k1066 = events.filter((e) => e.kind === 1066);
      console.error(`[nip66] ${relayUrl}: received ${k30166.length} kind 30166 + ${k1066.length} kind 1066 events`);

      for (const event of k30166) {
        const parsed = parseNip66Event(event);
        if (!parsed) continue;

        // Keep the most recent event per relay URL
        const existing = result.get(parsed.relayUrl);
        if (!existing || parsed.lastSeenAt > existing.lastSeenAt) {
          result.set(parsed.relayUrl, parsed);
        }
      }

      // Parse kind 1066 uptime events — use as liveness signal
      for (const event of k1066) {
        const parsed = parseKind1066Event(event);
        if (!parsed) continue;
        const existing = result.get(parsed.relayUrl);
        if (!existing) {
          result.set(parsed.relayUrl, parsed);
        } else if (parsed.lastSeenAt > existing.lastSeenAt) {
          // Merge: keep RTT from 30166 if we have it, update lastSeenAt
          existing.lastSeenAt = parsed.lastSeenAt;
        }
      }
    } catch (err) {
      console.error(`[nip66] ${relayUrl}: error - ${err}`);
    } finally {
      if (conn) closeRelay(conn);
    }
  }

  return result;
}

// ---- Fetch via nostr.watch HTTP API (fallback) ----

async function fetchFromHttpApi(): Promise<Map<RelayUrl, Nip66RelayData>> {
  const result = new Map<RelayUrl, Nip66RelayData>();

  try {
    console.error("[nip66] Trying nostr.watch HTTP API fallback...");

    const response = await fetch("https://api.nostr.watch/v1/online", {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      console.error(`[nip66] HTTP API returned ${response.status}`);
      return result;
    }

    const relayUrls = (await response.json()) as string[];
    console.error(`[nip66] HTTP API returned ${relayUrls.length} online relays`);

    const now = Math.floor(Date.now() / 1000);

    for (const rawUrl of relayUrls) {
      const normalized = normalizeRelayUrl(rawUrl);
      if (!normalized) continue;

      result.set(normalized, {
        relayUrl: normalized,
        rttOpenMs: null,
        rttReadMs: null,
        rttWriteMs: null,
        supportedNips: [],
        network: "clearnet",
        lastSeenAt: now,
        monitorPubkey: "http-api",
      });
    }
  } catch (err) {
    console.error(`[nip66] HTTP API fallback failed: ${err}`);
  }

  return result;
}

// ---- Synthetic scores from relay set ----

export function generateSyntheticData(
  relayUrls: Iterable<RelayUrl>,
): Map<RelayUrl, Nip66RelayData> {
  const result = new Map<RelayUrl, Nip66RelayData>();
  const now = Math.floor(Date.now() / 1000);

  for (const url of relayUrls) {
    result.set(url, {
      relayUrl: url,
      rttOpenMs: null,
      rttReadMs: null,
      rttWriteMs: null,
      supportedNips: [],
      network: "clearnet",
      lastSeenAt: now,
      monitorPubkey: "synthetic",
    });
  }

  return result;
}

// ---- Main entry point ----

export async function fetchNip66Data(
  candidateRelays?: Iterable<RelayUrl>,
): Promise<Map<RelayUrl, Nip66RelayData>> {
  // 1. Try cache
  const cached = await readNip66Cache();
  if (cached && cached.size > 0) {
    console.error(`[nip66] Using cached NIP-66 data (${cached.size} relays)`);
    return cached;
  }

  // 2. Try Nostr relays
  let data = await fetchFromNostrRelays();
  if (data.size > 0) {
    console.error(`[nip66] Fetched NIP-66 data for ${data.size} relays via Nostr`);
    await writeNip66Cache(data, "nostr").catch((e) =>
      console.error(`[nip66] Cache write failed: ${e}`)
    );
    return data;
  }

  // 3. Try HTTP API
  data = await fetchFromHttpApi();
  if (data.size > 0) {
    console.error(`[nip66] Fetched data for ${data.size} relays via HTTP API`);
    await writeNip66Cache(data, "http-api").catch((e) =>
      console.error(`[nip66] Cache write failed: ${e}`)
    );
    return data;
  }

  // 4. Synthetic fallback
  if (candidateRelays) {
    data = generateSyntheticData(candidateRelays);
    console.error(`[nip66] Using synthetic data for ${data.size} relays (no live data available)`);
    await writeNip66Cache(data, "synthetic").catch((e) =>
      console.error(`[nip66] Cache write failed: ${e}`)
    );
    return data;
  }

  console.error("[nip66] No NIP-66 data available");
  return new Map();
}
