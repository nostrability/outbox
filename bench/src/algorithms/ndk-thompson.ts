import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
} from "../types.ts";
import { sampleBeta } from "./beta.ts";

/**
 * NDK Priority-Based + Thompson Sampling
 *
 * Two variants testing how Thompson integrates with NDK's architecture:
 *
 * Variant A ("ndk-thompson"):
 *   NDK's exact priority cascade preserved — selected-first hard priority,
 *   then Thompson score (replaces raw popularity). Tests the MINIMAL
 *   integration: just swap the scoring in the third-priority tier.
 *
 * Variant B ("ndk-thompson-unified"):
 *   Replaces the hard selected-first priority with a multiplicative bonus
 *   (1.5x for already-selected relays). Thompson scoring drives ALL
 *   relay decisions, not just the fallback tier. Tests whether removing
 *   the priority bypass improves learning.
 *
 * Both variants:
 *   - Use relayPriors from params (cold start = uniform = sampleBeta(1,1))
 *   - Pre-compute scores per author before sorting (comparator stability)
 *   - Enforce maxConnections natively (same as NDK)
 *   - Process authors in sorted hex order (deterministic iteration)
 *   - Support optional latency discount
 */

export function ndkThompson(
  input: BenchmarkInput,
  params: AlgorithmParams,
  rng: () => number,
): AlgorithmResult {
  return ndkThompsonCore(input, params, rng, /* unified */ false);
}

export function ndkThompsonUnified(
  input: BenchmarkInput,
  params: AlgorithmParams,
  rng: () => number,
): AlgorithmResult {
  return ndkThompsonCore(input, params, rng, /* unified */ true);
}

export function ndkThompsonCG(
  input: BenchmarkInput,
  params: AlgorithmParams,
  rng: () => number,
): AlgorithmResult {
  return ndkThompsonCore(input, params, rng, /* unified */ false, /* coverageGuarantee */ true);
}

export function ndkThompsonCG2(
  input: BenchmarkInput,
  params: AlgorithmParams,
  rng: () => number,
): AlgorithmResult {
  return ndkThompsonCore(input, params, rng, /* unified */ false, /* coverageGuarantee */ true, /* cgBudgetFraction */ 0.5);
}

export function ndkThompsonCG3(
  input: BenchmarkInput,
  params: AlgorithmParams,
  rng: () => number,
): AlgorithmResult {
  return ndkThompsonCore(input, params, rng, /* unified */ false, /* coverageGuarantee */ true, /* cgBudgetFraction */ 0.5, /* cgConditional */ true);
}

export function ndkThompsonSB(
  input: BenchmarkInput,
  params: AlgorithmParams,
  rng: () => number,
): AlgorithmResult {
  return ndkThompsonCore(input, params, rng, /* unified */ false, /* coverageGuarantee */ false, /* cgBudgetFraction */ undefined, /* cgConditional */ false, /* soleSourceBoost */ 5.0);
}

