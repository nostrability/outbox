/**
 * Phase 3: NIP-77 full reconciliation benchmark.
 *
 * After baseline collection, runs negentropy reconciliation against each
 * NIP-77-capable relay to measure bandwidth savings vs traditional REQ.
 *
 * Key insight: the "local set" for relay R is the set of events collected
 * from *other* relays for R's pubkeys. This represents what a client would
 * already have before syncing from R.
 */

// @ts-ignore vendored negentropy is @ts-nocheck
import { Negentropy, NegentropyStorageVector } from "../negentropy.ts";
import { QueryCache, Semaphore } from "../relay-pool.ts";
import type { RelayOutcome } from "../relay-pool.ts";
import type {
  BenchmarkInput,
  Nip77ReconcileReport,
  Pubkey,
  RelayReconcileResult,
  RelayUrl,
} from "../types.ts";
import { meanOf } from "../types.ts";

const PER_ROUND_TIMEOUT_MS = 10_000;

/**
 * Run NIP-77 reconciliation against all relays in the input.
 */
export async function runNip77Reconciliation(
  input: BenchmarkInput,
  cache: QueryCache,
  relayOutcomes: ReadonlyMap<RelayUrl, RelayOutcome>,
  opts: {
    concurrency: number;
    probeResults?: ReadonlyMap<RelayUrl, boolean>;
  },
): Promise<Nip77ReconcileReport> {
  const relays = [...input.relayToWriters.keys()];
  const results: RelayReconcileResult[] = [];
  const sem = new Semaphore(opts.concurrency);

  // Filter to relays we know support NIP-77 (from probing)
  const candidateRelays = opts.probeResults
    ? relays.filter((r) => opts.probeResults!.get(r) === true)
    : relays;

  console.error(
    `\n=== NIP-77 Reconciliation: ${candidateRelays.length} relays ` +
    `(${relays.length} total, concurrency=${opts.concurrency}) ===`,
  );

  const tasks = candidateRelays.map(async (relay) => {
    await sem.acquire();
    try {
      const result = await reconcileRelay(relay, input, cache, relayOutcomes);
      results.push(result);
      const status = result.supported
        ? `savings=${(result.savingsRatio ?? 0) * 100 | 0}% overlap=${(result.overlapFraction * 100) | 0}%`
        : `failed: ${result.errorCategory ?? result.error ?? "unknown"}`;
      console.error(`  [neg] ${relay.replace(/^wss:\/\//, "")}: ${status}`);
    } catch (err) {
      results.push({
        relay,
        supported: false,
        localSetSize: 0,
        bytesSent: 0,
        bytesReceived: 0,
        negBytesTotal: 0,
        reqBytesReceived: relayOutcomes.get(relay)?.bytesReceived ?? 0,
        roundCount: 0,
        wallClockMs: 0,
        needCount: 0,
        haveCount: 0,
        overlapFraction: 0,
        newEventsBetweenPasses: 0,
        savingsRatio: null,
        error: String(err),
      });
    } finally {
      sem.release();
    }
  });

  await Promise.all(tasks);

  // Build report
  const supported = results.filter((r) => r.supported);
  const failed = results.filter((r) => !r.supported);

  // Aggregate savings across supported relays
  let aggregateSavingsRatio: number | null = null;
  if (supported.length > 0) {
    const totalNegBytes = supported.reduce((s, r) => s + r.negBytesTotal, 0);
    const totalReqBytes = supported.reduce((s, r) => s + r.reqBytesReceived, 0);
    aggregateSavingsRatio = totalReqBytes > 0 ? 1 - totalNegBytes / totalReqBytes : null;
  }

  // Overlap-bucketed breakdown
  const bucketDefs: [string, number, number][] = [
    ["0-25%", 0, 0.25],
    ["25-50%", 0.25, 0.5],
    ["50-75%", 0.5, 0.75],
    ["75-100%", 0.75, 1.01],
  ];

  const overlapBuckets = bucketDefs.map(([range, lo, hi]) => {
    const bucket = supported.filter(
      (r) => r.overlapFraction >= lo && r.overlapFraction < hi,
    );
    return {
      range,
      relayCount: bucket.length,
      meanSavingsRatio: bucket.length > 0
        ? meanOf(bucket.map((r) => r.savingsRatio ?? 0))
        : null,
      meanOverlap: bucket.length > 0
        ? meanOf(bucket.map((r) => r.overlapFraction))
        : 0,
    };
  });

  return {
    totalRelays: results.length,
    supportedRelays: supported.length,
    failedRelays: failed.length,
    relays: results,
    aggregateSavingsRatio,
    overlapBuckets,
  };
}

/**
 * Reconcile a single relay: build local set, open WS, run negentropy, measure.
 */
