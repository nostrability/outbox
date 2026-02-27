/**
 * Probe: Do relays return historical kind-10002 (NIP-65) events?
 *
 * Kind-10002 is a replaceable event (kind 10000-19999), so per NIP-01
 * relays SHOULD only keep the latest. But some archive relays may keep
 * older versions. This script checks.
 *
 * If relays only return 1 event per author, historical NIP-65 walk-back
 * is dead on arrival — the old relay lists are gone.
 *
 * Usage: deno run --allow-net --allow-read bench/probe-historical-nip65.ts
 */

import { dirname, fromFileUrl, join } from "jsr:@std/path@^1";
import { expandGlob } from "jsr:@std/fs@^1/expand-glob";

const SCRIPT_DIR = dirname(fromFileUrl(import.meta.url));
const CACHE_DIR = join(SCRIPT_DIR, ".cache");

// Relays to probe — mix of indexers, archives, and major relays
const PROBE_RELAYS = [
  "wss://purplepag.es",
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://nostr-pub.wellorder.net",
  "wss://relay.primal.net",
  "wss://nostr.wine",
];

const SAMPLE_SIZE = 50;
const EOSE_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 8_000;

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
}

// --- load sample pubkeys from cache ---

async function loadSamplePubkeys(): Promise<string[]> {
  const all: string[] = [];
  for await (const entry of expandGlob(join(CACHE_DIR, "phase2_*_31536000_*.json"))) {
    const raw = await Deno.readTextFile(entry.path);
    const data = JSON.parse(raw);
    for (const b of data.baselines) {
      if (b.classification === "testable-reliable") {
        all.push(b.pubkey);
      }
    }
  }
  // Dedupe and sample
  const unique = [...new Set(all)];
  const step = Math.max(1, Math.floor(unique.length / SAMPLE_SIZE));
  const sample: string[] = [];
  for (let i = 0; i < unique.length && sample.length < SAMPLE_SIZE; i += step) {
    sample.push(unique[i]);
  }
  return sample;
}

// --- minimal websocket client ---

function queryRelay(
  url: string,
  pubkeys: string[],
): Promise<{ relay: string; events: NostrEvent[]; error?: string }> {
  return new Promise((resolve) => {
    const events: NostrEvent[] = [];
    const subId = "probe-hist";

    const connectTimeout = setTimeout(() => {
      resolve({ relay: url, events, error: "connect timeout" });
    }, CONNECT_TIMEOUT_MS);

    try {
      const ws = new WebSocket(url);

      ws.onopen = () => {
        clearTimeout(connectTimeout);
        ws.send(JSON.stringify(["REQ", subId, { kinds: [10002], authors: pubkeys }]));

        setTimeout(() => {
          try { ws.close(); } catch { /* ignore */ }
          resolve({ relay: url, events });
        }, EOSE_TIMEOUT_MS);
      };

      ws.onmessage = (msg: MessageEvent) => {
        try {
          const data = JSON.parse(msg.data);
          if (Array.isArray(data)) {
            if (data[0] === "EVENT" && data[1] === subId && data[2]) {
              events.push(data[2] as NostrEvent);
            }
            if (data[0] === "EOSE" && data[1] === subId) {
              try { ws.close(); } catch { /* ignore */ }
              resolve({ relay: url, events });
            }
          }
        } catch { /* ignore parse errors */ }
      };

      ws.onerror = () => {
        clearTimeout(connectTimeout);
        resolve({ relay: url, events, error: "websocket error" });
      };

      ws.onclose = () => {
        clearTimeout(connectTimeout);
        resolve({ relay: url, events });
      };
    } catch (err) {
      clearTimeout(connectTimeout);
      resolve({ relay: url, events, error: String(err) });
    }
  });
}

// --- main ---

