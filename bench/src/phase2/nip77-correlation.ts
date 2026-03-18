/**
 * NIP-77 capability correlation analysis.
 *
 * Partitions relays by NIP-77 support (from NIP-66 data) and compares
 * performance metrics: latency, success rate, event delivery, timeouts.
 *
 * Answers: "Are NIP-77-capable relays better relays?"
 */

import type { RelayOutcome } from "../relay-pool.ts";
import type {
  Nip66RelayData,
  Nip77CorrelationResult,
  RelayGroupStats,
  RelayUrl,
} from "../types.ts";
import { meanOf, median, percentile, toSortedNumericArray } from "../types.ts";

interface RelayWithOutcome {
  url: RelayUrl;
  outcome: RelayOutcome;
  nip77: boolean;
}

function computeGroupStats(relays: RelayWithOutcome[]): RelayGroupStats {
  if (relays.length === 0) {
    return {
      count: 0,
      connectMs: null,
      queryMs: null,
      successRate: 0,
      deliveryRate: 0,
      timeoutRate: 0,
      meanEventCount: 0,
    };
  }

  const connected = relays.filter((r) => r.outcome.connected);
  const withEvents = relays.filter(
    (r) => r.outcome.connected && (r.outcome.eventCount ?? 0) > 0,
  );
  const timedOut = relays.filter((r) => r.outcome.timedOut);

  const connectTimes = toSortedNumericArray(
    connected.map((r) => r.outcome.connectTimeMs),
  );
  const queryTimes = toSortedNumericArray(
    connected.map((r) => r.outcome.queryTimeMs),
  );
  const eventCounts = relays.map((r) => r.outcome.eventCount ?? 0);

  return {
    count: relays.length,
    connectMs: connectTimes.length > 0
      ? {
          median: median(connectTimes),
          mean: meanOf(connected.map((r) => r.outcome.connectTimeMs)),
          p95: percentile(connectTimes, 0.95),
        }
      : null,
    queryMs: queryTimes.length > 0
      ? {
          median: median(queryTimes),
          mean: meanOf(connected.map((r) => r.outcome.queryTimeMs)),
          p95: percentile(queryTimes, 0.95),
        }
      : null,
    successRate: relays.length > 0 ? connected.length / relays.length : 0,
    deliveryRate: relays.length > 0 ? withEvents.length / relays.length : 0,
    timeoutRate: relays.length > 0 ? timedOut.length / relays.length : 0,
    meanEventCount: meanOf(eventCounts),
  };
}

export function computeNip77Correlation(
  nip66Data: ReadonlyMap<RelayUrl, Nip66RelayData>,
  relayOutcomes: ReadonlyMap<RelayUrl, RelayOutcome>,
): Nip77CorrelationResult {
  const relays: RelayWithOutcome[] = [];

  for (const [url, outcome] of relayOutcomes) {
    const nip66 = nip66Data.get(url);
    const nip77 = nip66?.supportedNips?.includes(77) ?? false;
    relays.push({ url, outcome, nip77 });
  }

  const nip77Relays = relays.filter((r) => r.nip77);
  const nonNip77Relays = relays.filter((r) => !r.nip77);

  return {
    totalRelays: relays.length,
    nip77Relays: nip77Relays.length,
    nonNip77Relays: nonNip77Relays.length,
    detectionSource: "nip66",
    nip77Stats: computeGroupStats(nip77Relays),
    nonNip77Stats: computeGroupStats(nonNip77Relays),
  };
}

export function printNip77CorrelationTable(
  corr: Nip77CorrelationResult,
): void {
  console.log(
    `\n=== NIP-77 Capability Correlation (${corr.totalRelays} relays, source: ${corr.detectionSource}) ===`,
  );
  console.log(
    `NIP-77 capable: ${corr.nip77Relays} | Non-NIP-77: ${corr.nonNip77Relays}`,
  );

  if (corr.nip77Relays === 0) {
    console.log("  No NIP-77 relays detected — skipping comparison.");
    return;
  }

  const fmtMs = (ms: number | null | undefined): string => {
    if (ms == null) return "N/A";
    return `${ms.toFixed(0)}ms`;
  };
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const pad = (s: string, w: number, align: "left" | "right" = "right") =>
    align === "left" ? s.padEnd(w) : s.padStart(w);

  const headers = [
    "Group",
    "Count",
    "Connect",
    "Query",
    "Success",
    "Delivery",
    "Timeout",
    "Events",
  ];
  const widths = [12, 6, 10, 10, 8, 9, 8, 8];

  const headerRow = headers
    .map((h, i) => pad(h, widths[i], i === 0 ? "left" : "right"))
    .join(" | ");
  const separator = widths.map((w) => "-".repeat(w)).join("-+-");

  console.log(`  ${headerRow}`);
  console.log(`  ${separator}`);

  function formatRow(label: string, stats: RelayGroupStats): string {
    return [
      pad(label, widths[0], "left"),
      pad(String(stats.count), widths[1]),
      pad(fmtMs(stats.connectMs?.median), widths[2]),
      pad(fmtMs(stats.queryMs?.median), widths[3]),
      pad(pct(stats.successRate), widths[4]),
      pad(pct(stats.deliveryRate), widths[5]),
      pad(pct(stats.timeoutRate), widths[6]),
      pad(stats.meanEventCount.toFixed(0), widths[7]),
    ].join(" | ");
  }

  console.log(`  ${formatRow("NIP-77", corr.nip77Stats)}`);
  console.log(`  ${formatRow("Non-NIP-77", corr.nonNip77Stats)}`);

  if (corr.probeStats) {
    const ps = corr.probeStats;
    console.log(
      `\n  Probe accuracy: ${ps.probed} probed, ` +
        `${ps.actuallySupported} confirmed, ` +
        `${ps.claimedButRejected} claimed-but-rejected, ` +
        `${ps.unclaimedButSupported} unclaimed-but-supported`,
    );
  }
}
