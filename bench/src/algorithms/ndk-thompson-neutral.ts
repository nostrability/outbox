import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
} from "../types.ts";
import { sampleBeta } from "./beta.ts";

/**
 * NDK Priority-Based + Thompson Sampling — Neutral Cold Start
 *
 * Identical to ndk-thompson.ts except for cold start behavior:
 * - Cold relays return weight 1.0 (neutral) instead of sampleBeta(1,1) (random)
 *
 * This prevents unobserved relays from randomly outscoring proven relays,
 * which caused the fiatjaf regression (-18pp) in the original variant.
 */

export function ndkThompsonNeutral(
  input: BenchmarkInput,
  params: AlgorithmParams,
  rng: () => number,
): AlgorithmResult {
  return ndkThompsonNeutralCore(input, params, rng, /* unified */ false);
}

export function ndkThompsonNeutralUnified(
  input: BenchmarkInput,
  params: AlgorithmParams,
  rng: () => number,
): AlgorithmResult {
  return ndkThompsonNeutralCore(input, params, rng, /* unified */ true);
}

function ndkThompsonNeutralCore(
  input: BenchmarkInput,
  params: AlgorithmParams,
  rng: () => number,
  unified: boolean,
): AlgorithmResult {
  const start = performance.now();
  const relayGoalPerAuthor = params.relayGoalPerAuthor ?? params.maxRelaysPerUser ?? 2;
  const maxConnections = params.maxConnections ?? Infinity;
  const relayPriors = params.relayPriors;
  const relayLatencies = params.relayLatencies;

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

  let priorsUsed = 0;
  let latencyUsed = 0;

  // Process authors in deterministic order (sorted by hex pubkey)
  const sortedFollows = [...input.follows].sort();

  for (const pubkey of sortedFollows) {
    const authorRelays = input.writerToRelays.get(pubkey);
    if (!authorRelays || authorRelays.size === 0) {
      orphanedPubkeys.add(pubkey);
      continue;
    }

    // Pre-compute Thompson scores for this author's relays
    // (one Beta sample per relay, before sorting — comparator stability)
    const thompsonScores = new Map<RelayUrl, number>();
    for (const relay of authorRelays) {
      const weight = relayPopularity.get(relay) ?? 1;
      const prior = relayPriors?.get(relay);
      // NEUTRAL COLD START: cold relays get weight 1.0 instead of random sampleBeta(1,1)
      const sample = prior
        ? sampleBeta(prior.alpha, prior.beta, rng)
        : 1.0;

      if (prior) priorsUsed++;

      let score = (1 + Math.log(weight)) * sample;

      // Optional latency discount
      const latMs = relayLatencies?.get(relay);
      if (latMs !== undefined) {
        score *= 1 / (1 + latMs / 1000);
        latencyUsed++;
      }

      thompsonScores.set(relay, score);
    }

    // Sort candidate relays
    const candidates = [...authorRelays].sort((a, b) => {
      if (!unified) {
        // Variant A: preserve NDK's selected-first hard priority
        const aSelected = selectedRelays.has(a) ? 1 : 0;
        const bSelected = selectedRelays.has(b) ? 1 : 0;
        if (aSelected !== bSelected) return bSelected - aSelected;
      }

      // Thompson score (replaces raw popularity in both variants)
      let aScore = thompsonScores.get(a) ?? 0;
      let bScore = thompsonScores.get(b) ?? 0;

      if (unified) {
        // Apply connection-reuse bonus as a multiplier
        if (selectedRelays.has(a)) aScore *= 1.5;
        if (selectedRelays.has(b)) bScore *= 1.5;
      }

      if (aScore !== bScore) return bScore - aScore; // higher score first
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

  const variant = unified ? "Unified" : "Priority";
  const hasLatency = relayLatencies != null;
  const name = `NDK+Thompson Neutral (${variant})${hasLatency ? "+Latency" : ""}`;

  const notes: string[] = [];
  if (relayPriors && relayPriors.size > 0) {
    notes.push(`Thompson: ${relayPriors.size} relay priors, ${priorsUsed} lookups`);
  } else {
    notes.push("Thompson: cold start (neutral = 1.0, no randomness)");
  }
  if (unified) {
    notes.push("Unified scoring: selected relays get 1.5x bonus (no hard priority)");
  } else {
    notes.push("Priority cascade preserved: selected-first, then Thompson score");
  }
  if (hasLatency) {
    notes.push(`Latency discount: ${relayLatencies!.size} relays, ${latencyUsed} lookups`);
  }

  return {
    name,
    relayAssignments,
    pubkeyAssignments,
    orphanedPubkeys,
    params,
    executionTimeMs: performance.now() - start,
    notes,
  };
}
