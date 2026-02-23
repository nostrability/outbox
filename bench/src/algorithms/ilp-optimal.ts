import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
} from "../types.ts";

/**
 * ILP Optimal: Branch-and-bound exact solver for Maximum Coverage.
 *
 * Finds the TRUE optimal relay set of size k that maximizes pubkey coverage.
 * Uses greedy upper bounds for pruning and greedy solution as initial incumbent.
 *
 * At our scale (~233 relays, ~148 pubkeys, k=20), this uses aggressive
 * pre-sorting and bound-based pruning to find the optimum quickly.
 * Falls back to greedy if time limit is hit.
 */
export function ilpOptimal(
  input: BenchmarkInput,
  params: AlgorithmParams,
  _rng: () => number,
): AlgorithmResult {
  const start = performance.now();
  const maxConnections = params.maxConnections ?? 20;

  // Build indexed arrays for fast bitwise operations
  const pubkeyList: Pubkey[] = [];
  const pubkeyIndex = new Map<Pubkey, number>();
  for (const pubkey of input.follows) {
    const relaySet = input.writerToRelays.get(pubkey);
    if (relaySet && relaySet.size > 0) {
      pubkeyIndex.set(pubkey, pubkeyList.length);
      pubkeyList.push(pubkey);
    }
  }

  const m = pubkeyList.length;
  const relays: RelayUrl[] = [];
  const relayCoverageBits: Uint8Array[] = []; // bitset per relay
  const relayCoverageCount: number[] = [];
  const bytesNeeded = Math.ceil(m / 8);

  for (const [relay, writers] of input.relayToWriters) {
    const bits = new Uint8Array(bytesNeeded);
    let count = 0;
    for (const w of writers) {
      const idx = pubkeyIndex.get(w);
      if (idx !== undefined) {
        bits[idx >> 3] |= 1 << (idx & 7);
        count++;
      }
    }
    if (count > 0) {
      relays.push(relay);
      relayCoverageBits.push(bits);
      relayCoverageCount.push(count);
    }
  }

  const n = relays.length;
  const k = Math.min(maxConnections, n);

  // Sort relays by coverage descending (better pruning)
  const sortOrder = Array.from({ length: n }, (_, i) => i);
  sortOrder.sort((a, b) => relayCoverageCount[b] - relayCoverageCount[a]);
  const sortedRelays = sortOrder.map((i) => relays[i]);
  const sortedBits = sortOrder.map((i) => relayCoverageBits[i]);
  const sortedCounts = sortOrder.map((i) => relayCoverageCount[i]);

  // Helper: count bits in a bitset
  function popcount(bits: Uint8Array): number {
    let count = 0;
    for (let i = 0; i < bits.length; i++) {
      let v = bits[i];
      v = v - ((v >> 1) & 0x55);
      v = (v & 0x33) + ((v >> 2) & 0x33);
      count += (v + (v >> 4)) & 0x0f;
    }
    return count;
  }

  // Helper: OR two bitsets
  function bitwiseOr(a: Uint8Array, b: Uint8Array): Uint8Array {
    const result = new Uint8Array(bytesNeeded);
    for (let i = 0; i < bytesNeeded; i++) result[i] = a[i] | b[i];
    return result;
  }

  // --- Greedy solution as initial incumbent ---
  let bestCoverage = 0;
  let bestSet: number[] = [];

  {
    const covered = new Uint8Array(bytesNeeded);
    const selected: number[] = [];
    const used = new Set<number>();

    for (let step = 0; step < k; step++) {
      let bestIdx = -1;
      let bestMarginal = 0;
      for (let i = 0; i < n; i++) {
        if (used.has(i)) continue;
        // Count bits in (sortedBits[i] AND NOT covered)
        let marginal = 0;
        for (let j = 0; j < bytesNeeded; j++) {
          let v = sortedBits[i][j] & ~covered[j];
          v = v - ((v >> 1) & 0x55);
          v = (v & 0x33) + ((v >> 2) & 0x33);
          marginal += (v + (v >> 4)) & 0x0f;
        }
        if (marginal > bestMarginal) {
          bestMarginal = marginal;
          bestIdx = i;
        }
      }
      if (bestIdx < 0 || bestMarginal === 0) break;
      selected.push(bestIdx);
      used.add(bestIdx);
      for (let j = 0; j < bytesNeeded; j++) covered[j] |= sortedBits[bestIdx][j];
    }

    bestCoverage = popcount(covered);
    bestSet = [...selected];
  }

  // If greedy achieves full coverage, it's optimal
  if (bestCoverage >= m) {
    return buildResult(bestSet, sortedRelays, sortedBits, pubkeyList, pubkeyIndex,
      input, params, start, bestCoverage, m, 0, false);
  }

  // --- Branch and bound with bitset operations ---
  const TIME_LIMIT_MS = 3000;
  let nodes = 0;
  let timedOut = false;

  function branchAndBound(
    selected: number[],
    coveredBits: Uint8Array,
    coveredCount: number,
    relayIdx: number,
    budgetLeft: number,
  ): void {
    nodes++;
    if (nodes % 5000 === 0 && performance.now() - start > TIME_LIMIT_MS) {
      timedOut = true;
      return;
    }
    if (timedOut) return;

    // Base case
    if (budgetLeft === 0 || relayIdx >= n) {
      if (coveredCount > bestCoverage) {
        bestCoverage = coveredCount;
        bestSet = [...selected];
      }
      return;
    }

    // Upper bound: current coverage + sum of top-budgetLeft marginal gains
    // (Quick overestimate: assumes no overlap among added relays)
    {
      const marginals: number[] = [];
      for (let i = relayIdx; i < n; i++) {
        let marginal = 0;
        for (let j = 0; j < bytesNeeded; j++) {
          let v = sortedBits[i][j] & ~coveredBits[j];
          v = v - ((v >> 1) & 0x55);
          v = (v & 0x33) + ((v >> 2) & 0x33);
          marginal += (v + (v >> 4)) & 0x0f;
        }
        if (marginal > 0) marginals.push(marginal);
      }
      marginals.sort((a, b) => b - a);
      let upperBound = coveredCount;
      for (let i = 0; i < Math.min(budgetLeft, marginals.length); i++) {
        upperBound += marginals[i];
      }
      if (upperBound <= bestCoverage) return;
    }

    // Branch: include relay[relayIdx]
    const newBits = bitwiseOr(coveredBits, sortedBits[relayIdx]);
    const newCount = popcount(newBits);
    selected.push(relayIdx);
    branchAndBound(selected, newBits, newCount, relayIdx + 1, budgetLeft - 1);
    selected.pop();

    if (timedOut) return;

    // Branch: exclude relay[relayIdx]
    branchAndBound(selected, coveredBits, coveredCount, relayIdx + 1, budgetLeft);
  }

  branchAndBound([], new Uint8Array(bytesNeeded), 0, 0, k);

  return buildResult(bestSet, sortedRelays, sortedBits, pubkeyList, pubkeyIndex,
    input, params, start, bestCoverage, m, nodes, timedOut);
}

