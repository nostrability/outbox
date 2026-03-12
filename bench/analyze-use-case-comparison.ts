#!/usr/bin/env -S deno run --allow-read
/**
 * Extract profile-view + feed metrics from Campaign 2 (use-case comparison) results.
 * Answers outbox-2xq: Is per-author (FD+Thompson) or global (Welshman+Thompson) better
 * for profile views vs feeds?
 *
 * Usage: deno run --allow-read analyze-use-case-comparison.ts
 */

// Campaign 2 result files (extracted from use_case_comparison_logs)
const CAMPAIGN2_FILES = [
  "results/3bf0c63fcb934634_1773254115166.json", // fiatjaf s1
  "results/3bf0c63fcb934634_1773255155348.json", // fiatjaf s2
  "results/3bf0c63fcb934634_1773256249642.json", // fiatjaf s3
  "results/3bf0c63fcb934634_1773257188894.json", // fiatjaf s4
  "results/3bf0c63fcb934634_1773258021754.json", // fiatjaf s5
  "results/97c70a44366a6535_1773254233963.json", // hodlbod s1
  "results/97c70a44366a6535_1773255286512.json", // hodlbod s2
  "results/97c70a44366a6535_1773256374787.json", // hodlbod s3
  "results/97c70a44366a6535_1773257313841.json", // hodlbod s4
  "results/97c70a44366a6535_1773258147109.json", // hodlbod s5
  "results/32e1827635450ebb_1773254375410.json", // jb55 s1
  "results/32e1827635450ebb_1773255408687.json", // jb55 s2
  "results/32e1827635450ebb_1773256511921.json", // jb55 s3
  "results/32e1827635450ebb_1773257449816.json", // jb55 s4
  "results/32e1827635450ebb_1773258275148.json", // jb55 s5
  "results/04c915daefee3831_1773254561011.json", // ODELL s1
  "results/04c915daefee3831_1773255593767.json", // ODELL s2
  "results/04c915daefee3831_1773256721308.json", // ODELL s3
  "results/04c915daefee3831_1773257642483.json", // ODELL s4
  "results/04c915daefee3831_1773258526664.json", // ODELL s5
  "results/6a0c596c1484eae2_1773254660520.json", // Gato s1
  "results/6a0c596c1484eae2_1773255760939.json", // Gato s2
  "results/6a0c596c1484eae2_1773256830398.json", // Gato s3
  "results/6a0c596c1484eae2_1773257744013.json", // Gato s4
  "results/6a0c596c1484eae2_1773258630335.json", // Gato s5
  "results/2c65940725bbf10b_1773254943385.json", // Telluride s1
  "results/2c65940725bbf10b_1773256028990.json", // Telluride s2
  // Telluride s3-s5: 0 follows, no result files
];

const PK_TO_NAME: Record<string, string> = {
  "3bf0c63fcb934634": "fiatjaf",
  "97c70a44366a6535": "hodlbod",
  "32e1827635450ebb": "jb55",
  "04c915daefee3831": "ODELL",
  "6a0c596c1484eae2": "Gato",
  "2c65940725bbf10b": "Telluride",
};

// Algorithm index → name mapping (validated per-file)
const ALGO_ORDER = [
  "Filter Decomposition",
  "FD+Thompson",
  "Weighted Stochastic",
  "Welshman+Thompson",
];

interface AlgoMetrics {
  name: string;
  eventRecall: number;
  authorRecall: number;
  feedTtfeMs: number;
  feedTtfeConnectOnlyMs: number;
}

interface RunResult {
  file: string;
  profile: string;
  session: number;
  algos: AlgoMetrics[];
  profileViewTtfeMeanMs: number;
  profileViewTtfeMedianMs: number;
  profileViewTtfeP95Ms: number;
  profileViewHitRate: number;
  profileViewAuthors: number;
}

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pct(n: number): string {
  return (n * 100).toFixed(1) + "%";
}

function fmtMs(n: number): string {
  return n.toFixed(0) + "ms";
}

function pad(s: string, w: number, align: "left" | "right" = "left"): string {
  return align === "left" ? s.padEnd(w) : s.padStart(w);
}

// --- Parse all Campaign 2 files ---
const results: RunResult[] = [];
let sessionCounters: Record<string, number> = {};