async function reconcileRelay(
  relay: RelayUrl,
  input: BenchmarkInput,
  cache: QueryCache,
  relayOutcomes: ReadonlyMap<RelayUrl, RelayOutcome>,
): Promise<RelayReconcileResult> {
  const outcome = relayOutcomes.get(relay);
  const reqBytesReceived = outcome?.bytesReceived ?? 0;

  // Build local set: for each pubkey this relay serves, collect events
  // from all *other* relays
  const writers = input.relayToWriters.get(relay);
  if (!writers || writers.size === 0) {
    return makeFailedResult(relay, reqBytesReceived, "no writers for relay");
  }

  const localEventIds = new Set<string>();
  const otherRelays = [...input.relayToWriters.keys()].filter((r) => r !== relay);

  for (const pubkey of writers) {
    for (const otherRelay of otherRelays) {
      const ids = cache.get(otherRelay, pubkey);
      if (ids) {
        for (const id of ids) localEventIds.add(id);
      }
    }
  }

  // Also collect the relay's own baseline events for overlap calculation
  const relayBaselineIds = new Set<string>();
  for (const pubkey of writers) {
    const ids = cache.get(relay, pubkey);
    if (ids) {
      for (const id of ids) relayBaselineIds.add(id);
    }
  }

  // Build NegentropyStorageVector with real timestamps
  const storage = new NegentropyStorageVector();
  for (const eventId of localEventIds) {
    const ts = cache.getTimestamp(eventId);
    storage.insert(ts, eventId);
  }
  storage.seal();

  const neg = new Negentropy(storage, 0);
  let initialMsg: string;
  try {
    initialMsg = await neg.initiate();
  } catch (err) {
    return makeFailedResult(relay, reqBytesReceived, `negentropy initiate: ${err}`);
  }

  // Open fresh WebSocket
  let ws: WebSocket;
  try {
    ws = await connectWithTimeout(relay, 10_000);
  } catch (err) {
    return makeFailedResult(relay, reqBytesReceived, `connect: ${err}`);
  }

  const startMs = performance.now();
  let bytesSent = 0;
  let bytesReceived = 0;
  let roundCount = 0;
  const allNeedIds: string[] = [];
  const allHaveIds: string[] = [];

  try {
    // Build the filter matching baseline
    const since = Math.floor(Date.now() / 1000) - 86400; // 1 day default
    const subId = `neg-rec-${Date.now()}`;
    const filter = { kinds: [1], since };

    // Send NEG-OPEN
    const openMsg = JSON.stringify(["NEG-OPEN", subId, filter, initialMsg]);
    bytesSent += openMsg.length;
    ws.send(openMsg);
    roundCount++;

    // Multi-round reconciliation loop
    let done = false;
    while (!done) {
      const response = await waitForNegMessage(ws, subId, PER_ROUND_TIMEOUT_MS);

      if (response.type === "NEG-MSG") {
        bytesReceived += response.rawLength;
        const [nextMsg, haveIds, needIds] = await neg.reconcile(response.payload);
        allNeedIds.push(...(needIds as string[]));
        allHaveIds.push(...(haveIds as string[]));

        if (nextMsg === null) {
          // Reconciliation complete
          done = true;
        } else {
          // Send next round
          const msgStr = JSON.stringify(["NEG-MSG", subId, nextMsg]);
          bytesSent += msgStr.length;
          ws.send(msgStr);
          roundCount++;
        }
      } else if (response.type === "NEG-ERR") {
        const closeMsg = JSON.stringify(["NEG-CLOSE", subId]);
        bytesSent += closeMsg.length;
        ws.send(closeMsg);
        try { ws.close(); } catch { /* ignore */ }

        const category = categorizeNegError(response.reason);
        return {
          relay,
          supported: false,
          localSetSize: localEventIds.size,
          bytesSent,
          bytesReceived,
          negBytesTotal: bytesSent + bytesReceived,
          reqBytesReceived,
          roundCount,
          wallClockMs: performance.now() - startMs,
          needCount: 0,
          haveCount: 0,
          overlapFraction: 0,
          newEventsBetweenPasses: 0,
          savingsRatio: null,
          error: response.reason,
          errorCategory: category,
        };
      } else {
        // timeout or unknown
        done = true;
        const closeMsg = JSON.stringify(["NEG-CLOSE", subId]);
        bytesSent += closeMsg.length;
        try { ws.send(closeMsg); } catch { /* ignore */ }
        try { ws.close(); } catch { /* ignore */ }

        return {
          relay,
          supported: false,
          localSetSize: localEventIds.size,
          bytesSent,
          bytesReceived,
          negBytesTotal: bytesSent + bytesReceived,
          reqBytesReceived,
          roundCount,
          wallClockMs: performance.now() - startMs,
          needCount: 0,
          haveCount: 0,
          overlapFraction: 0,
          newEventsBetweenPasses: 0,
          savingsRatio: null,
          errorCategory: "timeout",
        };
      }
    }

    // Clean up
    const closeMsg = JSON.stringify(["NEG-CLOSE", subId]);
    bytesSent += closeMsg.length;
    try { ws.send(closeMsg); } catch { /* ignore */ }
    try { ws.close(); } catch { /* ignore */ }

  } catch (err) {
    try { ws.close(); } catch { /* ignore */ }
    return makeFailedResult(relay, reqBytesReceived, `reconcile: ${err}`);
  }

  const wallClockMs = performance.now() - startMs;
  const negBytesTotal = bytesSent + bytesReceived;

  // Compute overlap: events in local set that are also in relay baseline
  let overlapCount = 0;
  for (const id of localEventIds) {
    if (relayBaselineIds.has(id)) overlapCount++;
  }
  const overlapFraction = relayBaselineIds.size > 0
    ? overlapCount / relayBaselineIds.size
    : 0;

  // Count new events between passes: needIds NOT in relay baseline
  const newEventsBetweenPasses = allNeedIds.filter(
    (id) => !relayBaselineIds.has(id) && !localEventIds.has(id),
  ).length;

  const savingsRatio = reqBytesReceived > 0
    ? 1 - negBytesTotal / reqBytesReceived
    : null;

  return {
    relay,
    supported: true,
    localSetSize: localEventIds.size,
    bytesSent,
    bytesReceived,
    negBytesTotal,
    reqBytesReceived,
    roundCount,
    wallClockMs,
    needCount: allNeedIds.length,
    haveCount: allHaveIds.length,
    overlapFraction,
    newEventsBetweenPasses,
    savingsRatio,
  };
}

