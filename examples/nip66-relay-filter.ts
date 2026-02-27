/**
 * NIP-66 Relay Liveness Filter — Standalone Example
 *
 * Fetches relay monitor data (kind 30166) and filters dead relays from a
 * candidate set BEFORE running any relay selection algorithm.
 *
 * Measured impact (from outbox benchmarks):
 *   - 39% faster feed loads (dead relays each burn a 15s timeout)
 *   - 40-66% of declared relays are typically dead
 *   - Relay success rate: ~30% unfiltered → ~75-87% filtered
 *
 * Usage:
 *   deno run --allow-net examples/nip66-relay-filter.ts
 *
 * Drop-in integration:
 *   const alive = await fetchAliveRelays();
 *   const filtered = candidateRelays.filter(r => alive.has(r));
 *   // ... run relay selection on `filtered` instead of `candidateRelays`
 */

// -- Config --

const MONITOR_RELAYS = [
  "wss://relaypag.es",
  "wss://relay.nostr.watch",
];

const EOSE_TIMEOUT_MS = 8000;
const CONNECT_TIMEOUT_MS = 5000;

// -- Core: fetch alive relay set --

export async function fetchAliveRelays(): Promise<Set<string>> {
  const alive = new Set<string>();

  // Source 1: NIP-66 kind 30166 events from monitor relays (parallel)
  const results = await Promise.allSettled(
    MONITOR_RELAYS.map((monitorUrl) => fetchKind30166(monitorUrl)),
  );
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      for (const url of result.value) alive.add(url);
    } else {
      console.warn(`[nip66] ${MONITOR_RELAYS[i]}: ${result.reason}`);
    }
  }

  // Source 2: nostr.watch HTTP API (fallback if Nostr fetch returned nothing)
  if (alive.size === 0) {
    try {
      const relays = await fetchNostrWatchApi();
      for (const url of relays) alive.add(url);
    } catch (err) {
      console.warn(`[nip66] HTTP API fallback: ${err}`);
    }
  }

  return alive;
}

// -- Fetch kind 30166 from a single relay --

function fetchKind30166(relayUrl: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const relays: string[] = [];
    const since = Math.floor(Date.now() / 1000) - 86400 * 7; // last 7 days
    const subId = "nip66-" + Math.random().toString(36).slice(2, 8);
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) { settled = true; ws.close(); resolve(relays); }
    }, EOSE_TIMEOUT_MS);

    let ws: WebSocket;
    try {
      ws = new WebSocket(relayUrl);
    } catch (err) {
      clearTimeout(timer);
      return reject(err);
    }

    const connectTimer = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        settled = true; clearTimeout(timer); ws.close();
        reject(new Error("connect timeout"));
      }
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      clearTimeout(connectTimer);
      // REQ for kind 30166 (relay monitor reports)
      ws.send(JSON.stringify(["REQ", subId, { kinds: [30166], since, limit: 5000 }]));
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string);
        if (msg[0] === "EVENT" && msg[1] === subId) {
          const event = msg[2];
          // Extract relay URL from "d" tag
          const dTag = event.tags?.find((t: string[]) => t[0] === "d");
          if (dTag?.[1]) {
            const normalized = normalizeUrl(dTag[1]);
            if (normalized) relays.push(normalized);
          }
        } else if (msg[0] === "EOSE" && msg[1] === subId) {
          if (!settled) { settled = true; clearTimeout(timer); ws.close(); resolve(relays); }
        }
      } catch { /* ignore parse errors */ }
    };

    ws.onerror = () => {
      if (!settled) { settled = true; clearTimeout(timer); clearTimeout(connectTimer); reject(new Error("ws error")); }
    };
    ws.onclose = () => {
      if (!settled) { settled = true; clearTimeout(timer); clearTimeout(connectTimer); resolve(relays); }
    };
  });
}

// -- HTTP API fallback --

async function fetchNostrWatchApi(): Promise<string[]> {
  const resp = await fetch("https://api.nostr.watch/v1/online", {
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const urls = (await resp.json()) as string[];
  return urls.map(normalizeUrl).filter((u): u is string => u !== null);
}

// -- URL normalization --

function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "wss:" && url.protocol !== "ws:") return null;
    // Lowercase host, strip trailing slash
    return `${url.protocol}//${url.hostname}${url.port ? ":" + url.port : ""}${url.pathname.replace(/\/+$/, "") || ""}`;
  } catch {
    return null;
  }
}

// -- Filter helper --

export function filterDeadRelays(
  candidates: string[],
  alive: Set<string>,
): { kept: string[]; removed: string[] } {
  const kept: string[] = [];
  const removed: string[] = [];
  for (const relay of candidates) {
    const normalized = normalizeUrl(relay);
    if (normalized && alive.has(normalized)) {
      kept.push(relay);
    } else {
      removed.push(relay);
    }
  }
  return { kept, removed };
}

// -- Demo --

if (import.meta.main) {
  console.log("Fetching NIP-66 relay liveness data...\n");

  const alive = await fetchAliveRelays();
  console.log(`Found ${alive.size} alive relays from NIP-66 monitors.\n`);

  // Example: filter a candidate set
  const exampleCandidates = [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.nostr.band",
    "wss://probably-dead-relay.example.com",
  ];

  const { kept, removed } = filterDeadRelays(exampleCandidates, alive);
  console.log(`Candidates: ${exampleCandidates.length}`);
  console.log(`  Kept (alive): ${kept.length} — ${kept.join(", ")}`);
  console.log(`  Removed (dead/unknown): ${removed.length} — ${removed.join(", ")}`);
}
