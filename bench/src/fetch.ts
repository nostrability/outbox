import { nip19 } from "@nostr/tools";
const { decode: nip19Decode } = nip19;
import { normalizeRelayUrl, filterRelayUrl } from "./normalize.ts";
import type {
  BenchmarkInput,
  FetchMeta,
  FilterProfile,
  FilteredUrlReport,
  Pubkey,
  PubkeyRelayList,
  RelayUrl,
} from "./types.ts";

const BATCH_SIZE = 200;
const EOSE_TIMEOUT_MS = 15000;
const CONNECT_TIMEOUT_MS = 10000;

const DEFAULT_INDEXERS = [
  "wss://purplepag.es",
  "wss://relay.damus.io",
  "wss://nos.lol",
];

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

// --- npub/hex conversion ---

export function npubToHex(input: string): string | null {
  if (/^[a-f0-9]{64}$/.test(input)) return input;
  try {
    const decoded = nip19Decode(input);
    if (decoded.type === "npub") return decoded.data as string;
    return null;
  } catch {
    return null;
  }
}

// --- Follows file loading ---

export async function loadFollowsFile(path: string): Promise<Pubkey[]> {
  const raw = await Deno.readTextFile(path);
  const trimmed = raw.trim();

  // Try JSON first
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed) as string[];
      return parseFollowsList(arr);
    } catch {
      // fall through to line-by-line
    }
  }

  // Line-by-line
  const lines = trimmed.split("\n").map((l) => l.trim()).filter((l) => l);
  return parseFollowsList(lines);
}

function parseFollowsList(entries: string[]): Pubkey[] {
  const seen = new Set<Pubkey>();
  const result: Pubkey[] = [];
  let skipped = 0;

  for (const entry of entries) {
    const hex = npubToHex(entry);
    if (!hex) {
      skipped++;
      console.error(`[follows] Skipping invalid entry: ${entry.slice(0, 20)}...`);
      continue;
    }
    if (seen.has(hex)) continue;
    seen.add(hex);
    result.push(hex);
  }

  if (skipped > 0) {
    console.error(`[follows] Skipped ${skipped} invalid entries`);
  }
  return result;
}

// --- WebSocket relay client ---

export interface RelayConnection {
  url: string;
  ws: WebSocket;
  events: NostrEvent[];
  uniquePubkeys: Set<string>;
  errors: string[];
  connectTimeMs: number;
}

export function connectToRelay(url: string): Promise<RelayConnection> {
  return new Promise((resolve) => {
    const start = performance.now();
    const conn: RelayConnection = {
      url,
      ws: null!,
      events: [],
      uniquePubkeys: new Set(),
      errors: [],
      connectTimeMs: 0,
    };

    const timeout = setTimeout(() => {
      conn.errors.push("Connection timeout");
      conn.connectTimeMs = CONNECT_TIMEOUT_MS;
      resolve(conn);
    }, CONNECT_TIMEOUT_MS);

    try {
      const ws = new WebSocket(url);
      conn.ws = ws;

      ws.onopen = () => {
        clearTimeout(timeout);
        conn.connectTimeMs = performance.now() - start;
      };

      ws.onerror = (e) => {
        clearTimeout(timeout);
        conn.errors.push(`WebSocket error: ${e instanceof ErrorEvent ? e.message : "unknown"}`);
        conn.connectTimeMs = performance.now() - start;
        resolve(conn);
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        if (conn.connectTimeMs === 0) {
          conn.connectTimeMs = performance.now() - start;
        }
        resolve(conn);
      };

      // We'll resolve once connected; the caller manages subscriptions
      // But if onopen fires, we don't resolve yet — the caller will
      // Actually, let's resolve immediately on open so caller can subscribe
      ws.addEventListener("open", () => resolve(conn), { once: true });
    } catch (err) {
      clearTimeout(timeout);
      conn.errors.push(`Failed to create WebSocket: ${err}`);
      resolve(conn);
    }
  });
}

