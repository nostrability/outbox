import type {
  AlgorithmMetrics,
  BenchmarkInput,
  BenchmarkOutput,
  FetchMeta,
  Nip66FilterMode,
  SweepRow,
  AlgorithmResult,
} from "./types.ts";
import { serializeAlgorithmResult } from "./types.ts";

// --- Fetch Quality Report ---

export function printFetchQuality(meta: FetchMeta): void {
  console.log("\n=== Fetch Quality ===");

  // Per-indexer stats
  const indexerParts: string[] = [];
  for (const relay of meta.indexerRelays) {
    const stats = meta.perRelayStats[relay];
    if (stats) {
      const errors = stats.errors.length > 0 ? `, errors: ${stats.errors.join(";")}` : "";
      indexerParts.push(
        `${relay} (${stats.eventsReceived} events, ${stats.connectionTimeMs}ms${errors})`,
      );
    } else {
      indexerParts.push(`${relay} (no data)`);
    }
  }
  console.log(`Indexers: ${indexerParts.join(", ")}`);

  // Follows summary
  const missingPct = (meta.missingRate * 100).toFixed(1);
  const withPct = ((1 - meta.missingRate) * 100).toFixed(1);
  console.log(
    `Follows: ${meta.totalFollows} | With relay list: ${meta.followsWithRelayList} (${withPct}%) | Missing: ${meta.followsMissingRelayList} (${missingPct}%)${meta.followsFilteredToEmpty > 0 ? ` | Filtered-to-empty: ${meta.followsFilteredToEmpty}` : ""}`,
  );

  // Filter info
  const fu = meta.filteredUrls;
  const filterParts: string[] = [];
  if (fu.localhost.length) filterParts.push(`${fu.localhost.length} localhost`);
  if (fu.insecureWs.length) filterParts.push(`${fu.insecureWs.length} insecure ws`);
  if (fu.ipAddress.length) filterParts.push(`${fu.ipAddress.length} IP-only`);
  if (fu.knownBad.length) filterParts.push(`${fu.knownBad.length} known-bad`);
  if (fu.malformed.length) filterParts.push(`${fu.malformed.length} malformed`);
  console.log(
    `Filter profile: ${meta.filterProfile} | Filtered URLs: ${fu.totalRemoved}${filterParts.length ? ` (${filterParts.join(", ")})` : ""}`,
  );

  if (meta.missingRate > 0.5) {
    console.log(
      `Note: NIP-65 adoption is low for this follow set (${missingPct}% missing relay lists)`,
    );
  }
}

// --- Table Output ---

