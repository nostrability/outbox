/**
 * Relay Event Availability by Time Depth (outbox-b5v)
 *
 * Analyses cached phase2 data to show how event availability drops
 * across time windows per relay. Zero network — reads only from cache.
 *
 * Usage: deno run --allow-read bench/retention-profile.ts [--min-authors N] [--json]
 */

import { expandGlob } from "jsr:@std/fs@^1/expand-glob";
import { parseArgs } from "jsr:@std/cli@^1/parse-args";
import { dirname, fromFileUrl, join } from "jsr:@std/path@^1";

// --- types matching phase2 cache schema ---

interface Baseline {
  pubkey: string;
  classification: string;
  relaysSucceeded: string[];
  relaysWithEvents: string[];
}

interface Phase2Cache {
  pubkey: string;
  windowSeconds: number;
  followCount: number;
  relayCount: number;
  baselines: Baseline[];
}

// --- config ---

const DISPLAY_WINDOWS = [604800, 31536000, 94608000]; // 7d, 1yr, 3yr

// --- accumulation ---

// key: `${relay}\t${window}`
const withEventsCount = new Map<string, number>();
const testableCount = new Map<string, number>();

function key(relay: string, window: number): string {
  return `${relay}\t${window}`;
}

function inc(map: Map<string, number>, k: string): void {
  map.set(k, (map.get(k) ?? 0) + 1);
}

// --- pick best file per (profile, window) ---

interface FileInfo {
  path: string;
  profile: string;
  window: number;
  relayCount: number;
}

const SCRIPT_DIR = dirname(fromFileUrl(import.meta.url));
const CACHE_DIR = join(SCRIPT_DIR, ".cache");

async function pickBestFiles(): Promise<FileInfo[]> {
  const all: FileInfo[] = [];
  for await (const entry of expandGlob(join(CACHE_DIR, "phase2_*.json"))) {
    const parts = entry.name.replace(".json", "").split("_");
    // phase2_{profile}_{window}_{follows}_{relays}
    all.push({
      path: entry.path,
      profile: parts[1],
      window: Number(parts[2]),
      relayCount: Number(parts[4]),
    });
  }

  // Group by (profile, window), keep file with most relays
  const best = new Map<string, FileInfo>();
  for (const f of all) {
    const k = `${f.profile}_${f.window}`;
    const existing = best.get(k);
    if (!existing || f.relayCount > existing.relayCount) {
      best.set(k, f);
    }
  }
  return [...best.values()];
}

// --- main ---

async function main() {
  const args = parseArgs(Deno.args, {
    default: { "min-authors": 3, json: false },
    boolean: ["json"],
    string: ["min-authors"],
  });
  const minAuthors = Number(args["min-authors"]);
  const jsonOutput = args.json;

  const files = await pickBestFiles();
  if (files.length === 0) {
    console.error(`No phase2 cache files found in ${CACHE_DIR}`);
    Deno.exit(1);
  }

  // Process each file
  for (const file of files) {
    const raw = await Deno.readTextFile(file.path);
    const data: Phase2Cache = JSON.parse(raw);

    for (const b of data.baselines) {
      if (b.classification !== "testable-reliable") continue;

      for (const relay of b.relaysWithEvents) {
        inc(withEventsCount, key(relay, data.windowSeconds));
      }
      for (const relay of b.relaysSucceeded) {
        inc(testableCount, key(relay, data.windowSeconds));
      }
    }
  }

  // Collect all relays
  const allRelays = new Set<string>();
  for (const k of testableCount.keys()) {
    allRelays.add(k.split("\t")[0]);
  }

  // Build rows
  type Row = {
    relay: string;
    windows: Record<number, { withEvents: number; testable: number; rate: number }>;
    authors: number; // max testable across windows
    dropOff: number;
  };

  const rows: Row[] = [];
  for (const relay of allRelays) {
    const windows: Row["windows"] = {};
    let maxTestable = 0;

    for (const w of DISPLAY_WINDOWS) {
      const we = withEventsCount.get(key(relay, w)) ?? 0;
      const t = testableCount.get(key(relay, w)) ?? 0;
      windows[w] = { withEvents: we, testable: t, rate: t > 0 ? we / t : 0 };
      if (t > maxTestable) maxTestable = t;
    }

    if (maxTestable < minAuthors) continue;

    const rates = DISPLAY_WINDOWS.map((w) => windows[w].rate).filter((r) => r > 0);
    const dropOff = rates.length >= 2 ? 1 - Math.min(...rates) / Math.max(...rates) : 0;

    rows.push({ relay, windows, authors: maxTestable, dropOff });
  }

  // Sort by 1yr availability descending
  rows.sort((a, b) => (b.windows[31536000]?.rate ?? 0) - (a.windows[31536000]?.rate ?? 0));

  if (jsonOutput) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  // --- print table ---
  const pad = (s: string, n: number) => s.padEnd(n);
  const pct = (r: number) => r > 0 ? `${(r * 100).toFixed(0)}%`.padStart(5) : "   - ";

  const hdr = `${pad("Relay", 40)}  ${pad("7d", 5)}  ${pad("1yr", 5)}  ${pad("3yr", 5)}  ${pad("drop", 5)}  authors`;
  console.log(hdr);
  console.log("-".repeat(hdr.length));

  for (const row of rows) {
    const cols = DISPLAY_WINDOWS.map((w) => pct(row.windows[w].rate));
    const drop = pct(row.dropOff);
    const relay = row.relay.length > 39 ? row.relay.slice(0, 36) + "..." : row.relay;
    console.log(
      `${pad(relay, 40)}  ${cols[0]}  ${cols[1]}  ${cols[2]}  ${drop}  ${String(row.authors).padStart(5)}`
    );
  }

  // --- summary ---
  console.log();
  const relaysWithOneYr = rows.filter((r) => r.windows[31536000]?.rate > 0.5);
  console.log(
    `Relays with >50% availability at 1yr: ${relaysWithOneYr.length} of ${rows.length}`
  );

  const oneYrRates = rows
    .map((r) => r.windows[31536000]?.rate ?? 0)
    .filter((r) => r > 0)
    .sort((a, b) => a - b);
  if (oneYrRates.length > 0) {
    const mid = Math.floor(oneYrRates.length / 2);
    const median =
      oneYrRates.length % 2 === 1
        ? oneYrRates[mid]
        : (oneYrRates[mid - 1] + oneYrRates[mid]) / 2;
    console.log(`Median 1yr availability: ${(median * 100).toFixed(0)}%`);
  }

  console.log();
  const significant = rows.filter((r) => r.authors >= 20);
  console.log(`Top 10 relays by 1yr availability (≥20 authors):`);
  for (const row of significant.slice(0, 10)) {
    console.log(`  ${row.relay}  ${pct(row.windows[31536000].rate).trim()}  (${row.authors} authors)`);
  }
}

main();