export function subscribeAndCollect(
  conn: RelayConnection,
  subId: string,
  filter: Record<string, unknown>,
): Promise<NostrEvent[]> {
  return new Promise((resolve) => {
    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
      resolve([]);
      return;
    }

    const events: NostrEvent[] = [];
    const timeout = setTimeout(() => {
      conn.ws.removeEventListener("message", handler);
      conn.ws.send(JSON.stringify(["CLOSE", subId]));
      resolve(events);
    }, EOSE_TIMEOUT_MS);

    const handler = (msg: MessageEvent) => {
      try {
        const data = JSON.parse(msg.data);
        if (Array.isArray(data)) {
          if (data[0] === "EVENT" && data[1] === subId && data[2]) {
            const event = data[2] as NostrEvent;
            events.push(event);
            conn.events.push(event);
            conn.uniquePubkeys.add(event.pubkey);
          } else if (data[0] === "EOSE" && data[1] === subId) {
            clearTimeout(timeout);
            conn.ws.removeEventListener("message", handler);
            conn.ws.send(JSON.stringify(["CLOSE", subId]));
            resolve(events);
          }
        }
      } catch {
        // ignore parse errors
      }
    };

    conn.ws.addEventListener("message", handler);
    conn.ws.send(JSON.stringify(["REQ", subId, filter]));
  });
}

export function closeRelay(conn: RelayConnection): void {
  try {
    if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.close();
    }
  } catch {
    // ignore
  }
}

// --- Main fetch logic ---

