/**
 * Phase 2: NIP-11 + WebSocket connect + RTT probing.
 *
 * Measures per-relay latency in three layers:
 * 1. NIP-11 HTTP probe — cheapest, no WebSocket needed
 * 2. WebSocket connect — DNS + TCP + TLS + WS upgrade
 * 3. Empty-filter RTT — server processing overhead + network RTT
 *
 * Results feed into NIP-66 filtering, Thompson Sampling priors,
 * and EOSE-race grace period calibration.
 */

import type { RelayUrl } from "../types.ts";

// --- Interfaces ---

export interface Nip11Info {
  name?: string;
  description?: string;
  software?: string;
  version?: string;
  supportedNips?: number[];
  paymentRequired?: boolean;
  authRequired?: boolean;
}

export interface ProbeResult {
  relay: RelayUrl;
  /** NIP-11 HTTP probe */
  nip11Available: boolean;
  nip11Ms: number | null;
  nip11Info?: Nip11Info;
  /** WebSocket connect probe */
  connectable: boolean;
  connectMs: number | null;
  /** Empty-filter round-trip probe (time to EOSE on impossible filter) */
  rttMs: number | null;
  /** Combined latency: connectMs (primary) or nip11Ms (fallback) */
  latencyMs: number | null;
  /** Geo-inference from RTT */
  geoHint?: "local" | "regional" | "continental" | "intercontinental";
  error?: string;
}

export interface ProbeOptions {
  /** Concurrency limit for probing. Default 15. */
  concurrency?: number;
  /** HTTP timeout for NIP-11 fetch. Default 5000ms. */
  nip11TimeoutMs?: number;
  /** WebSocket connect timeout. Default 10000ms. */
  connectTimeoutMs?: number;
  /** EOSE timeout for RTT probe. Default 5000ms. */
  rttTimeoutMs?: number;
  /** Skip WebSocket probing (NIP-11 only). Default false. */
  nip11Only?: boolean;
}

// --- Constants ---

const DEFAULT_CONCURRENCY = 15;
const DEFAULT_NIP11_TIMEOUT_MS = 5_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_RTT_TIMEOUT_MS = 5_000;

// --- Helpers ---

function wsToHttp(wsUrl: string): string {
  return wsUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
}

function inferGeo(rttMs: number): ProbeResult["geoHint"] {
  if (rttMs < 50) return "local";
  if (rttMs < 150) return "regional";
  if (rttMs < 300) return "continental";
  return "intercontinental";
}

function parseNip11(doc: Record<string, unknown>): Nip11Info {
  const limitation = doc.limitation as Record<string, unknown> | undefined;
  const supportedNips = Array.isArray(doc.supported_nips)
    ? (doc.supported_nips as unknown[]).filter((n): n is number => typeof n === "number")
    : undefined;

  return {
    name: typeof doc.name === "string" ? doc.name : undefined,
    description: typeof doc.description === "string" ? doc.description : undefined,
    software: typeof doc.software === "string" ? doc.software : undefined,
    version: typeof doc.version === "string" ? doc.version : undefined,
    supportedNips,
    paymentRequired: limitation?.payment_required === true,
    authRequired: limitation?.auth_required === true,
  };
}

// --- Probes ---

/** Probe 1: NIP-11 HTTP fetch */
async function probeNip11(
  relay: RelayUrl,
  timeoutMs: number,
): Promise<{ available: boolean; ms: number; info?: Nip11Info; error?: string }> {
  const httpUrl = wsToHttp(relay);
  const start = performance.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(httpUrl, {
      headers: { Accept: "application/nostr+json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const elapsed = performance.now() - start;

    if (!resp.ok) {
      return { available: false, ms: elapsed };
    }

    const text = await resp.text();
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(text);
    } catch {
      return { available: false, ms: elapsed };
    }

    return { available: true, ms: elapsed, info: parseNip11(doc) };
  } catch (e) {
    const elapsed = performance.now() - start;
    return { available: false, ms: elapsed, error: String(e) };
  }
}

/** Probe 2: WebSocket connect (measure time to open event) */
function probeConnect(
  relay: RelayUrl,
  timeoutMs: number,
): Promise<{ connected: boolean; ms: number; ws?: WebSocket; error?: string }> {
  return new Promise((resolve) => {
    const start = performance.now();
    const timeout = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      resolve({ connected: false, ms: timeoutMs, error: "connect timeout" });
    }, timeoutMs);

    let ws: WebSocket;
    try {
      ws = new WebSocket(relay);
    } catch (e) {
      clearTimeout(timeout);
      resolve({ connected: false, ms: performance.now() - start, error: String(e) });
      return;
    }

    ws.onopen = () => {
      clearTimeout(timeout);
      resolve({ connected: true, ms: performance.now() - start, ws });
    };

    ws.onerror = (e) => {
      clearTimeout(timeout);
      const errMsg = e instanceof ErrorEvent ? e.message : "WebSocket error";
      try { ws.close(); } catch { /* ignore */ }
      resolve({ connected: false, ms: performance.now() - start, error: errMsg });
    };

    ws.onclose = () => {
      clearTimeout(timeout);
      resolve({ connected: false, ms: performance.now() - start, error: "closed before open" });
    };
  });
}

