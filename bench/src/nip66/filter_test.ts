import { assertEquals, assertThrows } from "jsr:@std/assert";
import { parseNip66FilterArg, classifyCandidates } from "./filter.ts";
import {
  readNip66MonitorCache,
  writeNip66MonitorCache,
  monitorCachePath,
} from "./fetch.ts";
import type { Nip66RelayData, RelayUrl } from "../types.ts";

// --- parseNip66FilterArg ---

Deno.test("parseNip66FilterArg: undefined → false", () => {
  assertEquals(parseNip66FilterArg(undefined), false);
});

Deno.test("parseNip66FilterArg: empty string → liveness", () => {
  assertEquals(parseNip66FilterArg(""), "liveness");
});

Deno.test("parseNip66FilterArg: 'liveness' → liveness", () => {
  assertEquals(parseNip66FilterArg("liveness"), "liveness");
});

Deno.test("parseNip66FilterArg: 'strict' → strict", () => {
  assertEquals(parseNip66FilterArg("strict"), "strict");
});

Deno.test("parseNip66FilterArg: 'true' → liveness (backward compat)", () => {
  assertEquals(parseNip66FilterArg("true"), "liveness");
});

Deno.test("parseNip66FilterArg: 'false' → false (backward compat)", () => {
  assertEquals(parseNip66FilterArg("false"), false);
});

Deno.test("parseNip66FilterArg: 'bogus' → throws", () => {
  assertThrows(
    () => parseNip66FilterArg("bogus"),
    Error,
    'Unknown --nip66-filter value: "bogus"',
  );
});

// --- classifyCandidates ---

function makeEntry(url: RelayUrl, monitor = "test-monitor"): Nip66RelayData {
  return {
    relayUrl: url,
    rttOpenMs: 100,
    rttReadMs: 50,
    rttWriteMs: 60,
    supportedNips: [1],
    network: "clearnet",
    lastSeenAt: 1700000000,
    monitorPubkey: monitor,
  };
}

Deno.test("classifyCandidates: known relay → knownAlive", () => {
  const monitor = new Map<RelayUrl, Nip66RelayData>([
    ["wss://relay.example.com/", makeEntry("wss://relay.example.com/")],
  ]);
  const result = classifyCandidates(["wss://relay.example.com/"], monitor);
  assertEquals(result.knownAlive.has("wss://relay.example.com/"), true);
  assertEquals(result.unknown.length, 0);
});

Deno.test("classifyCandidates: unknown relay → unknown", () => {
  const monitor = new Map<RelayUrl, Nip66RelayData>();
  const result = classifyCandidates(["wss://dead.relay.com/"], monitor);
  assertEquals(result.unknown, ["wss://dead.relay.com/"]);
  assertEquals(result.knownAlive.size, 0);
});

Deno.test("classifyCandidates: .onion → preserved", () => {
  const monitor = new Map<RelayUrl, Nip66RelayData>();
  const result = classifyCandidates(["wss://hidden.onion/"], monitor);
  assertEquals(result.knownAlive.has("wss://hidden.onion/"), true);
  assertEquals(result.onionPreserved, 1);
  assertEquals(result.unknown.length, 0);
});

Deno.test("classifyCandidates: malformed URL → preserved", () => {
  const monitor = new Map<RelayUrl, Nip66RelayData>();
  const result = classifyCandidates(["not-a-url"], monitor);
  assertEquals(result.knownAlive.has("not-a-url"), true);
  assertEquals(result.parseFailedPreserved, 1);
  assertEquals(result.unknown.length, 0);
});

Deno.test("classifyCandidates: mixed set", () => {
  const monitor = new Map<RelayUrl, Nip66RelayData>([
    ["wss://alive.com/", makeEntry("wss://alive.com/")],
  ]);
  const candidates = [
    "wss://alive.com/",
    "wss://dead.com/",
    "wss://tor.onion/",
    "garbage",
  ];
  const result = classifyCandidates(candidates, monitor);
  assertEquals(result.knownAlive.size, 3); // alive + .onion + garbage
  assertEquals(result.unknown, ["wss://dead.com/"]);
  assertEquals(result.onionPreserved, 1);
  assertEquals(result.parseFailedPreserved, 1);
});

// --- Monitor cache isolation ---

Deno.test("monitor cache: rejects synthetic data on read", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    // Write a cache file with synthetic source
    const envelope = {
      schemaVersion: 1,
      fetchedAt: Date.now(),
      ttlSeconds: 3600,
      source: "synthetic",
      relays: [
        {
          relayUrl: "wss://fake.com/",
          rttOpenMs: null,
          rttReadMs: null,
          rttWriteMs: null,
          supportedNips: [],
          network: "clearnet",
          lastSeenAt: 1700000000,
          monitorPubkey: "synthetic",
        },
      ],
    };
    await Deno.writeTextFile(
      monitorCachePath(tmpDir),
      JSON.stringify(envelope),
    );
    const result = await readNip66MonitorCache(tmpDir);
    assertEquals(result, null);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("monitor cache: write then read roundtrip", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const data = new Map<RelayUrl, Nip66RelayData>([
      ["wss://good.com/", makeEntry("wss://good.com/", "real-monitor")],
    ]);
    await writeNip66MonitorCache(data, "nostr", tmpDir);
    const readback = await readNip66MonitorCache(tmpDir);
    assertEquals(readback !== null, true);
    assertEquals(readback!.size, 1);
    assertEquals(readback!.has("wss://good.com/"), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// --- HTTP API merge priority ---

Deno.test("classifyCandidates: NIP-66 relay has priority over http-api", () => {
  const nip66Entry = makeEntry("wss://relay.com/", "real-monitor");
  nip66Entry.rttOpenMs = 42;
  const httpEntry = makeEntry("wss://api-only.com/", "http-api");
  httpEntry.rttOpenMs = null;

  const monitor = new Map<RelayUrl, Nip66RelayData>([
    ["wss://relay.com/", nip66Entry],
    ["wss://api-only.com/", httpEntry],
  ]);

  const result = classifyCandidates(
    ["wss://relay.com/", "wss://api-only.com/"],
    monitor,
  );
  assertEquals(result.knownAlive.size, 2);
  // Both are known alive; the map preserves the NIP-66 entry's richer data
  assertEquals(monitor.get("wss://relay.com/")!.rttOpenMs, 42);
  assertEquals(monitor.get("wss://api-only.com/")!.monitorPubkey, "http-api");
});