for (const file of CAMPAIGN2_FILES) {
  const pkPrefix = file.split("/")[1].split("_")[0];
  const profile = PK_TO_NAME[pkPrefix] ?? pkPrefix;
  sessionCounters[profile] = (sessionCounters[profile] ?? 0) + 1;
  const session = sessionCounters[profile];

  let data: any;
  try {
    data = JSON.parse(await Deno.readTextFile(file));
  } catch (e) {
    console.error(`SKIP: ${file} — ${e}`);
    continue;
  }

  // Validate algorithms present
  const algos: AlgoMetrics[] = [];
  for (const [idx, algoData] of Object.entries(data.phase2.algorithms) as any[]) {
    algos.push({
      name: algoData.algorithmName,
      eventRecall: algoData.eventRecallRate,
      authorRecall: algoData.authorRecallRate,
      feedTtfeMs: algoData.latency?.ttfeMs ?? NaN,
      feedTtfeConnectOnlyMs: algoData.latency?.ttfeConnectOnlyMs ?? NaN,
    });
  }

  const pv = data.phase2.profileViewLatency;
  results.push({
    file,
    profile,
    session,
    algos,
    profileViewTtfeMeanMs: pv?.meanTtfeMs ?? NaN,
    profileViewTtfeMedianMs: pv?.medianTtfeMs ?? NaN,
    profileViewTtfeP95Ms: pv?.p95TtfeMs ?? NaN,
    profileViewHitRate: pv?.hitRate ?? NaN,
    profileViewAuthors: pv?.authorCount ?? 0,
  });
}

console.log(`\n=== Campaign 2: Use-Case Comparison (outbox-2xq) ===`);
console.log(`Files parsed: ${results.length} / ${CAMPAIGN2_FILES.length}`);
console.log(`Profiles: ${[...new Set(results.map((r) => r.profile))].join(", ")}`);
console.log(`Note: Telluride returned 0 follows for sessions 3-5 (no result files)`);

// --- Table 1: Per-algorithm feed metrics (mean across all sessions) ---
console.log(`\n\n─── Table 1: Feed Metrics by Algorithm (mean ± across ${results.length} runs) ───\n`);

const algoNames = [...new Set(results.flatMap((r) => r.algos.map((a) => a.name)))];
const headers = ["Algorithm", "Event Recall", "Author Recall", "Feed TTFE", "Feed TTFE (conn)"];
const widths = [38, 14, 14, 12, 16];

console.log(headers.map((h, i) => pad(h, widths[i], i === 0 ? "left" : "right")).join(" | "));
console.log(widths.map((w) => "-".repeat(w)).join("-+-"));

for (const algoName of algoNames) {
  const vals = results.flatMap((r) => r.algos.filter((a) => a.name === algoName));
  const er = vals.map((v) => v.eventRecall).filter((v) => !isNaN(v));
  const ar = vals.map((v) => v.authorRecall).filter((v) => !isNaN(v));
  const ft = vals.map((v) => v.feedTtfeMs).filter((v) => !isNaN(v));
  const fc = vals.map((v) => v.feedTtfeConnectOnlyMs).filter((v) => !isNaN(v));

  const row = [
    algoName,
    er.length > 0 ? pct(mean(er)) : "n/a",
    ar.length > 0 ? pct(mean(ar)) : "n/a",
    ft.length > 0 ? fmtMs(mean(ft)) : "n/a",
    fc.length > 0 ? fmtMs(mean(fc)) : "n/a",
  ];
  console.log(row.map((v, i) => pad(v, widths[i], i === 0 ? "left" : "right")).join(" | "));
}

// --- Table 2: Profile-view latency (algorithm-independent) ---
console.log(`\n\n─── Table 2: Profile-View Latency (algorithm-independent, top-3 write relays) ───\n`);

const pvHeaders = ["Metric", "Mean", "Median", "Min", "Max"];
const pvWidths = [20, 12, 12, 12, 12];
console.log(pvHeaders.map((h, i) => pad(h, pvWidths[i], i === 0 ? "left" : "right")).join(" | "));
console.log(pvWidths.map((w) => "-".repeat(w)).join("-+-"));