function pad(s: string, width: number, align: "left" | "right" = "right"): string {
  if (align === "left") return s.padEnd(width);
  return s.padStart(width);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmt(n: number, decimals = 1): string {
  return n.toFixed(decimals);
}

export function printRegimeATable(
  metrics: AlgorithmMetrics[],
  maxConnections: number | "unlimited",
): void {
  const label = maxConnections === "unlimited" ? "Unlimited" : maxConnections;
  console.log(`\n=== Regime A: Fixed ${label} Connections ===`);

  const headers = ["Algorithm", "Relays", "Assign%", "Orphans", "Alg.Orph", "Avg/pk", "Gini", "HHI"];
  const widths = [30, 7, 9, 8, 9, 7, 6, 6];

  // Header row
  const headerRow = headers.map((h, i) => pad(h, widths[i], i === 0 ? "left" : "right")).join(" | ");
  const separator = widths.map((w) => "-".repeat(w)).join("-+-");

  console.log(`  ${headerRow}`);
  console.log(`  ${separator}`);

  for (const m of metrics) {
    const stochLabel = m.stochastic
      ? ` (${fmt(m.stochastic.stddev.assignmentCoverage as number ?? 0, 1)}sd)`
      : "";
    const row = [
      pad(m.name, widths[0], "left"),
      pad(String(m.totalRelaysSelected), widths[1]),
      pad(pct(m.assignmentCoverage) + stochLabel, widths[2] + stochLabel.length),
      pad(String(m.orphanedPubkeys), widths[3]),
      pad(String(m.algorithmOrphans), widths[4]),
      pad(fmt(m.avgRelaysPerPubkey), widths[5]),
      pad(fmt(m.gini, 2), widths[6]),
      pad(fmt(m.hhi, 3), widths[7]),
    ].join(" | ");
    console.log(`  ${row}`);
  }
}

export function printRegimeBTable(
  metrics: AlgorithmMetrics[],
  relaysPerUser: number,
): void {
  console.log(`\n=== Regime B: Fixed ${relaysPerUser} Relays/Author ===`);

  const headers = ["Algorithm", "Relays", "Assign%", "Attain%", "Avg/pk"];
  const widths = [30, 7, 9, 9, 7];

  const headerRow = headers.map((h, i) => pad(h, widths[i], i === 0 ? "left" : "right")).join(" | ");
  const separator = widths.map((w) => "-".repeat(w)).join("-+-");

  console.log(`  ${headerRow}`);
  console.log(`  ${separator}`);

  for (const m of metrics) {
    const row = [
      pad(m.name, widths[0], "left"),
      pad(String(m.totalRelaysSelected), widths[1]),
      pad(pct(m.assignmentCoverage), widths[2]),
      pad(pct(m.targetAttainmentRate), widths[3]),
      pad(fmt(m.avgRelaysPerPubkey), widths[4]),
    ].join(" | ");
    console.log(`  ${row}`);
  }
}

// --- Sweep Table ---

export function printSweepTable(rows: SweepRow[], budgets: (number | "unlimited")[]): void {
  console.log("\n=== Assignment Coverage at Connection Cap ===");

  const nameWidth = 30;
  const colWidth = 7;

  // Header
  const budgetLabels = budgets.map((b) =>
    b === "unlimited" ? "All" : String(b),
  );
  const header =
    pad("Algorithm", nameWidth, "left") +
    " | " +
    budgetLabels.map((l) => pad(l, colWidth)).join(" | ");

  const sep =
    "-".repeat(nameWidth) +
    "-+-" +
    budgetLabels.map(() => "-".repeat(colWidth)).join("-+-");

  console.log(`  ${header}`);
  console.log(`  ${sep}`);

  for (const row of rows) {
    const cells = budgets.map((b) => {
      const coverage = row.coverageByBudget[b];
      return coverage !== undefined ? pct(coverage) : "N/A";
    });
    const line =
      pad(row.name, nameWidth, "left") +
      " | " +
      cells.map((c) => pad(c, colWidth)).join(" | ");
    console.log(`  ${line}`);
  }

  // Saturation points
  console.log("\n  Saturation points (smallest budget reaching threshold):");
  for (const row of rows) {
    const thresholds = [0.9, 0.95, 0.99];
    const points: string[] = [];
    for (const t of thresholds) {
      const budget = budgets.find((b) => {
        const cov = row.coverageByBudget[b];
        return cov !== undefined && cov >= t;
      });
      points.push(`${pct(t)}@${budget === "unlimited" ? "all" : budget ?? "N/A"}`);
    }
    console.log(`  ${pad(row.name, nameWidth, "left")} : ${points.join(", ")}`);
  }
}

// --- JSON Output ---

export function buildJsonOutput(
  input: BenchmarkInput,
  metrics: AlgorithmMetrics[],
  results: AlgorithmResult[],
  seed: number,
  fullAssignments: boolean,
  nip66Filter?: Nip66FilterMode,
): BenchmarkOutput {
  const serializedResults = results.map((r) => {
    const s = serializeAlgorithmResult(r);
    if (!fullAssignments) {
      // Summarize: top-20 heaviest relays only
      const entries = Object.entries(s.relayAssignments)
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 20);
      s.relayAssignments = Object.fromEntries(entries);
      // Omit full pubkey assignments in summary mode
      s.pubkeyAssignments = {};
    }
    return s;
  });

  return {
    meta: {
      targetPubkey: input.targetPubkey,
      fetchedAt: input.fetchedAt,
      follows: input.follows.length,
      followsMissingRelayList: input.followsMissingRelayList.length,
      fetchMeta: input.fetchMeta,
      seed,
      nip66Filter: !!nip66Filter,
      nip66FilterMode: nip66Filter ? nip66Filter : null,
    },
    metrics,
    results: serializedResults,
  };
}

export async function writeJsonOutput(
  output: BenchmarkOutput,
  targetPubkey: string,
): Promise<string> {
  await Deno.mkdir("results", { recursive: true });
  const ts = Date.now();
  const path = `results/${targetPubkey.slice(0, 16)}_${ts}.json`;
  await Deno.writeTextFile(path, JSON.stringify(output, null, 2));
  return path;
}