/** Probe 3: Empty-filter RTT (send impossible filter, measure time to EOSE) */
function probeRtt(
  ws: WebSocket,
  timeoutMs: number,
): Promise<{ rttMs: number | null; error?: string }> {
  return new Promise((resolve) => {
    if (ws.readyState !== WebSocket.OPEN) {
      resolve({ rttMs: null, error: "not connected" });
      return;
    }

    const subId = `probe-rtt-${Date.now()}`;
    // Impossible filter: request a specific ID that can't exist
    const filter = { ids: ["0".repeat(64)], limit: 1 };

    const start = performance.now();
    const timeout = setTimeout(() => {
      ws.removeEventListener("message", handler);
      try { ws.send(JSON.stringify(["CLOSE", subId])); } catch { /* ignore */ }
      resolve({ rttMs: null, error: "rtt timeout" });
    }, timeoutMs);

    const handler = (msg: MessageEvent) => {
      try {
        const data = JSON.parse(msg.data);
        if (!Array.isArray(data)) return;
        if (data[0] === "EOSE" && data[1] === subId) {
          clearTimeout(timeout);
          ws.removeEventListener("message", handler);
          try { ws.send(JSON.stringify(["CLOSE", subId])); } catch { /* ignore */ }
          resolve({ rttMs: performance.now() - start });
        } else if (data[0] === "CLOSED" && data[1] === subId) {
          clearTimeout(timeout);
          ws.removeEventListener("message", handler);
          // CLOSED before EOSE still gives us a timing
          resolve({ rttMs: performance.now() - start });
        }
      } catch { /* ignore parse errors */ }
    };

    ws.addEventListener("message", handler);
    ws.send(JSON.stringify(["REQ", subId, filter]));
  });
}

// --- Main probe function ---

/**
 * Probe a single relay: NIP-11, then WebSocket connect + RTT.
 */
export async function probeRelay(
  relay: RelayUrl,
  opts?: ProbeOptions,
): Promise<ProbeResult> {
  const nip11Timeout = opts?.nip11TimeoutMs ?? DEFAULT_NIP11_TIMEOUT_MS;
  const connectTimeout = opts?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const rttTimeout = opts?.rttTimeoutMs ?? DEFAULT_RTT_TIMEOUT_MS;
  const nip11Only = opts?.nip11Only ?? false;

  const result: ProbeResult = {
    relay,
    nip11Available: false,
    nip11Ms: null,
    connectable: false,
    connectMs: null,
    rttMs: null,
    latencyMs: null,
  };

  // 1. NIP-11 probe
  const nip11 = await probeNip11(relay, nip11Timeout);
  result.nip11Available = nip11.available;
  result.nip11Ms = nip11.ms;
  if (nip11.info) result.nip11Info = nip11.info;

  if (nip11Only) {
    result.latencyMs = nip11.available ? nip11.ms : null;
    return result;
  }

  // 2. WebSocket connect probe
  const conn = await probeConnect(relay, connectTimeout);
  result.connectable = conn.connected;
  result.connectMs = conn.ms;

  if (!conn.connected || !conn.ws) {
    result.error = conn.error;
    result.latencyMs = nip11.available ? nip11.ms : null;
    return result;
  }

  // 3. RTT probe (reuse the open WebSocket)
  const rtt = await probeRtt(conn.ws, rttTimeout);
  result.rttMs = rtt.rttMs;
  if (rtt.error) result.error = rtt.error;

  // Close the WebSocket
  try { conn.ws.close(); } catch { /* ignore */ }

  // Derive combined latency and geo hint
  result.latencyMs = conn.ms;
  if (rtt.rttMs != null) {
    result.geoHint = inferGeo(rtt.rttMs);
  }

  return result;
}