const pvMeans = results.map((r) => r.profileViewTtfeMeanMs).filter((v) => !isNaN(v));
const pvMedians = results.map((r) => r.profileViewTtfeMedianMs).filter((v) => !isNaN(v));
const pvP95s = results.map((r) => r.profileViewTtfeP95Ms).filter((v) => !isNaN(v));
const pvHits = results.map((r) => r.profileViewHitRate).filter((v) => !isNaN(v));
const pvAuthors = results.map((r) => r.profileViewAuthors).filter((v) => v > 0);

function statRow(label: string, vals: number[], fmt: (n: number) => string): string[] {
  return [
    label,
    fmt(mean(vals)),
    fmt(median(vals)),
    fmt(Math.min(...vals)),
    fmt(Math.max(...vals)),
  ];
}

for (const [label, vals, fmt] of [
  ["TTFE mean (ms)", pvMeans, fmtMs],
  ["TTFE median (ms)", pvMedians, fmtMs],
  ["TTFE p95 (ms)", pvP95s, fmtMs],
  ["Hit rate", pvHits, pct],
] as [string, number[], (n: number) => string][]) {
  const row = statRow(label, vals, fmt);
  console.log(row.map((v, i) => pad(v, pvWidths[i], i === 0 ? "left" : "right")).join(" | "));
}

console.log(`\nAuthors simulated: ${pvAuthors.length > 0 ? `mean=${mean(pvAuthors).toFixed(0)}, range=[${Math.min(...pvAuthors)}, ${Math.max(...pvAuthors)}]` : "n/a"}`);

// --- Table 3: Per-profile comparison ---
console.log(`\n\n─── Table 3: Per-Profile Feed Event Recall (FD+Thompson vs Welshman+Thompson) ───\n`);

const profiles = [...new Set(results.map((r) => r.profile))];
const t3Headers = ["Profile", "Sessions", "FD+T Recall", "W+T Recall", "Delta", "FD+T TTFE", "W+T TTFE", "PV TTFE"];
const t3Widths = [12, 8, 12, 12, 8, 10, 10, 10];
console.log(t3Headers.map((h, i) => pad(h, t3Widths[i], i === 0 ? "left" : "right")).join(" | "));
console.log(t3Widths.map((w) => "-".repeat(w)).join("-+-"));

for (const profile of profiles) {
  const runs = results.filter((r) => r.profile === profile);
  const fdtRuns = runs.flatMap((r) => r.algos.filter((a) => a.name.includes("FD+Thompson")));
  const wtRuns = runs.flatMap((r) => r.algos.filter((a) => a.name.includes("Welshman+Thompson")));

  const fdtRecall = fdtRuns.map((a) => a.eventRecall);
  const wtRecall = wtRuns.map((a) => a.eventRecall);
  const fdtTtfe = fdtRuns.map((a) => a.feedTtfeMs).filter((v) => !isNaN(v));
  const wtTtfe = wtRuns.map((a) => a.feedTtfeMs).filter((v) => !isNaN(v));
  const pvTtfe = runs.map((r) => r.profileViewTtfeMedianMs).filter((v) => !isNaN(v));

  const delta = mean(wtRecall) - mean(fdtRecall);
  const row = [
    profile,
    String(runs.length),
    pct(mean(fdtRecall)),
    pct(mean(wtRecall)),
    (delta >= 0 ? "+" : "") + pct(delta),
    fdtTtfe.length > 0 ? fmtMs(mean(fdtTtfe)) : "n/a",
    wtTtfe.length > 0 ? fmtMs(mean(wtTtfe)) : "n/a",
    pvTtfe.length > 0 ? fmtMs(mean(pvTtfe)) : "n/a",
  ];
  console.log(row.map((v, i) => pad(v, t3Widths[i], i === 0 ? "left" : "right")).join(" | "));
}

// --- Table 4: Session-over-session trend ---
console.log(`\n\n─── Table 4: Session-over-Session Feed Event Recall Trend ───\n`);

const t4Headers = ["Session", "FD+T Recall", "W+T Recall", "PV median TTFE", "PV hit rate"];
const t4Widths = [8, 14, 14, 16, 12];
console.log(t4Headers.map((h, i) => pad(h, t4Widths[i], i === 0 ? "left" : "right")).join(" | "));
console.log(t4Widths.map((w) => "-".repeat(w)).join("-+-"));