function makeFailedResult(
  relay: RelayUrl,
  reqBytesReceived: number,
  error: string,
): RelayReconcileResult {
  return {
    relay,
    supported: false,
    localSetSize: 0,
    bytesSent: 0,
    bytesReceived: 0,
    negBytesTotal: 0,
    reqBytesReceived,
    roundCount: 0,
    wallClockMs: 0,
    needCount: 0,
    haveCount: 0,
    overlapFraction: 0,
    newEventsBetweenPasses: 0,
    savingsRatio: null,
    error,
  };
}

function categorizeNegError(reason: string): "unsupported" | "blocked" | "closed" {
  const lower = reason.toLowerCase();
  if (lower.includes("blocked") || lower.includes("rate") || lower.includes("too")) {
    return "blocked";
  }
  if (lower.includes("closed") || lower.includes("stale")) {
    return "closed";
  }
  return "unsupported";
}

function connectWithTimeout(relay: RelayUrl, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error("connect timeout"));
    }, timeoutMs);

    let ws: WebSocket;
    try {
      ws = new WebSocket(relay);
    } catch (e) {
      clearTimeout(timeout);
      reject(e);
      return;
    }

    ws.onopen = () => {
      clearTimeout(timeout);
      resolve(ws);
    };

    ws.onerror = (e) => {
      clearTimeout(timeout);
      const errMsg = e instanceof ErrorEvent ? e.message : "WebSocket error";
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error(errMsg));
    };

    ws.onclose = () => {
      clearTimeout(timeout);
      reject(new Error("closed before open"));
    };
  });
}

interface NegResponse {
  type: "NEG-MSG" | "NEG-ERR" | "timeout";
  payload: string;
  reason: string;
  rawLength: number;
}

function waitForNegMessage(
  ws: WebSocket,
  subId: string,
  timeoutMs: number,
): Promise<NegResponse> {
  return new Promise((resolve) => {
    if (ws.readyState !== WebSocket.OPEN) {
      resolve({ type: "timeout", payload: "", reason: "not connected", rawLength: 0 });
      return;
    }

    const timeout = setTimeout(() => {
      ws.removeEventListener("message", handler);
      resolve({ type: "timeout", payload: "", reason: "timeout", rawLength: 0 });
    }, timeoutMs);

    const handler = (msg: MessageEvent) => {
      try {
        const rawLen = typeof msg.data === "string" ? msg.data.length : 0;
        const data = JSON.parse(msg.data);
        if (!Array.isArray(data)) return;

        if (data[0] === "NEG-MSG" && data[1] === subId) {
          clearTimeout(timeout);
          ws.removeEventListener("message", handler);
          resolve({ type: "NEG-MSG", payload: data[2] ?? "", reason: "", rawLength: rawLen });
        } else if (data[0] === "NEG-ERR" && data[1] === subId) {
          clearTimeout(timeout);
          ws.removeEventListener("message", handler);
          resolve({ type: "NEG-ERR", payload: "", reason: String(data[2] ?? ""), rawLength: rawLen });
        }
      } catch { /* ignore parse errors */ }
    };

    ws.addEventListener("message", handler);
  });
}

