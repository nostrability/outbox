import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
} from "../types.ts";

/**
 * Popular + Random Baseline: use relay.damus.io + nos.lol as fixed relays,
 * plus 2 randomly selected relays from each author's declared write relays.
 * Tests: "what if you just used popular relays + some per-author diversity?"
 */
const FIXED_RELAYS: RelayUrl[] = [
  "wss://relay.damus.io",
  "wss://nos.lol",
];

export function popularPlusRandom(
  input: BenchmarkInput,
  params: AlgorithmParams,
  rng: () => number,
): AlgorithmResult {
  const start = performance.now();

  const relayAssignments = new Map<RelayUrl, Set<Pubkey>>();
  const pubkeyAssignments = new Map<Pubkey, Set<RelayUrl>>();
  const orphanedPubkeys = new Set<Pubkey>();

  // Helper to ensure relay exists in assignments map
  function addAssignment(relay: RelayUrl, pubkey: Pubkey) {
    const writers = relayAssignments.get(relay) ?? new Set<Pubkey>();
    writers.add(pubkey);
    relayAssignments.set(relay, writers);

    const relays = pubkeyAssignments.get(pubkey) ?? new Set<RelayUrl>();
    relays.add(relay);
    pubkeyAssignments.set(pubkey, relays);
  }

  for (const pubkey of input.follows) {
    const declaredRelays = input.writerToRelays.get(pubkey);

    // Always assign to fixed relays
    for (const relay of FIXED_RELAYS) {
      addAssignment(relay, pubkey);
    }

    if (!declaredRelays || declaredRelays.size === 0) {
      // No declared relays — just the fixed ones
      continue;
    }

    // Pick 2 random relays from declared write relays (excluding fixed ones)
    const candidates = [...declaredRelays].filter(
      (r) => !FIXED_RELAYS.includes(r),
    );

    // Fisher-Yates partial shuffle for 2 picks
    const picks = Math.min(2, candidates.length);
    for (let i = 0; i < picks; i++) {
      const j = i + Math.floor(rng() * (candidates.length - i));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      addAssignment(candidates[i], pubkey);
    }
  }

  return {
    name: "Popular+Random",
    relayAssignments,
    pubkeyAssignments,
    orphanedPubkeys,
    params,
    executionTimeMs: performance.now() - start,
  };
}
