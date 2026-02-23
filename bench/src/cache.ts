import { buildBenchmarkInput, benchmarkInputToSnapshot } from "./types.ts";
import type {
  BenchmarkInput,
  BenchmarkInputSnapshot,
  FilterProfile,
  Pubkey,
} from "./types.ts";

const CACHE_DIR = ".cache";
const SCHEMA_VERSION = 1;
const DEFAULT_TTL_MS = 3600 * 1000; // 1 hour

interface CacheEnvelope {
  schemaVersion: number;
  filterProfile: FilterProfile;
  indexerRelays: string[];
  fetchedAt: number;
  ttlSeconds: number;
  data: BenchmarkInputSnapshot;
}

async function ensureCacheDir(): Promise<void> {
  await Deno.mkdir(CACHE_DIR, { recursive: true });
}

async function sha256hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function indexerHash(indexerRelays: string[]): Promise<string> {
  const sorted = [...indexerRelays].sort();
  const full = await sha256hex(sorted.join(","));
  return full.slice(0, 8);
}

export async function cacheFilePath(
  targetPubkey: Pubkey,
  filterProfile: FilterProfile,
  indexerRelays: string[],
): Promise<string> {
  const ih = await indexerHash(indexerRelays);
  return `${CACHE_DIR}/${targetPubkey}_v${SCHEMA_VERSION}_${filterProfile}_${ih}.json`;
}

export async function readCachedInput(
  targetPubkey: Pubkey,
  filterProfile: FilterProfile,
  indexerRelays: string[],
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<BenchmarkInput | null> {
  const path = await cacheFilePath(targetPubkey, filterProfile, indexerRelays);

  try {
    const raw = await Deno.readTextFile(path);
    const envelope = JSON.parse(raw) as CacheEnvelope;

    if (envelope.schemaVersion !== SCHEMA_VERSION) return null;
    if (envelope.filterProfile !== filterProfile) return null;

    const sortedInput = [...indexerRelays].sort();
    const sortedCached = [...envelope.indexerRelays].sort();
    if (sortedInput.join(",") !== sortedCached.join(",")) return null;

    const age = Date.now() - envelope.fetchedAt;
    if (age > ttlMs) return null;

    if (
      !envelope.data?.follows ||
      !Array.isArray(envelope.data.follows) ||
      !Array.isArray(envelope.data.relayLists)
    ) {
      return null;
    }

    return buildBenchmarkInput(envelope.data);
  } catch {
    return null;
  }
}

export async function writeCachedInput(
  input: BenchmarkInput,
  filterProfile: FilterProfile,
  indexerRelays: string[],
): Promise<void> {
  await ensureCacheDir();
  const path = await cacheFilePath(
    input.targetPubkey,
    filterProfile,
    indexerRelays,
  );
  const snapshot = benchmarkInputToSnapshot(input);
  const envelope: CacheEnvelope = {
    schemaVersion: SCHEMA_VERSION,
    filterProfile,
    indexerRelays: [...indexerRelays].sort(),
    fetchedAt: input.fetchedAt,
    ttlSeconds: DEFAULT_TTL_MS / 1000,
    data: snapshot,
  };
  await Deno.writeTextFile(path, JSON.stringify(envelope, null, 2));
}
