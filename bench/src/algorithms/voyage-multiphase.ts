import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
} from "../types.ts";

/**
 * Voyage Multi-Phase (deterministic benchmark port)
 *
 * Faithful port of Voyage's RelayProvider.getObserveRelays() with
 * benchmark-appropriate adaptations:
 *
 * Phase 1 (NIP-65 sort-and-take): Group relayToWriters by relay, sort by
 *   coverage count descending (tie-break: URL ascending). Take top
 *   maxConnections relays. Assign each pubkey to exactly 1 relay via
 *   pubkeyCache tracking. Cap at MAX_KEYS (750) pubkeys per relay.
 *
 * Phase 2 (event history): SKIPPED — runtime learning data unavailable
 *   in static benchmark.
 *
 * Phase 3 (orphan distribution): Pubkeys not yet assigned get distributed
 *   across already-selected relays from Phase 1.
 *
 * Phase 4 (redundancy pass): Pubkeys mapped to only 1 relay get added to
 *   additional already-selected relays (ensures ≥2 relays per pubkey where
 *   possible).
 *
 * Deterministic: replaces Voyage's takeRandom()/shuffled() with sorted-by-hex.
 * MAX_KEYS=750 never binds at profile sizes ≤2,784.
 *
 * Defaults: maxConnections=25 (MAX_AUTOPILOT_RELAYS), maxRelaysPerUser=2.
 */

const MAX_KEYS = 750;

export function voyageMultiphase(
  input: BenchmarkInput,
  params: AlgorithmParams,
  _rng: () => number,
): AlgorithmResult {
  const start = performance.now();
  const maxConnections = params.maxConnections ?? 25;
  const _maxRelaysPerUser = params.maxRelaysPerUser ?? 2;

  const result = new Map<RelayUrl, Set<Pubkey>>();
  const followsSet = new Set(input.follows);

  // ── Phase 1: Cover pubkey-write-relay pairing ──────────────────────
  // Sort relays by coverage count descending, tie-break URL ascending.
  // In the live app, secondary sorts are by eventRelays membership,
  // connection status, and disconnected status — none available in a
  // static benchmark, so coverage-count sort is the sole criterion
  // (same degeneration as Nostur without skipTopRelays).
  const pubkeyCache = new Set<Pubkey>();

  const sortedRelays = [...input.relayToWriters.entries()]
    .sort((a, b) => {
      if (a[1].size !== b[1].size) return b[1].size - a[1].size;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });

  const selectedRelays = sortedRelays.slice(0, maxConnections);

  for (const [relay, writers] of selectedRelays) {
    const currentSize = result.get(relay)?.size ?? 0;
    const maxToAdd = Math.max(0, MAX_KEYS - currentSize);

    // Deterministic: filter to uncached follows, sort by hex
    const newPubkeys = [...writers]
      .filter((pk) => followsSet.has(pk) && !pubkeyCache.has(pk))
      .sort()
      .slice(0, maxToAdd);

    if (newPubkeys.length > 0) {
      result.set(relay, new Set(newPubkeys));
      for (const pk of newPubkeys) pubkeyCache.add(pk);
    }
  }

  // ── Phase 2: Event history — SKIPPED (no runtime data) ────────────

  // ── Phase 3: Distribute orphans across already-selected relays ────
  const restPubkeys = input.follows.filter(
    (pk) => !pubkeyCache.has(pk) && input.writerToRelays.has(pk),
  );

  if (restPubkeys.length > 0) {
    // Deterministic order: iterate selected relay keys sorted by URL
    const relayKeys = [...result.keys()].sort();
    for (const relay of relayKeys) {
      const present = result.get(relay)!;
      const maxKeys = MAX_KEYS - present.size;
      if (maxKeys <= 0) continue;

      // Deterministic: sort orphans by hex, take up to maxKeys
      const addable = restPubkeys
        .filter((pk) => !pubkeyCache.has(pk))
        .sort()
        .slice(0, maxKeys);

      for (const pk of addable) {
        present.add(pk);
        pubkeyCache.add(pk);
      }
    }
  }

  // ── Phase 4: Redundancy pass (ensure ≥2 relays per pubkey) ────────
  // Build a temporary pubkey→relayCount map from current result
  const pubkeyRelayCount = new Map<Pubkey, number>();
  for (const [, pubkeys] of result) {
    for (const pk of pubkeys) {
      pubkeyRelayCount.set(pk, (pubkeyRelayCount.get(pk) ?? 0) + 1);
    }
  }

  const singleCoveredPubkeys = new Set<Pubkey>(
    [...pubkeyRelayCount.entries()]
      .filter(([, count]) => count === 1)
      .map(([pk]) => pk),
  );

  if (singleCoveredPubkeys.size > 0) {
    // Deterministic: iterate selected relays sorted by URL
    const relayKeys = [...result.keys()].sort();
    for (const relay of relayKeys) {
      if (singleCoveredPubkeys.size === 0) break;
      const selectedPubkeys = result.get(relay)!;
      const maxKeys = MAX_KEYS - selectedPubkeys.size;
      if (maxKeys <= 0) continue;

      // Add single-covered pubkeys not already on this relay
      const addable = [...singleCoveredPubkeys]
        .filter((pk) => !selectedPubkeys.has(pk))
        .sort()
        .slice(0, maxKeys);

      for (const pk of addable) {
        selectedPubkeys.add(pk);
        singleCoveredPubkeys.delete(pk);
      }
    }
  }

  // ── Build output structures ────────────────────────────────────────
  const relayAssignments = new Map<RelayUrl, Set<Pubkey>>();
  const pubkeyAssignments = new Map<Pubkey, Set<RelayUrl>>();

  for (const [relay, pubkeys] of result) {
    if (pubkeys.size === 0) continue;
    relayAssignments.set(relay, pubkeys);
    for (const pk of pubkeys) {
      const existing = pubkeyAssignments.get(pk) ?? new Set<RelayUrl>();
      existing.add(relay);
      pubkeyAssignments.set(pk, existing);
    }
  }

  const orphanedPubkeys = new Set<Pubkey>();
  for (const pk of input.follows) {
    if (!pubkeyAssignments.has(pk)) orphanedPubkeys.add(pk);
  }

  return {
    name: "Voyage Multi-Phase",
    relayAssignments,
    pubkeyAssignments,
    orphanedPubkeys,
    params,
    executionTimeMs: performance.now() - start,
    notes: [
      `Phase 1: top ${maxConnections} relays by coverage (deterministic)`,
      "Phase 2: skipped (no event history in static benchmark)",
      "Phase 3: orphans distributed to selected relays",
      "Phase 4: redundancy pass (single-covered → ≥2 relays)",
    ],
  };
}
