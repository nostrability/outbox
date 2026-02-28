/**
 * Phase 2 table and JSON output formatting.
 */

import type { Phase2Result } from "../types.ts";
import { median as computeMedian } from "../types.ts";

function pad(s: string, width: number, align: "left" | "right" = "right"): string {
  if (align === "left") return s.padEnd(width);
  return s.padStart(width);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function comma(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "N/A";
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function printPhase2Table(result: Phase2Result): void {
  const s = result.baselineStats;
  const timeStr = s.collectionTimeMs < 60_000
    ? `${(s.collectionTimeMs / 1000).toFixed(0)}s`
    : `${(s.collectionTimeMs / 60_000).toFixed(1)}min`;

  console.log(`\n=== Phase 2: Event Verification (${formatWindow(result.options.windowSeconds)} window) ===`);
  console.log(
    `Baseline: ${comma(s.totalRelaysQueried)} relays queried (${pct(s.relaySuccessRate)} success), ${timeStr}`,
  );
  if (s.timingStats) {
    const t = s.timingStats;
    console.log(
      `  Timing: connect ${fmtMs(t.connectMs.median)} median (${fmtMs(t.connectMs.p95)} p95)` +
      ` | query ${fmtMs(t.queryMs.median)} median (${fmtMs(t.queryMs.p95)} p95)` +
      ` | ${t.timeoutCount} timeouts (${t.timeoutRelayCount} relays)`,
    );
  }
  console.log(`  Authors: ${comma(result.totalAuthorsWithRelayData)} with relay data`);
  console.log(
    `    Testable (reliable): ${result.testableReliableAuthors}` +
    ` | Testable (partial): ${result.testablePartialAuthors}` +
    ` | Zero events: ${result.authorsZeroBaseline}` +
    ` | Unreliable: ${result.authorsUnreliableBaseline}`,
  );
  console.log(
    `  Baseline events: ${comma(s.totalUniqueEvents)}` +
    ` (mean ${s.meanEventsPerTestableAuthor.toFixed(1)}/author, median ${s.medianEventsPerTestableAuthor.toFixed(0)})`,
  );
  console.log(`  Events per (relay,pubkey) capped at: ${result.options.maxEventsPerPair}`);

  // Headline metrics table
  if (result.testableReliableAuthors > 0) {
    const headlineBaseline = result.algorithms.length > 0
      ? result.algorithms[0].totalBaselineEventsReliable
      : 0;
    console.log(
      `\n  Headline metrics (${result.testableReliableAuthors} testable-reliable authors, ${comma(headlineBaseline)} baseline events):`,
    );
    console.log("");

    // Check if any algorithm has latency data
    const hasLatency = result.algorithms.some((a) => a.latency);

    const headers = hasLatency
      ? ["Algorithm", "Evt Recall", "Auth Recall", "Relay OK%", "TTFE", "p50", "p80", "Timeouts"]
      : ["Algorithm", "Evt Recall", "Auth Recall", "Relay OK%"];
    const widths = hasLatency
      ? [32, 12, 13, 10, 8, 8, 8, 8]
      : [32, 12, 13, 10];

    const headerRow = headers.map((h, i) => pad(h, widths[i], i === 0 ? "left" : "right")).join(" | ");
    const separator = widths.map((w) => "-".repeat(w)).join("-+-");

    console.log(`  ${headerRow}`);
    console.log(`  ${separator}`);

    for (const alg of result.algorithms) {
      const relayOk = alg.selectedRelaySuccessRate !== null
        ? pct(alg.selectedRelaySuccessRate)
        : "N/A";
      const cols = [
        pad(alg.algorithmName, widths[0], "left"),
        pad(pct(alg.eventRecallRate), widths[1]),
        pad(pct(alg.authorRecallRate), widths[2]),
        pad(relayOk, widths[3]),
      ];
      if (hasLatency) {
        const lat = alg.latency;
        cols.push(pad(lat ? fmtMs(lat.ttfeMs ?? lat.ttfeConnectOnlyMs) : "N/A", widths[4]));
        cols.push(pad(lat?.queryP50Ms != null ? fmtMs(lat.queryP50Ms) : "N/A", widths[5]));
        cols.push(pad(lat?.queryP80Ms != null ? fmtMs(lat.queryP80Ms) : "N/A", widths[6]));
        cols.push(pad(lat ? String(lat.timeoutCount) : "N/A", widths[7]));
      }
      const row = cols.join(" | ");
      console.log(`  ${row}`);
    }

    // Per-author recall distribution
    if (result.algorithms.some((a) => a.perAuthorRecallRates.length > 0)) {
      console.log("");
      const dHeaders = ["Algorithm", "Median", "% at 0%", "p25", "p75"];
      const dWidths = [32, 8, 8, 8, 8];
      const dHeaderRow = dHeaders.map((h, i) => pad(h, dWidths[i], i === 0 ? "left" : "right")).join(" | ");
      const dSeparator = dWidths.map((w) => "-".repeat(w)).join("-+-");
      console.log(`  Per-author recall distribution:`);
      console.log(`  ${dHeaderRow}`);
      console.log(`  ${dSeparator}`);
      for (const alg of result.algorithms) {
        const rates = alg.perAuthorRecallRates;
        if (rates.length === 0) continue;
        const med = computeMedian(rates);
        const atZero = rates.filter((r) => r === 0).length / rates.length;
        const p25 = rates[Math.floor((rates.length - 1) * 0.25)];
        const p75 = rates[Math.floor((rates.length - 1) * 0.75)];
        const row = [
          pad(alg.algorithmName, dWidths[0], "left"),
          pad(pct(med), dWidths[1]),
          pad(pct(atZero), dWidths[2]),
          pad(pct(p25), dWidths[3]),
          pad(pct(p75), dWidths[4]),
        ].join(" | ");
        console.log(`  ${row}`);
      }
    }
  }

  // Latency simulation detail table (when available)
  if (result.algorithms.some((a) => a.latency)) {
    console.log("");
    console.log(`  Latency simulation (parallel relay query):`);
    const lHeaders = ["Algorithm", "TTFE", "p50", "p80", "Max", "TO", "TO Tax", "Relays", "Events"];
    const lWidths = [32, 8, 8, 8, 8, 4, 8, 8, 8];
    const lHeaderRow = lHeaders.map((h, i) => pad(h, lWidths[i], i === 0 ? "left" : "right")).join(" | ");
    const lSeparator = lWidths.map((w) => "-".repeat(w)).join("-+-");
    console.log(`  ${lHeaderRow}`);
    console.log(`  ${lSeparator}`);
    for (const alg of result.algorithms) {
      const lat = alg.latency;
      if (!lat) continue;
      const ttfe = lat.ttfeMs ?? lat.ttfeConnectOnlyMs;
      const relayStr = `${lat.relaysWithEvents}/${lat.relaysConnected}/${lat.relaysWithOutcomes}`;
      const row = [
        pad(alg.algorithmName, lWidths[0], "left"),
        pad(fmtMs(ttfe), lWidths[1]),
        pad(fmtMs(lat.queryP50Ms), lWidths[2]),
        pad(fmtMs(lat.queryP80Ms), lWidths[3]),
        pad(fmtMs(lat.queryMaxMs), lWidths[4]),
        pad(String(lat.timeoutCount), lWidths[5]),
        pad(fmtMs(lat.timeoutTaxMs || null), lWidths[6]),
        pad(relayStr, lWidths[7]),
        pad(comma(lat.totalEvents), lWidths[8]),
      ].join(" | ");
      console.log(`  ${row}`);
    }
    console.log(`  (Relays: with-events/connected/total | TO Tax: ceil(timeouts/concurrency) × EOSE timeout)`);
  }

  // Progressive completeness table
  if (result.algorithms.some((a) => a.latency?.progressiveCompleteness)) {
    console.log("");
    console.log(`  Progressive completeness (% of recall achieved by time):`);
    const pHeaders = ["Algorithm", "@1s", "@2s", "@5s", "@10s", "@15s"];
    const pWidths = [32, 8, 8, 8, 8, 8];
    const pHeaderRow = pHeaders.map((h, i) => pad(h, pWidths[i], i === 0 ? "left" : "right")).join(" | ");
    const pSeparator = pWidths.map((w) => "-".repeat(w)).join("-+-");
    console.log(`  ${pHeaderRow}`);
    console.log(`  ${pSeparator}`);
    for (const alg of result.algorithms) {
      const pc = alg.latency?.progressiveCompleteness;
      if (!pc) continue;
      const row = [
        pad(alg.algorithmName, pWidths[0], "left"),
        pad(pc[1] != null ? pct(pc[1]) : "N/A", pWidths[1]),
        pad(pc[2] != null ? pct(pc[2]) : "N/A", pWidths[2]),
        pad(pc[5] != null ? pct(pc[5]) : "N/A", pWidths[3]),
        pad(pc[10] != null ? pct(pc[10]) : "N/A", pWidths[4]),
        pad(pc[15] != null ? pct(pc[15]) : "N/A", pWidths[5]),
      ].join(" | ");
      console.log(`  ${row}`);
    }
  }

  // EOSE-race simulation
  if (result.algorithms.some((a) => a.latency?.eoseRace)) {
    console.log("");
    console.log(`  EOSE-race simulation (stop after first EOSE + grace period):`);
    const rHeaders = ["Algorithm", "+0ms", "+200ms", "+500ms", "+1s", "+2s"];
    const rWidths = [32, 8, 8, 8, 8, 8];
    const rHeaderRow = rHeaders.map((h, i) => pad(h, rWidths[i], i === 0 ? "left" : "right")).join(" | ");
    const rSeparator = rWidths.map((w) => "-".repeat(w)).join("-+-");
    console.log(`  ${rHeaderRow}`);
    console.log(`  ${rSeparator}`);
    for (const alg of result.algorithms) {
      const race = alg.latency?.eoseRace;
      if (!race) continue;
      const graces = [0, 200, 500, 1000, 2000];
      const cols = [pad(alg.algorithmName, rWidths[0], "left")];
      for (let i = 0; i < graces.length; i++) {
        const g = graces[i];
        const entry = race[g];
        cols.push(pad(entry ? pct(entry.completeness) : "N/A", rWidths[i + 1]));
      }
      console.log(`  ${cols.join(" | ")}`);
    }
    // Show first EOSE time for reference
    const firstEoseTimes = result.algorithms
      .filter((a) => a.latency?.eoseRace?.[0])
      .map((a) => ({ name: a.algorithmName, ms: a.latency!.eoseRace![0].cutoffMs }));
    if (firstEoseTimes.length > 0) {
      console.log(`  (First EOSE: ${firstEoseTimes.map((t) => `${t.name}=${fmtMs(t.ms)}`).join(", ")})`);
    }
  }

  // Profile-view latency (algorithm-independent)
  if (result.profileViewLatency) {
    const pv = result.profileViewLatency;
    console.log("");
    console.log(`  Profile-view latency (per-author outbox query, top 3 write relays):`);
    console.log(`    Authors simulated: ${pv.authorCount} | Hit rate: ${pct(pv.hitRate)}`);
    console.log(
      `    TTFE: ${fmtMs(pv.medianTtfeMs)} median, ${fmtMs(pv.meanTtfeMs)} mean, ${fmtMs(pv.p95TtfeMs)} p95`
    );
    console.log(
      `    Relays/profile: ${pv.meanRelaysQueried.toFixed(1)} queried, ` +
      `${pv.meanRelaysWithEvents.toFixed(1)} with events, ` +
      `${pv.meanTimeouts.toFixed(2)} timeouts`
    );

    // Compare with feed-path TTFE for each algorithm
    const hasComparison = result.algorithms.some((a) => a.latency?.ttfeMs != null || a.latency?.ttfeConnectOnlyMs != null);
    if (hasComparison && pv.medianTtfeMs != null) {
      console.log("");
      console.log(`  Feed vs profile-view TTFE comparison:`);
      const cHeaders = ["Algorithm", "Feed TTFE", "Profile TTFE", "Delta"];
      const cWidths = [32, 10, 13, 8];
      const cHeaderRow = cHeaders.map((h, i) => pad(h, cWidths[i], i === 0 ? "left" : "right")).join(" | ");
      const cSeparator = cWidths.map((w) => "-".repeat(w)).join("-+-");
      console.log(`  ${cHeaderRow}`);
      console.log(`  ${cSeparator}`);
      for (const alg of result.algorithms) {
        const feedTtfe = alg.latency?.ttfeMs ?? alg.latency?.ttfeConnectOnlyMs;
        const profileTtfe = pv.medianTtfeMs;
        const delta = feedTtfe != null && profileTtfe != null
          ? `${feedTtfe <= profileTtfe ? "+" : ""}${fmtMs(profileTtfe - feedTtfe)}`
          : "N/A";
        const row = [
          pad(alg.algorithmName, cWidths[0], "left"),
          pad(fmtMs(feedTtfe), cWidths[1]),
          pad(fmtMs(profileTtfe), cWidths[2]),
          pad(delta, cWidths[3]),
        ].join(" | ");
        console.log(`  ${row}`);
      }
    }
  }

  // Including partial authors table
  const totalTestable = result.testableReliableAuthors + result.testablePartialAuthors;
  if (totalTestable > 0 && result.testablePartialAuthors > 0) {
    const inclBaseline = result.algorithms.length > 0
      ? result.algorithms[0].totalBaselineEventsInclPartial
      : 0;
    console.log(
      `\n  Including partial-baseline authors (${totalTestable} testable authors, ${comma(inclBaseline)} baseline events):`,
    );
    console.log("");

    const headers = ["Algorithm", "Evt Recall", "Auth Recall"];
    const widths = [32, 12, 13];

    const headerRow = headers.map((h, i) => pad(h, widths[i], i === 0 ? "left" : "right")).join(" | ");
    const separator = widths.map((w) => "-".repeat(w)).join("-+-");

    console.log(`  ${headerRow}`);
    console.log(`  ${separator}`);

    for (const alg of result.algorithms) {
      const row = [
        pad(alg.algorithmName, widths[0], "left"),
        pad(pct(alg.eventRecallIncPartial), widths[1]),
        pad(pct(alg.authorRecallIncPartial), widths[2]),
      ].join(" | ");
      console.log(`  ${row}`);
    }
  }
}

function formatWindow(seconds: number): string {
  if (seconds >= 86400) return `${seconds / 86400}d`;
  if (seconds >= 3600) return `${seconds / 3600}h`;
  return `${seconds}s`;
}