export function printNip77ReconcileReport(report: Nip77ReconcileReport): void {
  console.log(
    `\n=== NIP-77 Reconciliation Report ===`,
  );
  console.log(
    `Relays: ${report.totalRelays} total, ${report.supportedRelays} supported, ${report.failedRelays} failed`,
  );

  if (report.aggregateSavingsRatio != null) {
    console.log(
      `Aggregate savings: ${(report.aggregateSavingsRatio * 100).toFixed(1)}%`,
    );
  }

  // Overlap bucket table
  if (report.overlapBuckets.some((b) => b.relayCount > 0)) {
    console.log(`\n  Savings by overlap bucket:`);

    const pad = (s: string, w: number, align: "left" | "right" = "right") =>
      align === "left" ? s.padEnd(w) : s.padStart(w);
    const pct = (n: number | null): string =>
      n != null ? `${(n * 100).toFixed(1)}%` : "N/A";

    const headers = ["Overlap", "Relays", "Savings", "Avg Overlap"];
    const widths = [10, 7, 10, 12];

    const headerRow = headers
      .map((h, i) => pad(h, widths[i], i === 0 ? "left" : "right"))
      .join(" | ");
    const separator = widths.map((w) => "-".repeat(w)).join("-+-");

    console.log(`  ${headerRow}`);
    console.log(`  ${separator}`);

    for (const bucket of report.overlapBuckets) {
      if (bucket.relayCount === 0) continue;
      const row = [
        pad(bucket.range, widths[0], "left"),
        pad(String(bucket.relayCount), widths[1]),
        pad(pct(bucket.meanSavingsRatio), widths[2]),
        pad(pct(bucket.meanOverlap), widths[3]),
      ].join(" | ");
      console.log(`  ${row}`);
    }
  }

  // Per-relay detail table (top 20 by savings)
  const supported = report.relays
    .filter((r) => r.supported)
    .sort((a, b) => (b.savingsRatio ?? 0) - (a.savingsRatio ?? 0));

  if (supported.length > 0) {
    console.log(`\n  Per-relay detail (${supported.length} supported):`);

    const pad = (s: string, w: number, align: "left" | "right" = "right") =>
      align === "left" ? s.padEnd(w) : s.padStart(w);
    const pct = (n: number | null): string =>
      n != null ? `${(n * 100).toFixed(1)}%` : "N/A";
    const fmtBytes = (n: number): string => {
      if (n < 1024) return `${n}B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
      return `${(n / 1024 / 1024).toFixed(1)}MB`;
    };

    const headers = ["Relay", "Overlap", "Savings", "NEG", "REQ", "Rounds", "Time"];
    const widths = [35, 8, 8, 8, 8, 7, 7];

    const headerRow = headers
      .map((h, i) => pad(h, widths[i], i === 0 ? "left" : "right"))
      .join(" | ");
    const separator = widths.map((w) => "-".repeat(w)).join("-+-");

    console.log(`  ${headerRow}`);
    console.log(`  ${separator}`);

    for (const r of supported.slice(0, 20)) {
      const relayShort = r.relay.replace(/^wss:\/\//, "").slice(0, widths[0]);
      const row = [
        pad(relayShort, widths[0], "left"),
        pad(pct(r.overlapFraction), widths[1]),
        pad(pct(r.savingsRatio), widths[2]),
        pad(fmtBytes(r.negBytesTotal), widths[3]),
        pad(fmtBytes(r.reqBytesReceived), widths[4]),
        pad(String(r.roundCount), widths[5]),
        pad(`${(r.wallClockMs / 1000).toFixed(1)}s`, widths[6]),
      ].join(" | ");
      console.log(`  ${row}`);
    }

    if (supported.length > 20) {
      console.log(`  ... and ${supported.length - 20} more`);
    }
  }

  // Failed relays summary
  const failed = report.relays.filter((r) => !r.supported);
  if (failed.length > 0) {
    const categories = new Map<string, number>();
    for (const r of failed) {
      const cat = r.errorCategory ?? "unknown";
      categories.set(cat, (categories.get(cat) ?? 0) + 1);
    }
    const catStr = [...categories.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cat, n]) => `${cat}=${n}`)
      .join(", ");
    console.log(`\n  Failed relays: ${catStr}`);
  }

  // Annotate low-overlap results
  const lowOverlap = supported.filter((r) => r.overlapFraction < 0.25);
  if (lowOverlap.length > 0) {
    console.log(
      `\n  Note: ${lowOverlap.length} relay(s) had <25% overlap (cold start). ` +
      `NIP-77 savings are minimal with low overlap.`,
    );
  }
}