function buildResult(
  bestSet: number[],
  sortedRelays: RelayUrl[],
  sortedBits: Uint8Array[],
  pubkeyList: Pubkey[],
  pubkeyIndex: Map<Pubkey, number>,
  input: BenchmarkInput,
  params: AlgorithmParams,
  startTime: number,
  bestCoverage: number,
  totalPubkeys: number,
  nodes: number,
  timedOut: boolean,
): AlgorithmResult {
  const relayAssignments = new Map<RelayUrl, Set<Pubkey>>();
  const pubkeyAssignments = new Map<Pubkey, Set<RelayUrl>>();
  const orphanedPubkeys = new Set<Pubkey>();
  const coveredSet = new Set<number>();

  for (const idx of bestSet) {
    const relay = sortedRelays[idx];
    const pubkeys = new Set<Pubkey>();
    const bits = sortedBits[idx];
    for (let i = 0; i < pubkeyList.length; i++) {
      if (bits[i >> 3] & (1 << (i & 7))) {
        coveredSet.add(i);
        const pubkey = pubkeyList[i];
        pubkeys.add(pubkey);
        const existing = pubkeyAssignments.get(pubkey) ?? new Set<RelayUrl>();
        existing.add(relay);
        pubkeyAssignments.set(pubkey, existing);
      }
    }
    relayAssignments.set(relay, pubkeys);
  }

  for (const pubkey of input.follows) {
    const idx = pubkeyIndex.get(pubkey);
    if (idx === undefined || !coveredSet.has(idx)) {
      orphanedPubkeys.add(pubkey);
    }
  }

  return {
    name: "ILP Optimal",
    relayAssignments,
    pubkeyAssignments,
    orphanedPubkeys,
    params,
    executionTimeMs: performance.now() - startTime,
    notes: [
      `B&B: ${nodes} nodes explored`,
      `Coverage: ${bestCoverage}/${totalPubkeys} (${(bestCoverage / totalPubkeys * 100).toFixed(1)}%)`,
      timedOut ? "TIME LIMIT - best found (may not be optimal)" : "Exact optimal found",
    ],
  };
}