/**
 * Probe multiple relays with concurrency control.
 */
export async function probeRelays(
  relays: RelayUrl[],
  opts?: ProbeOptions,
): Promise<ProbeResult[]> {
  const concurrency = opts?.concurrency ?? DEFAULT_CONCURRENCY;
  const results: ProbeResult[] = [];
  const queue = [...relays];

  async function worker() {
    while (queue.length > 0) {
      const relay = queue.shift()!;
      results.push(await probeRelay(relay, opts));
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, relays.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

/**
 * Print a probe results summary table to console.
 */
export function printProbeTable(results: ProbeResult[]): void {
  const connected = results.filter((r) => r.connectable);
  const nip11Ok = results.filter((r) => r.nip11Available);
  const withRtt = results.filter((r) => r.rttMs != null);

  console.log(`\n=== Relay Probe Results ===`);
  console.log(
    `Probed: ${results.length} | Connectable: ${connected.length}` +
    ` | NIP-11: ${nip11Ok.length} | RTT measured: ${withRtt.length}`,
  );

  if (connected.length === 0) {
    console.log("  No connectable relays.");
    return;
  }

  // Sort by connectMs
  const sorted = [...connected].sort((a, b) => (a.connectMs ?? Infinity) - (b.connectMs ?? Infinity));

  const fmtMs = (ms: number | null) => ms != null ? `${ms.toFixed(0)}ms` : "N/A";
  const pad = (s: string, w: number, align: "left" | "right" = "right") =>
    align === "left" ? s.padEnd(w) : s.padStart(w);

  const headers = ["Relay", "Connect", "RTT", "NIP-11", "Geo", "NIPs"];
  const widths = [40, 8, 8, 8, 16, 20];

  console.log("");
  console.log(
    `  ${headers.map((h, i) => pad(h, widths[i], i === 0 ? "left" : i < 4 ? "right" : "left")).join(" | ")}`,
  );
  console.log(`  ${widths.map((w) => "-".repeat(w)).join("-+-")}`);

  for (const r of sorted) {
    const relayShort = r.relay.replace(/^wss:\/\//, "").slice(0, widths[0]);
    const nips = r.nip11Info?.supportedNips?.join(",") ?? "";
    const row = [
      pad(relayShort, widths[0], "left"),
      pad(fmtMs(r.connectMs), widths[1]),
      pad(fmtMs(r.rttMs), widths[2]),
      pad(fmtMs(r.nip11Ms), widths[3]),
      pad(r.geoHint ?? "N/A", widths[4], "left"),
      pad(nips.slice(0, widths[5]), widths[5], "left"),
    ].join(" | ");
    console.log(`  ${row}`);
  }

  // Geo distribution summary
  const geoCounts = new Map<string, number>();
  for (const r of connected) {
    const geo = r.geoHint ?? "unknown";
    geoCounts.set(geo, (geoCounts.get(geo) ?? 0) + 1);
  }
  console.log("");
  console.log(
    `  Geo distribution: ${[...geoCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([g, c]) => `${g}=${c}`)
      .join(", ")}`,
  );

  // Latency percentiles
  const connectTimes = connected.map((r) => r.connectMs!).sort((a, b) => a - b);
  const rttTimes = withRtt.map((r) => r.rttMs!).sort((a, b) => a - b);
  const pctile = (arr: number[], p: number) =>
    arr.length > 0 ? arr[Math.floor((arr.length - 1) * p)] : null;

  console.log(
    `  Connect latency: p50=${fmtMs(pctile(connectTimes, 0.5))}` +
    ` p80=${fmtMs(pctile(connectTimes, 0.8))}` +
    ` p95=${fmtMs(pctile(connectTimes, 0.95))}` +
    ` max=${fmtMs(pctile(connectTimes, 1.0))}`,
  );
  if (rttTimes.length > 0) {
    console.log(
      `  RTT latency:     p50=${fmtMs(pctile(rttTimes, 0.5))}` +
      ` p80=${fmtMs(pctile(rttTimes, 0.8))}` +
      ` p95=${fmtMs(pctile(rttTimes, 0.95))}` +
      ` max=${fmtMs(pctile(rttTimes, 1.0))}`,
    );
  }
}
