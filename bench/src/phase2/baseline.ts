/**
 * Phase 2: Ground truth collection from all declared write relays.
 *
 * For each relay in relayToWriters, query all its writers for kind 1 events
 * in the time window. Results populate the query cache and build per-pubkey
 * baselines with exhaustive 4-way classification.
 */

import type { RelayPool } from "../relay-pool.ts";
import type { QueryCache } from "../relay-pool.ts";
import type {
  BenchmarkInput,
  Phase2Options,
  Pubkey,
  PubkeyBaseline,
  RelayUrl,
} from "../types.ts";

export async function collectBaseline(
  input: BenchmarkInput,
  pool: RelayPool,
  cache: QueryCache,
  options: Phase2Options,
): Promise<Map<Pubkey, PubkeyBaseline>> {
  const since = Math.floor(Date.now() / 1000) - options.windowSeconds;
  const relays = [...input.relayToWriters.keys()];

  console.error(
    `[baseline] Querying ${relays.length} relays for ${input.writerToRelays.size} authors (window: ${options.windowSeconds}s)`,
  );

  // Track per-relay EOSE status
  const relayReachedEose = new Map<RelayUrl, boolean>();

  // Process all relays concurrently (gated by pool semaphore)
  const tasks = relays.map(async (relay) => {
    const writers = input.relayToWriters.get(relay);
    if (!writers || writers.size === 0) return;

    const pubkeys = [...writers];
    const { reachedEose } = await pool.queryBatched(
      relay,
      pubkeys,
      { kinds: options.kinds, since },
      options.batchSize,
      cache,
    );

    relayReachedEose.set(relay, reachedEose);
  });

  // Log progress periodically
  let completed = 0;
  const total = tasks.length;
  const progressTasks = tasks.map(async (task) => {
    await task;
    completed++;
    if (completed % 50 === 0 || completed === total) {
      console.error(`[baseline] Progress: ${completed}/${total} relays queried`);
    }
  });

  await Promise.all(progressTasks);

  // Build per-pubkey baselines
  const baselines = new Map<Pubkey, PubkeyBaseline>();

  for (const [pubkey, declaredRelays] of input.writerToRelays) {
    const eventIds = new Set<string>();
    const relaysSucceeded = new Set<RelayUrl>();
    const relaysFailed = new Set<RelayUrl>();
    const relaysWithEvents = new Set<RelayUrl>();

    for (const relay of declaredRelays) {
      const outcome = pool.getRelayOutcome(relay);
      const eose = relayReachedEose.get(relay) ?? false;

      if (outcome?.connected && eose) {
        relaysSucceeded.add(relay);
        const ids = cache.get(relay, pubkey);
        if (ids && ids.size > 0) {
          relaysWithEvents.add(relay);
          for (const id of ids) eventIds.add(id);
        }
      } else {
        relaysFailed.add(relay);
      }
    }

    const relaysQueried = declaredRelays.size;
    const successRate = relaysQueried > 0
      ? relaysSucceeded.size / relaysQueried
      : 0;
    const reliability = successRate >= 0.5 ? "reliable" as const : "partial" as const;
    const hasEvents = eventIds.size > 0;

    let classification: PubkeyBaseline["classification"];
    if (hasEvents && reliability === "reliable") {
      classification = "testable-reliable";
    } else if (hasEvents && reliability === "partial") {
      classification = "testable-partial";
    } else if (!hasEvents && reliability === "reliable") {
      classification = "zero-baseline";
    } else {
      classification = "unreliable";
    }

    baselines.set(pubkey, {
      pubkey,
      eventIds,
      relaysQueried,
      relaysSucceeded,
      relaysFailed,
      relaysWithEvents,
      reliability,
      classification,
    });
  }

  return baselines;
}