for (let s = 1; s <= 5; s++) {
  const sessionRuns = results.filter((r) => r.session === s);
  if (sessionRuns.length === 0) continue;

  const fdt = sessionRuns.flatMap((r) => r.algos.filter((a) => a.name.includes("FD+Thompson")));
  const wt = sessionRuns.flatMap((r) => r.algos.filter((a) => a.name.includes("Welshman+Thompson")));
  const pvMed = sessionRuns.map((r) => r.profileViewTtfeMedianMs).filter((v) => !isNaN(v));
  const pvHit = sessionRuns.map((r) => r.profileViewHitRate).filter((v) => !isNaN(v));

  const row = [
    `S${s} (n=${sessionRuns.length})`,
    fdt.length > 0 ? pct(mean(fdt.map((a) => a.eventRecall))) : "n/a",
    wt.length > 0 ? pct(mean(wt.map((a) => a.eventRecall))) : "n/a",
    pvMed.length > 0 ? fmtMs(mean(pvMed)) : "n/a",
    pvHit.length > 0 ? pct(mean(pvHit)) : "n/a",
  ];
  console.log(row.map((v, i) => pad(v, t4Widths[i], i === 0 ? "left" : "right")).join(" | "));
}

// --- Rule 2: Trace 3 values back to source files ---
console.log(`\n\n─── Rule 2: Traceability (3 values → source files) ───\n`);

// Pick 3 specific data points to trace
const traces = [
  { file: results[0].file, label: "fiatjaf S1" },
  { file: results[12].file, label: "jb55 S3" },
  { file: results[results.length - 1].file, label: `${results[results.length - 1].profile} S${results[results.length - 1].session}` },
];

for (const trace of traces) {
  const run = results.find((r) => r.file === trace.file);
  if (!run) continue;
  const fdt = run.algos.find((a) => a.name.includes("FD+Thompson"));
  const wt = run.algos.find((a) => a.name.includes("Welshman+Thompson"));
  console.log(`${trace.label}: ${trace.file}`);
  console.log(`  FD+T event recall: ${fdt ? pct(fdt.eventRecall) : "n/a"}`);
  console.log(`  W+T  event recall: ${wt ? pct(wt.eventRecall) : "n/a"}`);
  console.log(`  Profile-view TTFE median: ${fmtMs(run.profileViewTtfeMedianMs)}`);
  console.log(`  Profile-view hit rate: ${pct(run.profileViewHitRate)}`);
  console.log();
}

// --- Summary ---
console.log(`\n─── Summary ───\n`);

const allFdt = results.flatMap((r) => r.algos.filter((a) => a.name.includes("FD+Thompson")));
const allWt = results.flatMap((r) => r.algos.filter((a) => a.name.includes("Welshman+Thompson")));

console.log(`Profile-view latency is algorithm-independent (top-3 declared write relays).`);
console.log(`It measures how well the NIP-65 relay list infrastructure works for single-author lookups.`);
console.log();
console.log(`Feed event recall (main comparison):`);
console.log(`  FD+Thompson (per-author):      ${pct(mean(allFdt.map((a) => a.eventRecall)))}`);
console.log(`  Welshman+Thompson (global):     ${pct(mean(allWt.map((a) => a.eventRecall)))}`);
console.log(`  Delta (W+T minus FD+T):         ${pct(mean(allWt.map((a) => a.eventRecall)) - mean(allFdt.map((a) => a.eventRecall)))}`);
console.log();
console.log(`Profile-view TTFE (algorithm-independent):`);
console.log(`  Mean across ${pvMedians.length} runs:   ${fmtMs(mean(pvMedians))} median, ${fmtMs(mean(pvMeans))} mean`);
console.log(`  Hit rate:                ${pct(mean(pvHits))}`);
console.log();
console.log(`Key finding: Profile-view performance is identical for both algorithms because`);
console.log(`it uses the author's declared write relays (from NIP-65), not the algorithm's`);
console.log(`relay selection. The algorithms only differ in how they select relays for`);
console.log(`multi-author feed queries.`);
