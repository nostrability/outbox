#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write
/**
 * NIP-11 Relay Classification Probe
 *
 * Fetches NIP-11 info documents from all candidate relays in a user's
 * outbox graph, classifies them, and prints a summary table.
 *
 * Usage: deno run --allow-net --allow-read --allow-write probe-nip11.ts <hex_pubkey>
 */

import { fetchBenchmarkInput } from "./src/fetch.ts";

const CONCURRENCY = 15;
const FETCH_TIMEOUT_MS = 5_000;

type Category = "content" | "paid" | "auth-gated" | "restricted" | "no-nip11" | "offline";

interface Nip11Result {
  url: string;
  category: Category;
  name?: string;
  description?: string;
  raw?: Record<string, unknown>;
}

function wsToHttp(wsUrl: string): string {
  return wsUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
}

function classify(doc: Record<string, unknown>): Category {
  const limitation = doc.limitation as Record<string, unknown> | undefined;
  if (limitation) {
    if (limitation.payment_required === true) return "paid";
    if (limitation.auth_required === true) return "auth-gated";
    if (limitation.restricted_writes === true) return "restricted";
  }
  return "content";
}

async function probeRelay(url: string): Promise<Nip11Result> {
  const httpUrl = wsToHttp(url);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const resp = await fetch(httpUrl, {
      headers: { Accept: "application/nostr+json" },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      return { url, category: "no-nip11" };
    }

    const text = await resp.text();
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(text);
    } catch {
      return { url, category: "no-nip11" };
    }

    const category = classify(doc);
    return {
      url,
      category,
      name: typeof doc.name === "string" ? doc.name : undefined,
      description: typeof doc.description === "string" ? doc.description : undefined,
      raw: doc,
    };
  } catch {
    return { url, category: "offline" };
  }
}

async function probeAll(urls: string[]): Promise<Nip11Result[]> {
  const results: Nip11Result[] = [];
  const queue = [...urls];

  async function worker() {
    while (queue.length > 0) {
      const url = queue.shift()!;
      results.push(await probeRelay(url));
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, urls.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  const hex = Deno.args[0];
  if (!hex || !/^[a-f0-9]{64}$/.test(hex)) {
    console.error("Usage: deno run ... probe-nip11.ts <64-char-hex-pubkey>");
    Deno.exit(1);
  }

  const prefix = hex.slice(0, 12);

  console.error(`Fetching relay data for ${prefix}...`);
  const input = await fetchBenchmarkInput({ targetPubkey: hex, filterProfile: "strict" });

  const candidateUrls = [...input.relayToWriters.keys()].sort();
  console.error(`Found ${candidateUrls.length} candidate relays. Probing NIP-11...`);

  const results = await probeAll(candidateUrls);

  // Group by category
  const grouped = new Map<Category, Nip11Result[]>();
  for (const r of results) {
    const list = grouped.get(r.category) ?? [];
    list.push(r);
    grouped.set(r.category, list);
  }

  const responded = results.filter((r) => r.category !== "no-nip11" && r.category !== "offline").length;
  const notResponded = results.length - responded;

  // Print summary
  console.log(`\n## NIP-11 Relay Classification: ${prefix}`);
  console.log(`\nCandidate relays: ${candidateUrls.length}`);
  console.log(`Probed: ${results.length} (${responded} responded, ${notResponded} no NIP-11/offline)\n`);

  const categories: Category[] = ["content", "paid", "auth-gated", "restricted", "no-nip11", "offline"];

  console.log(`| Category       | Count | % of candidates | Example relays            |`);
  console.log(`|----------------|-------|-----------------|---------------------------|`);
  for (const cat of categories) {
    const items = grouped.get(cat) ?? [];
    const pct = candidateUrls.length > 0 ? ((items.length / candidateUrls.length) * 100).toFixed(1) : "0.0";
    const examples = items
      .slice(0, 3)
      .map((r) => r.url.replace(/^wss:\/\//, ""))
      .join(", ");
    const padCat = cat.padEnd(14);
    const padCount = String(items.length).padStart(5);
    const padPct = `${pct}%`.padStart(15);
    console.log(`| ${padCat} | ${padCount} | ${padPct} | ${examples.padEnd(25)} |`);
  }

  // Detail sections for non-content categories
  for (const cat of ["paid", "auth-gated", "restricted"] as Category[]) {
    const items = grouped.get(cat) ?? [];
    if (items.length === 0) continue;
    console.log(`\n### ${cat.charAt(0).toUpperCase() + cat.slice(1)} relays (${items.length})`);
    for (const r of items) {
      const desc = r.description ? ` — "${r.description.slice(0, 80)}"` : "";
      console.log(`${r.url}${desc}`);
    }
  }

  // Cache results
  try {
    await Deno.mkdir(".cache", { recursive: true });
    const cacheData = {
      pubkey: hex,
      probedAt: new Date().toISOString(),
      totalCandidates: candidateUrls.length,
      results: results.map((r) => ({
        url: r.url,
        category: r.category,
        name: r.name,
        description: r.description,
      })),
    };
    const cachePath = `.cache/nip11_probe_${prefix}.json`;
    await Deno.writeTextFile(cachePath, JSON.stringify(cacheData, null, 2));
    console.error(`\nResults cached to ${cachePath}`);
  } catch (e) {
    console.error(`Warning: could not write cache: ${e}`);
  }
}

main();
