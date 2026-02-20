import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
} from "../types.ts";

/**
 * Priority-Based (NDK style)
 * Per-author: prefer relays already selected for other authors (connection reuse),
 * then popularity-ranked. Tie-break: lexicographically smaller URL.
 * Author iteration order: sorted by hex pubkey (deterministic).
 */
export function priorityBased(
  input: BenchmarkInput,
  params: AlgorithmParams,
  _rng: () => number,
): AlgorithmResult {
  const start = performance.now();
  const relayGoalPerAuthor = params.relayGoalPerAuthor ?? params.maxRelaysPerUser ?? 2;
  const maxConnections = params.maxConnections ?? Infinity;

  const relayAssignments = new Map<RelayUrl, Set<Pubkey>>();
  const pubkeyAssignments = new Map<Pubkey, Set<RelayUrl>>();
  const orphanedPubkeys = new Set<Pubkey>();

  // Track which relays are "selected" (have at least one assignment)
  const selectedRelays = new Set<RelayUrl>();

  // Precompute relay popularity (how many follows write to each relay)
  const relayPopularity = new Map<RelayUrl, number>();
  for (const [relay, writers] of input.relayToWriters) {
    relayPopularity.set(relay, writers.size);
  }

  // Process authors in deterministic order (sorted by hex pubkey)
  const sortedFollows = [...input.follows].sort();

  for (const pubkey of sortedFollows) {
    const authorRelays = input.writerToRelays.get(pubkey);
    if (!authorRelays || authorRelays.size === 0) {
      orphanedPubkeys.add(pubkey);
      continue;
    }

    // Sort candidate relays: already-selected first, then by popularity desc, tie-break URL asc
    const candidates = [...authorRelays].sort((a, b) => {
      const aSelected = selectedRelays.has(a) ? 1 : 0;
      const bSelected = selectedRelays.has(b) ? 1 : 0;
      if (aSelected !== bSelected) return bSelected - aSelected; // selected first

      const aPop = relayPopularity.get(a) ?? 0;
      const bPop = relayPopularity.get(b) ?? 0;
      if (aPop !== bPop) return bPop - aPop; // higher popularity first

      return a < b ? -1 : a > b ? 1 : 0; // lexicographic tie-break
    });

    let assigned = 0;
    const pubkeyRelays = new Set<RelayUrl>();

    for (const relay of candidates) {
      if (assigned >= relayGoalPerAuthor) break;

      // If relay not yet selected and we're at the cap, skip
      if (!selectedRelays.has(relay) && selectedRelays.size >= maxConnections) {
        continue;
      }

      pubkeyRelays.add(relay);
      selectedRelays.add(relay);

      const writers = relayAssignments.get(relay) ?? new Set<Pubkey>();
      writers.add(pubkey);
      relayAssignments.set(relay, writers);

      assigned++;
    }

    if (pubkeyRelays.size > 0) {
      pubkeyAssignments.set(pubkey, pubkeyRelays);
    } else {
      orphanedPubkeys.add(pubkey);
    }
  }

  return {
    name: "Priority-Based (NDK)",
    relayAssignments,
    pubkeyAssignments,
    orphanedPubkeys,
    params,
    executionTimeMs: performance.now() - start,
  };
}