function ndkThompsonCore(
  input: BenchmarkInput,
  params: AlgorithmParams,
  rng: () => number,
  unified: boolean,
  coverageGuarantee = false,
  cgBudgetFraction?: number,
  cgConditional = false,
  soleSourceBoost?: number,
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

  // Score boost: detect sole-source relays and re-sort pubkeys
  const soleSourceRelaySet = new Set<RelayUrl>();
  const soleSourcePubkeys = new Set<Pubkey>();
  if (soleSourceBoost) {
    for (const pubkey of sortedFollows) {
      const authorRelays = input.writerToRelays.get(pubkey);
      if (authorRelays && authorRelays.size === 1) {
        const [onlyRelay] = authorRelays;
        soleSourceRelaySet.add(onlyRelay);
        soleSourcePubkeys.add(pubkey);
      }
    }
    // Re-sort: sole-source pubkeys first, then the rest (P1 mitigation)
    sortedFollows.sort((a, b) => {
      const aIsSS = soleSourcePubkeys.has(a) ? 0 : 1;
      const bIsSS = soleSourcePubkeys.has(b) ? 0 : 1;
      if (aIsSS !== bIsSS) return aIsSS - bIsSS;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    console.error(`Score boost: ${soleSourceRelaySet.size} sole-source relays at ${soleSourceBoost}x`);
  }

  // Coverage guarantee: force-select sole-source relays
  const forcedRelays = new Set<RelayUrl>();
  let cgSkipped = false;
  if (coverageGuarantee) {
    // Collect sole-source relays and the pubkeys they uniquely cover
    const soleSourceRelays = new Map<RelayUrl, Set<Pubkey>>();
    for (const pubkey of sortedFollows) {
      const authorRelays = input.writerToRelays.get(pubkey);
      if (!authorRelays || authorRelays.size !== 1) continue;
      const [onlyRelay] = authorRelays;
      const pubkeys = soleSourceRelays.get(onlyRelay) ?? new Set<Pubkey>();
      pubkeys.add(pubkey);
      soleSourceRelays.set(onlyRelay, pubkeys);
    }

    // Conditional CG: skip entirely if sole-source count >= budget cap
    if (cgConditional) {
      const cgCap = Math.floor(maxConnections * (cgBudgetFraction ?? 0.5));
      if (soleSourceRelays.size >= cgCap) {
        cgSkipped = true;
        console.error(
          `Coverage guarantee: SKIPPED ` +
          `(${soleSourceRelays.size} sole-source >= ${cgCap} cap)`,
        );
        // fall through to main loop with no forced relays
      }
    }

    if (!cgSkipped) {
      // Budget cap: limit forced relays to a fraction of maxConnections
      // (redundant when cgConditional=true: if size < cap, all fit; if size >= cap, skipped above)
      const cgCap = cgBudgetFraction != null
        ? Math.floor(maxConnections * cgBudgetFraction)
        : Infinity;
      const totalSoleSource = soleSourceRelays.size;

      // Sort by coverage value descending (most sole-source pubkeys first)
      const sortedSoleSource = [...soleSourceRelays.entries()]
        .sort((a, b) => b[1].size - a[1].size);

      for (const [relay, pubkeys] of sortedSoleSource) {
        if (forcedRelays.size >= cgCap) break;
        forcedRelays.add(relay);
        selectedRelays.add(relay);
        for (const pubkey of pubkeys) {
          const writers = relayAssignments.get(relay) ?? new Set<Pubkey>();
          writers.add(pubkey);
          relayAssignments.set(relay, writers);
          pubkeyAssignments.set(pubkey, new Set([relay]));
        }
      }
      const capLabel = cgBudgetFraction != null
        ? ` (capped at ${cgCap}, ${totalSoleSource} total sole-source)`
        : "";
      console.error(`Coverage guarantee: ${forcedRelays.size} sole-source relays forced${capLabel} (${maxConnections} maxConnections budget)`);
    }
  }

  for (const pubkey of sortedFollows) {
    if (coverageGuarantee && pubkeyAssignments.has(pubkey)) continue; // already assigned by coverage guarantee
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
      const sample = prior
        ? sampleBeta(prior.alpha, prior.beta, rng)
        : sampleBeta(1, 1, rng); // uniform = cold start

      if (prior) priorsUsed++;

      let score = (1 + Math.log(weight)) * sample;

      // Score boost for sole-source relays
      if (soleSourceBoost && soleSourceRelaySet.has(relay)) {
        score *= soleSourceBoost;
      }

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
      } else {
        // Variant B: selected relays get a bonus, not hard priority
        // (bonus already applied below via score multiplication)
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
  const cgLabel = coverageGuarantee
    ? (cgSkipped ? "-skip" : (cgConditional ? "+CG3" : (cgBudgetFraction != null ? "+CG2" : "+CG")))
    : "";
  const sbLabel = soleSourceBoost ? "+SB" : "";
  const name = `NDK+Thompson (${variant})${cgLabel}${sbLabel}${hasLatency ? "+Latency" : ""}`;

  const notes: string[] = [];
  if (relayPriors && relayPriors.size > 0) {
    notes.push(`Thompson: ${relayPriors.size} relay priors, ${priorsUsed} lookups`);
  } else {
    notes.push("Thompson: cold start (uniform priors)");
  }
  if (unified) {
    notes.push("Unified scoring: selected relays get 1.5x bonus (no hard priority)");
  } else {
    notes.push("Priority cascade preserved: selected-first, then Thompson score");
  }
  if (hasLatency) {
    notes.push(`Latency discount: ${relayLatencies!.size} relays, ${latencyUsed} lookups`);
  }
  if (coverageGuarantee) {
    if (cgSkipped) {
      notes.push("Coverage guarantee: SKIPPED (conditional — sole-source >= budget cap)");
    } else {
      notes.push(`Coverage guarantee: ${forcedRelays.size} sole-source relays forced`);
    }
  }
  if (soleSourceBoost) {
    notes.push(`Score boost: ${soleSourceRelaySet.size} sole-source relays at ${soleSourceBoost}x (${soleSourcePubkeys.size} pubkeys prioritized)`);
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
