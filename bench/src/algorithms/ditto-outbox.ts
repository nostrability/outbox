import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
} from "../types.ts";
import { sampleBeta } from "./beta.ts";

/**
 * Ditto-Mew + Outbox Thompson
 *
 * Models the implementation where profile views combine:
 * 1. The 4 hardcoded app relays (broadcast, same as baseline ditto-mew)
 * 2. Up to 3 of the viewed author's NIP-65 write relays, scored by Thompson Sampling
 *
 * This matches what the useProfileFeed.ts outbox routing does:
 * - App relay query runs unchanged (fast path)
 * - In parallel, fetch author's kind 10002, extract write relays,
 *   score with Thompson, pick top 3, query them
 *
 * Cold start: Beta(1,1) = uniform random = no worse than baseline.
 * Warm start: relays that historically delivered get higher scores.
 *
 * The main feed is NOT modeled here — this only benchmarks the
 * profile/event lookup path where outbox routing is active.
 */
const APP_RELAYS: RelayUrl[] = [
  "wss://relay.ditto.pub",
  "wss://relay.primal.net",
  "wss://relay.damus.io",
  "wss://nos.lol",
];

export function dittoOutbox(
  input: BenchmarkInput,
  params: AlgorithmParams,
  rng: () => number,
): AlgorithmResult {
  const start = performance.now();
  const writeLimit = Math.max(0, Math.floor(Number(params.writeLimit) || 3));
  const relayPriors = params.relayPriors;

  const relayAssignments = new Map<RelayUrl, Set<Pubkey>>();
  const pubkeyAssignments = new Map<Pubkey, Set<RelayUrl>>();
  const orphanedPubkeys = new Set<Pubkey>();

  // Initialize app relay assignments
  const allFollows = new Set(input.follows);
  for (const relay of APP_RELAYS) {
    relayAssignments.set(relay, new Set(allFollows));
  }

  let priorsUsed = 0;
  const priorsTotal = relayPriors ? relayPriors.size : 0;
  let authorsWithOutbox = 0;

  for (const pubkey of input.follows) {
    // Every author gets all 4 app relays (broadcast baseline)
    const selected = new Set<RelayUrl>(APP_RELAYS);

    // Additionally, look up their NIP-65 write relays and pick top 3 by Thompson
    const authorRelays = input.writerToRelays.get(pubkey);
    if (authorRelays && authorRelays.size > 0) {
      // Filter out relays already in the app set
      const appSet = new Set(APP_RELAYS);
      const candidates: RelayUrl[] = [];
      for (const relay of authorRelays) {
        if (!appSet.has(relay)) {
          candidates.push(relay);
        }
      }

      if (candidates.length > 0) {
        // Score each candidate by Thompson sample
        const scored: { relay: RelayUrl; score: number }[] = [];
        for (const relay of candidates) {
          const prior = relayPriors?.get(relay);
          const sample = prior
            ? sampleBeta(prior.alpha, prior.beta, rng)
            : sampleBeta(1, 1, rng);

          if (prior) priorsUsed++;
          scored.push({ relay, score: sample });
        }

        // Sort by score descending
        scored.sort((a, b) => {
          if (a.score !== b.score) return b.score - a.score;
          return a.relay < b.relay ? -1 : a.relay > b.relay ? 1 : 0;
        });

        // Pick top writeLimit
        const limit = Math.min(writeLimit, scored.length);
        for (let i = 0; i < limit; i++) {
          const relay = scored[i].relay;
          selected.add(relay);

          const writers = relayAssignments.get(relay) ?? new Set<Pubkey>();
          writers.add(pubkey);
          relayAssignments.set(relay, writers);
        }

        authorsWithOutbox++;
      }
    }

    pubkeyAssignments.set(pubkey, selected);
  }

  const notes: string[] = [
    `App relays: ${APP_RELAYS.length} (broadcast to all ${input.follows.length} authors)`,
    `Outbox: ${authorsWithOutbox}/${input.follows.length} authors got additional write relays (top ${writeLimit})`,
  ];
  if (relayPriors && relayPriors.size > 0) {
    notes.push(`Thompson Sampling: ${priorsTotal} relay priors loaded, ${priorsUsed} prior lookups used`);
  } else {
    notes.push("Thompson Sampling: cold start (uniform priors)");
  }

  return {
    name: "Ditto+Outbox Thompson",
    relayAssignments,
    pubkeyAssignments,
    orphanedPubkeys, // no orphans — everyone gets app relays at minimum
    params,
    executionTimeMs: performance.now() - start,
    notes,
  };
}