async function main() {
  console.error("Loading sample pubkeys from cache...");
  const pubkeys = await loadSamplePubkeys();
  console.error(`Sampled ${pubkeys.length} testable-reliable authors\n`);

  console.error(`Probing ${PROBE_RELAYS.length} relays for historical kind-10002 events...\n`);

  const results = await Promise.all(
    PROBE_RELAYS.map((url) => queryRelay(url, pubkeys)),
  );

  // Analyse
  const pad = (s: string, n: number) => s.padEnd(n);

  console.log(pad("Relay", 36) + "  events  authors  multi  max-span-days  example");
  console.log("-".repeat(105));

  for (const r of results) {
    if (r.error) {
      console.log(`${pad(r.relay, 36)}  ERROR: ${r.error}`);
      continue;
    }

    const byPubkey = new Map<string, NostrEvent[]>();
    for (const e of r.events) {
      const list = byPubkey.get(e.pubkey) ?? [];
      list.push(e);
      byPubkey.set(e.pubkey, list);
    }

    let multiCount = 0;
    let maxSpanDays = 0;
    let exampleAuthor = "";
    let exampleEventCount = 0;

    for (const [pk, events] of byPubkey) {
      if (events.length > 1) {
        multiCount++;
        events.sort((a, b) => a.created_at - b.created_at);
        const span = Math.floor((events[events.length - 1].created_at - events[0].created_at) / 86400);
        if (span > maxSpanDays) {
          maxSpanDays = span;
          exampleAuthor = pk.slice(0, 12) + "...";
          exampleEventCount = events.length;
        }
      }
    }

    const maxStr = multiCount > 0 ? String(maxSpanDays) : "-";
    const exStr = multiCount > 0 ? `${exampleAuthor} (${exampleEventCount} evts)` : "-";

    console.log(
      `${pad(r.relay, 36)}  ${String(r.events.length).padStart(6)}  ${String(byPubkey.size).padStart(7)}  ${String(multiCount).padStart(5)}  ${maxStr.padStart(13)}  ${exStr}`
    );
  }

  // Deep dive: show relay-list churn for authors with multiple events on purplepag.es
  const purp = results.find((r) => r.relay === "wss://purplepag.es");
  if (purp && !purp.error) {
    const byPk = new Map<string, NostrEvent[]>();
    for (const e of purp.events) {
      const list = byPk.get(e.pubkey) ?? [];
      list.push(e);
      byPk.set(e.pubkey, list);
    }

    const churners = [...byPk.entries()]
      .filter(([, evts]) => evts.length > 1)
      .sort((a, b) => b[1].length - a[1].length);

    if (churners.length > 0) {
      console.log("\n--- Relay list churn detail (purplepag.es) ---\n");
      for (const [pk, events] of churners.slice(0, 5)) {
        events.sort((a, b) => a.created_at - b.created_at);
        console.log(`Author ${pk.slice(0, 16)}... (${events.length} versions):`);

        // Extract write relays from each version
        let prevRelays = new Set<string>();
        for (const e of events) {
          const writeRelays = new Set<string>();
          for (const tag of e.tags) {
            if (tag[0] === "r" && tag[1]) {
              const marker = tag[2]?.toLowerCase();
              if (!marker || marker === "write") writeRelays.add(tag[1]);
            }
          }
          const date = new Date(e.created_at * 1000).toISOString().slice(0, 10);
          const added = [...writeRelays].filter((r) => !prevRelays.has(r));
          const removed = [...prevRelays].filter((r) => !writeRelays.has(r));
          console.log(`  ${date}: ${writeRelays.size} write relays` +
            (added.length > 0 ? `  +${added.length} added` : "") +
            (removed.length > 0 ? `  -${removed.length} removed` : ""));
          if (added.length > 0 && added.length <= 3) console.log(`    added: ${added.join(", ")}`);
          if (removed.length > 0 && removed.length <= 3) console.log(`    removed: ${removed.join(", ")}`);
          prevRelays = writeRelays;
        }
        console.log();
      }
    }
  }

  // Verdict
  console.log("--- Verdict ---\n");
  const relaysWithMulti = results.filter((r) => {
    const byPk = new Map<string, number>();
    for (const e of r.events) byPk.set(e.pubkey, (byPk.get(e.pubkey) ?? 0) + 1);
    return [...byPk.values()].some((c) => c > 1);
  });

  if (relaysWithMulti.length === 0) {
    console.log("No relay returned multiple kind-10002 events per author.");
    console.log("Historical NIP-65 walk-back is NOT feasible — old relay lists are gone.");
  } else {
    console.log(`${relaysWithMulti.length}/${PROBE_RELAYS.length} relays returned historical kind-10002.`);
    console.log(`But kind-10002 is replaceable per NIP-01 — most relays correctly discard old versions.`);
    console.log(`Historical walk-back would need a dedicated archive, not standard relays.`);
  }
}

main();
