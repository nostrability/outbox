/**
 * Phase 2 table and JSON output formatting.
 */

import type { Phase2Result } from "../types.ts";

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

export function printPhase2Table(result: Phase2Result): void {
  const s = result.baselineStats;
  const timeStr = s.collectionTimeMs < 60_000
    ? `${(s.collectionTimeMs / 1000).toFixed(0)}s`
    : `${(s.collectionTimeMs / 60_000).toFixed(1)}min`;

  console.log(`\n=== Phase 2: Event Verification (${formatWindow(result.options.windowSeconds)} window) ===`);
  console.log(
    `Baseline: ${comma(s.totalRelaysQueried)} relays queried (${pct(s.relaySuccessRate)} success), ${timeStr}`,
  );
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

    const headers = ["Algorithm", "Evt Recall", "Auth Recall", "Relay OK%"];
    const widths = [32, 12, 13, 10];

    const headerRow = headers.map((h, i) => pad(h, widths[i], i === 0 ? "left" : "right")).join(" | ");
    const separator = widths.map((w) => "-".repeat(w)).join("-+-");

    console.log(`  ${headerRow}`);
    console.log(`  ${separator}`);

    for (const alg of result.algorithms) {
      const relayOk = alg.selectedRelaySuccessRate !== null
        ? pct(alg.selectedRelaySuccessRate)
        : "N/A";
      const row = [
        pad(alg.algorithmName, widths[0], "left"),
        pad(pct(alg.eventRecallRate), widths[1]),
        pad(pct(alg.authorRecallRate), widths[2]),
        pad(relayOk, widths[3]),
      ].join(" | ");
      console.log(`  ${row}`);
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