export async function fetchBenchmarkInput(opts: {
  targetPubkey: Pubkey;
  followsFile?: string;
  indexerRelays?: string[];
  filterProfile: FilterProfile;
}): Promise<BenchmarkInput> {
  const indexerRelays = opts.indexerRelays?.length
    ? opts.indexerRelays
    : DEFAULT_INDEXERS;

  // Step 1: Connect to indexer relays
  console.error(`[fetch] Connecting to ${indexerRelays.length} indexer relays...`);
  const connections: RelayConnection[] = [];
  for (const url of indexerRelays) {
    const conn = await connectToRelay(url);
    connections.push(conn);
    if (conn.errors.length) {
      console.error(`[fetch] ${url}: ${conn.errors.join(", ")}`);
    } else {
      console.error(`[fetch] ${url}: connected (${Math.round(conn.connectTimeMs)}ms)`);
    }
  }

  const activeConns = connections.filter(
    (c) => c.ws && c.ws.readyState === WebSocket.OPEN,
  );
  if (activeConns.length === 0) {
    throw new Error("Failed to connect to any indexer relay");
  }

  // Step 2: Get follow list
  let follows: Pubkey[];
  if (opts.followsFile) {
    console.error(`[fetch] Loading follows from file: ${opts.followsFile}`);
    follows = await loadFollowsFile(opts.followsFile);
  } else {
    console.error(`[fetch] Fetching kind 3 (contact list) for ${opts.targetPubkey.slice(0, 8)}...`);
    follows = await fetchFollows(activeConns, opts.targetPubkey);
  }

  if (follows.length === 0) {
    console.error("[fetch] 0 follows found. Nothing to analyze.");
    for (const conn of connections) closeRelay(conn);
    return emptyInput(opts.targetPubkey, indexerRelays, opts.filterProfile);
  }

  console.error(`[fetch] ${follows.length} follows to fetch relay lists for`);

  // Step 3: Batch-fetch kind 10002 for all follows
  const relayListEvents = await fetchRelayLists(activeConns, follows);
  console.error(`[fetch] Received ${relayListEvents.size} relay list events`);

  // Step 4: Close connections
  for (const conn of connections) closeRelay(conn);

  // Step 5: Parse relay lists with filtering
  const filteredUrlReport: FilteredUrlReport = {
    localhost: [],
    ipAddress: [],
    insecureWs: [],
    knownBad: [],
    malformed: [],
    totalRemoved: 0,
  };

  const relayLists = new Map<Pubkey, PubkeyRelayList>();
  const followsMissingRelayList: Pubkey[] = [];
  let followsFilteredToEmpty = 0;
  const followsSet = new Set(follows);

  for (const pubkey of follows) {
    const event = relayListEvents.get(pubkey);
    if (!event) {
      followsMissingRelayList.push(pubkey);
      continue;
    }

    const { writeRelays, readRelays, filtered } = parseRelayListEvent(
      event,
      opts.filterProfile,
    );

    // Accumulate filtered URL report
    for (const reason of [
      "localhost",
      "ipAddress",
      "insecureWs",
      "knownBad",
      "malformed",
    ] as const) {
      filteredUrlReport[reason].push(...filtered[reason]);
    }
    filteredUrlReport.totalRemoved += filtered.totalRemoved;

    if (writeRelays.length === 0) {
      followsMissingRelayList.push(pubkey);
      followsFilteredToEmpty++;
      continue;
    }

    relayLists.set(pubkey, {
      pubkey,
      writeRelays,
      readRelays,
      eventCreatedAt: event.created_at,
    });
  }

  // Build algorithm input maps
  const relayToWriters = new Map<RelayUrl, Set<Pubkey>>();
  const writerToRelays = new Map<Pubkey, Set<RelayUrl>>();

  for (const [pubkey, rl] of relayLists) {
    const relays = new Set<RelayUrl>(rl.writeRelays);
    writerToRelays.set(pubkey, relays);
    for (const relay of relays) {
      const writers = relayToWriters.get(relay) ?? new Set<Pubkey>();
      writers.add(pubkey);
      relayToWriters.set(relay, writers);
    }
  }

  const followsWithRelayList = follows.length - followsMissingRelayList.length;
  const missingRate = followsMissingRelayList.length / follows.length;

  const fetchMeta: FetchMeta = {
    indexerRelays,
    perRelayStats: {},
    totalFollows: follows.length,
    followsWithRelayList,
    followsMissingRelayList: followsMissingRelayList.length,
    followsFilteredToEmpty,
    missingRate,
    filteredUrls: filteredUrlReport,
    filterProfile: opts.filterProfile,
  };

  for (const conn of connections) {
    fetchMeta.perRelayStats[conn.url] = {
      eventsReceived: conn.events.length,
      uniquePubkeysCovered: conn.uniquePubkeys.size,
      connectionTimeMs: Math.round(conn.connectTimeMs),
      errors: conn.errors,
    };
  }

  return {
    targetPubkey: opts.targetPubkey,
    follows,
    relayLists,
    followsMissingRelayList,
    relayToWriters,
    writerToRelays,
    fetchedAt: Date.now(),
    fetchMeta,
  };
}

async function fetchFollows(
  conns: RelayConnection[],
  targetPubkey: Pubkey,
): Promise<Pubkey[]> {
  const allEvents: NostrEvent[] = [];

  await Promise.all(
    conns.map(async (conn) => {
      const events = await subscribeAndCollect(conn, "follows", {
        kinds: [3],
        authors: [targetPubkey],
        limit: 5,
      });
      allEvents.push(...events);
    }),
  );

  // Find the latest kind 3 event
  const best = resolveBestEvent(allEvents);
  if (!best) return [];

  // Parse p tags
  const follows: Pubkey[] = [];
  const seen = new Set<Pubkey>();
  for (const tag of best.tags) {
    if (tag[0] === "p" && tag[1] && /^[a-f0-9]{64}$/.test(tag[1])) {
      if (!seen.has(tag[1])) {
        seen.add(tag[1]);
        follows.push(tag[1]);
      }
    }
  }

  return follows;
}

