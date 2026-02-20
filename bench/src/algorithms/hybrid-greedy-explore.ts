import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
} from "../types.ts";

/**
 * Hybrid Greedy+Exploration relay selection.
 *
 * Combines greedy set-cover for coverage (short-term) with stochastic
 * inverse-popularity exploration for discovery (long-term event retention).
 *
 * Phase 1 (greedy): Use first ~70% of budget for max-coverage greedy selection.
 *   Picks relays covering the most uncovered pubkeys, same as Gossip/Applesauce.
 *
 * Phase 2 (explore): Use remaining ~30% of budget for stochastic exploration,
 *   weighted toward less-popular relays. These niche relays are more likely to
 *   retain old events that mega-relays prune. Uncovered pubkeys get a bonus
 *   weight so exploration also fills coverage gaps.
 *
 * Rationale: Our benchmarks show greedy achieves 93% event recall at 7d but
 * degrades to 16% at 365d because it concentrates on popular relays. MAB-UCB
 * achieves 41% at 365d via exploration. This hybrid aims for greedy-level
 * short-term coverage with MAB-level long-term retention.
 */
export function hybridGreedyExplore(
  input: BenchmarkInput,
  params: AlgorithmParams,
  rng: () => number,
): AlgorithmResult {
  const start = performance.now();
  const maxConnections = params.maxConnections ?? 20;
  const greedyRatio = 0.7;
  const greedySlots = Math.max(1, Math.round(maxConnections * greedyRatio));
  const exploreSlots = maxConnections - greedySlots;

  const relayAssignments = new Map<RelayUrl, Set<Pubkey>>();
  const pubkeyAssignments = new Map<Pubkey, Set<RelayUrl>>();
  const orphanedPubkeys = new Set<Pubkey>();
  const selectedRelays = new Set<RelayUrl>();

  const followSet = new Set<Pubkey>(input.follows);

  // Track uncovered pubkeys (only those with relay data)
  const uncovered = new Set<Pubkey>();
  for (const pubkey of input.follows) {
    const relays = input.writerToRelays.get(pubkey);
    if (relays && relays.size > 0) {
      uncovered.add(pubkey);
    } else {
      orphanedPubkeys.add(pubkey);
    }
  }

  // Build mutable coverage map
  const relayCoverage = new Map<RelayUrl, Set<Pubkey>>();
  for (const [relay, writers] of input.relayToWriters) {
    const relevant = new Set<Pubkey>();
    for (const w of writers) {
      if (uncovered.has(w)) relevant.add(w);
    }
    if (relevant.size > 0) relayCoverage.set(relay, relevant);
  }

  // --- PHASE 1: Greedy set-cover for first greedySlots relays ---
  let greedySelected = 0;
  while (uncovered.size > 0 && greedySelected < greedySlots) {
    let bestRelay: RelayUrl | null = null;
    let bestCount = 0;

    const relays = [...relayCoverage.keys()].sort();
    for (const relay of relays) {
      if (selectedRelays.has(relay)) continue;
      const covered = relayCoverage.get(relay)!;
      if (
        covered.size > bestCount ||
        (covered.size === bestCount &&
          (!bestRelay || relay < bestRelay))
      ) {
        bestCount = covered.size;
        bestRelay = relay;
      }
    }

    if (!bestRelay || bestCount === 0) break;

    selectedRelays.add(bestRelay);
    const coveredByRelay = relayCoverage.get(bestRelay)!;
    const assignedPubkeys = new Set<Pubkey>();

    for (const pubkey of coveredByRelay) {
      assignedPubkeys.add(pubkey);
      const existing =
        pubkeyAssignments.get(pubkey) ?? new Set<RelayUrl>();
      existing.add(bestRelay);
      pubkeyAssignments.set(pubkey, existing);
      uncovered.delete(pubkey);
    }

    relayAssignments.set(bestRelay, assignedPubkeys);
    greedySelected++;

    // Update coverage sets
    relayCoverage.delete(bestRelay);
    for (const [_relay, covered] of relayCoverage) {
      for (const pubkey of assignedPubkeys) {
        covered.delete(pubkey);
      }
      if (covered.size === 0) relayCoverage.delete(_relay);
    }
  }

  // --- PHASE 2: Stochastic exploration for remaining slots ---
  // Build candidate list from relays not yet selected
  const candidates: {
    relay: RelayUrl;
    weight: number;
    pubkeys: Set<Pubkey>;
  }[] = [];

  for (const [relay, writers] of input.relayToWriters) {
    if (selectedRelays.has(relay)) continue;
    const relevant = new Set<Pubkey>();
    for (const w of writers) {
      if (followSet.has(w)) relevant.add(w);
    }
    if (relevant.size === 0) continue;

    // Count how many of this relay's pubkeys are still uncovered
    let uncoveredCount = 0;
    for (const p of relevant) {
      if (!pubkeyAssignments.has(p)) uncoveredCount++;
    }

    // Weight: inverse-sqrt popularity (prefer niche relays) + bonus for uncovered pubkeys
    // The inverse-sqrt spreads exploration across less-popular relays
    // The uncovered bonus ensures exploration also fills coverage gaps
    const antiPopularity = 1.0 / Math.sqrt(relevant.size);
    const uncoveredBonus = uncoveredCount > 0 ? uncoveredCount * 0.5 : 0;
    const weight = antiPopularity + uncoveredBonus;

    candidates.push({ relay, weight, pubkeys: relevant });
  }

  // Weighted random selection for exploration slots
  for (let i = 0; i < exploreSlots && candidates.length > 0; i++) {
    const totalWeight = candidates.reduce((sum, r) => sum + r.weight, 0);
    if (totalWeight <= 0) break;

    let target = rng() * totalWeight;
    let selectedIdx = 0;

    for (let j = 0; j < candidates.length; j++) {
      target -= candidates[j].weight;
      if (target <= 0) {
        selectedIdx = j;
        break;
      }
    }

    const selected = candidates[selectedIdx];
    selectedRelays.add(selected.relay);

    const assignedPubkeys = new Set<Pubkey>();
    for (const pubkey of selected.pubkeys) {
      assignedPubkeys.add(pubkey);
      const existing =
        pubkeyAssignments.get(pubkey) ?? new Set<RelayUrl>();
      existing.add(selected.relay);
      pubkeyAssignments.set(pubkey, existing);
    }

    relayAssignments.set(selected.relay, assignedPubkeys);
    candidates.splice(selectedIdx, 1);
  }

  // Recompute orphans
  for (const pubkey of input.follows) {
    if (!pubkeyAssignments.has(pubkey)) {
      orphanedPubkeys.add(pubkey);
    }
  }

  return {
    name: "Hybrid Greedy+Explore",
    relayAssignments,
    pubkeyAssignments,
    orphanedPubkeys,
    params,
    executionTimeMs: performance.now() - start,
    notes: [
      `Greedy: ${greedySelected}/${greedySlots} slots, Explore: ${exploreSlots} slots (ratio: ${greedyRatio})`,
      `Exploration candidates: ${candidates.length + exploreSlots}`,
    ],
  };
}
