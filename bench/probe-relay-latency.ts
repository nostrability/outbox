#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write
/**
 * Relay Latency Probe
 *
 * Probes all candidate relays in a user's outbox graph for:
 * - NIP-11 info document (HTTP)
 * - WebSocket connect latency
 * - Empty-filter round-trip time (EOSE RTT)
 * - Geo-inference from RTT
 *
 * Usage: deno task probe-latency <hex_pubkey>
 *        deno task probe-latency <hex_pubkey> --nip11-only
 */

import { fetchBenchmarkInput } from "./src/fetch.ts";
import { probeRelays, printProbeTable } from "./src/phase2/probe.ts";
import type { ProbeResult } from "./src/phase2/probe.ts";

async function main() {
  const args = Deno.args;
  const hex = args.find((a) => /^[a-f0-9]{64}$/.test(a));
  const nip11Only = args.includes("--nip11-only");

  if (!hex) {
    console.error("Usage: deno task probe-latency <64-char-hex-pubkey> [--nip11-only]");
    Deno.exit(1);
  }

  const prefix = hex.slice(0, 12);

  console.error(`Fetching relay data for ${prefix}...`);
  const input = await fetchBenchmarkInput({ targetPubkey: hex, filterProfile: "strict" });

  const candidateUrls = [...input.relayToWriters.keys()].sort();
  console.error(
    `Found ${candidateUrls.length} candidate relays. Probing${nip11Only ? " (NIP-11 only)" : ""}...`,
  );

  const results = await probeRelays(candidateUrls, {
    concurrency: 15,
    nip11Only,
  });

  printProbeTable(results);

  // Summary stats
  const connectable = results.filter((r) => r.connectable);
  const withRtt = results.filter((r) => r.rttMs != null);
  const nip11Ok = results.filter((r) => r.nip11Available);
  const offline = results.filter((r) => !r.connectable && !r.nip11Available);

  console.log(`\n## Summary`);
  console.log(`  Total relays: ${results.length}`);
  console.log(`  Connectable: ${connectable.length} (${pct(connectable.length, results.length)})`);
  console.log(`  NIP-11 available: ${nip11Ok.length} (${pct(nip11Ok.length, results.length)})`);
  console.log(`  RTT measured: ${withRtt.length}`);
  console.log(`  Offline/unreachable: ${offline.length} (${pct(offline.length, results.length)})`);

  // NIP-11 software breakdown
  const softwareCounts = new Map<string, number>();
  for (const r of nip11Ok) {
    const sw = r.nip11Info?.software?.replace(/^git\+/, "").replace(/\.git$/, "") ?? "unknown";
    const short = sw.includes("/") ? sw.split("/").pop()! : sw;
    softwareCounts.set(short, (softwareCounts.get(short) ?? 0) + 1);
  }
  if (softwareCounts.size > 0) {
    console.log(`\n  Relay software:`);
    for (const [sw, count] of [...softwareCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${sw}: ${count}`);
    }
  }

  // Cache results
  try {
    await Deno.mkdir(".cache", { recursive: true });
    const cacheData = {
      pubkey: hex,
      probedAt: new Date().toISOString(),
      totalCandidates: candidateUrls.length,
      nip11Only,
      results: results.map(serializeResult),
    };
    const cachePath = `.cache/relay_latency_${prefix}.json`;
    await Deno.writeTextFile(cachePath, JSON.stringify(cacheData, null, 2));
    console.error(`\nResults cached to ${cachePath}`);
  } catch (e) {
    console.error(`Warning: could not write cache: ${e}`);
  }
}

function pct(n: number, total: number): string {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0%";
}

function serializeResult(r: ProbeResult): Record<string, unknown> {
  return {
    relay: r.relay,
    nip11Available: r.nip11Available,
    nip11Ms: r.nip11Ms != null ? Math.round(r.nip11Ms) : null,
    connectable: r.connectable,
    connectMs: r.connectMs != null ? Math.round(r.connectMs) : null,
    rttMs: r.rttMs != null ? Math.round(r.rttMs) : null,
    latencyMs: r.latencyMs != null ? Math.round(r.latencyMs) : null,
    geoHint: r.geoHint ?? null,
    nip11Info: r.nip11Info ?? null,
    error: r.error ?? null,
  };
}

main();