async function fetchRelayLists(
  conns: RelayConnection[],
  pubkeys: Pubkey[],
): Promise<Map<Pubkey, NostrEvent>> {
  const bestEvents = new Map<Pubkey, NostrEvent>();

  // Batch in groups of BATCH_SIZE
  for (let i = 0; i < pubkeys.length; i += BATCH_SIZE) {
    const batch = pubkeys.slice(i, i + BATCH_SIZE);
    const subId = `rl-${i}`;

    const batchEvents: NostrEvent[] = [];
    await Promise.all(
      conns.map(async (conn) => {
        const events = await subscribeAndCollect(conn, subId, {
          kinds: [10002],
          authors: batch,
        });
        batchEvents.push(...events);
      }),
    );

    // Resolve best event per pubkey
    for (const event of batchEvents) {
      const existing = bestEvents.get(event.pubkey);
      if (!existing || isBetter(event, existing)) {
        bestEvents.set(event.pubkey, event);
      }
    }

    if (i + BATCH_SIZE < pubkeys.length) {
      console.error(
        `[fetch] Fetched relay lists: ${Math.min(i + BATCH_SIZE, pubkeys.length)}/${pubkeys.length}`,
      );
    }
  }

  return bestEvents;
}

function resolveBestEvent(events: NostrEvent[]): NostrEvent | null {
  if (events.length === 0) return null;
  return events.reduce((best, event) =>
    isBetter(event, best) ? event : best
  );
}

function isBetter(candidate: NostrEvent, current: NostrEvent): boolean {
  if (candidate.created_at > current.created_at) return true;
  if (candidate.created_at === current.created_at) {
    return candidate.id < current.id; // lexicographically lower id wins
  }
  return false;
}

function parseRelayListEvent(
  event: NostrEvent,
  filterProfile: FilterProfile,
): {
  writeRelays: RelayUrl[];
  readRelays: RelayUrl[];
  filtered: FilteredUrlReport;
} {
  const writeRelays: RelayUrl[] = [];
  const readRelays: RelayUrl[] = [];
  const writeSeen = new Set<RelayUrl>();
  const readSeen = new Set<RelayUrl>();
  const filtered: FilteredUrlReport = {
    localhost: [],
    ipAddress: [],
    insecureWs: [],
    knownBad: [],
    malformed: [],
    totalRemoved: 0,
  };

  for (const tag of event.tags) {
    if (tag[0] !== "r" || !tag[1]) continue;

    const rawUrl = tag[1];
    const marker = tag[2]?.toLowerCase();
    const result = filterRelayUrl(rawUrl, filterProfile);

    if (!result.accepted) {
      filtered.totalRemoved++;
      if (result.reason) {
        filtered[result.reason].push(result.originalUrl);
      }
      continue;
    }

    const url = result.url;

    // Per NIP-65: no marker = both read and write
    const isWrite = !marker || marker === "write";
    const isRead = !marker || marker === "read";

    if (isWrite && !writeSeen.has(url)) {
      writeSeen.add(url);
      writeRelays.push(url);
    }
    if (isRead && !readSeen.has(url)) {
      readSeen.add(url);
      readRelays.push(url);
    }
  }

  return { writeRelays, readRelays, filtered };
}

function emptyInput(
  targetPubkey: Pubkey,
  indexerRelays: string[],
  filterProfile: FilterProfile,
): BenchmarkInput {
  return {
    targetPubkey,
    follows: [],
    relayLists: new Map(),
    followsMissingRelayList: [],
    relayToWriters: new Map(),
    writerToRelays: new Map(),
    fetchedAt: Date.now(),
    fetchMeta: {
      indexerRelays,
      perRelayStats: {},
      totalFollows: 0,
      followsWithRelayList: 0,
      followsMissingRelayList: 0,
      followsFilteredToEmpty: 0,
      missingRate: 0,
      filteredUrls: {
        localhost: [],
        ipAddress: [],
        insecureWs: [],
        knownBad: [],
        malformed: [],
        totalRemoved: 0,
      },
      filterProfile,
    },
  };
}
