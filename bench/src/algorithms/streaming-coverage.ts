import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
} from "../types.ts";

/**
 * Streaming Submodular Maximization.
 *
 * Processes relays in a single pass (random order), maintaining a buffer
 * of k relays. For each new relay, checks if swapping it with the weakest
 * buffer member improves total coverage.
 *
 * Models how NIP-65 data actually arrives in practice: relay lists come in
 * incrementally as you discover follows' metadata. Single-pass, O(k) buffer.
 *
 * Reference: Badanidiyuru et al., "Streaming Submodular Maximization," KDD 2014.
 * Achieves (0.5 - epsilon) approximation in a single pass.
 */
export function streamingCoverage(
  input: BenchmarkInput,
  params: AlgorithmParams,
  rng: () => number,
): AlgorithmResult {
  const start = performance.now();
  const maxConnections = params.maxConnections ?? 20;

  const followSet = new Set<Pubkey>(input.follows);

  // Build relay list with coverage (only pubkeys in follow set)
  interface RelayInfo {
    url: RelayUrl;
    pubkeys: Set<Pubkey>;
  }

  const relayInfos: RelayInfo[] = [];
  for (const [relay, writers] of input.relayToWriters) {
    const relevant = new Set<Pubkey>();
    for (const w of writers) {
      if (followSet.has(w)) relevant.add(w);
    }
    if (relevant.size > 0) {
      relayInfos.push({ url: relay, pubkeys: relevant });
    }
  }

  // Shuffle relay order (simulates arrival order)
  for (let i = relayInfos.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [relayInfos[i], relayInfos[j]] = [relayInfos[j], relayInfos[i]];
  }

  const k = Math.min(maxConnections, relayInfos.length);

  // Compute total coverage of a buffer
  function totalCoverage(buffer: RelayInfo[]): number {
    const covered = new Set<Pubkey>();
    for (const ri of buffer) {
      for (const p of ri.pubkeys) covered.add(p);
    }
    return covered.size;
  }

  // Initialize buffer with first k relays
  const buffer: RelayInfo[] = relayInfos.slice(0, k);
  let currentCoverage = totalCoverage(buffer);

  // Stream remaining relays
  for (let i = k; i < relayInfos.length; i++) {
    const candidate = relayInfos[i];

    // Find the buffer member whose removal causes least coverage loss
    let worstIdx = -1;
    let worstLoss = Infinity;

    for (let j = 0; j < buffer.length; j++) {
      // Coverage without buffer[j]
      const withoutJ = new Set<Pubkey>();
      for (let m = 0; m < buffer.length; m++) {
        if (m === j) continue;
        for (const p of buffer[m].pubkeys) withoutJ.add(p);
      }
      const loss = currentCoverage - withoutJ.size;
      if (loss < worstLoss) {
        worstLoss = loss;
        worstIdx = j;
      }
    }

    // Try swapping worst member with candidate
    const bufferWithSwap = [...buffer];
    bufferWithSwap[worstIdx] = candidate;
    const swapCoverage = totalCoverage(bufferWithSwap);

    if (swapCoverage > currentCoverage) {
      buffer[worstIdx] = candidate;
      currentCoverage = swapCoverage;
    }
  }

  // Build result
  const relayAssignments = new Map<RelayUrl, Set<Pubkey>>();
  const pubkeyAssignments = new Map<Pubkey, Set<RelayUrl>>();
  const orphanedPubkeys = new Set<Pubkey>();
  const coveredPubkeys = new Set<Pubkey>();

  for (const ri of buffer) {
    relayAssignments.set(ri.url, new Set(ri.pubkeys));
    for (const p of ri.pubkeys) {
      coveredPubkeys.add(p);
      const existing = pubkeyAssignments.get(p) ?? new Set<RelayUrl>();
      existing.add(ri.url);
      pubkeyAssignments.set(p, existing);
    }
  }

  for (const pubkey of input.follows) {
    if (!coveredPubkeys.has(pubkey)) {
      orphanedPubkeys.add(pubkey);
    }
  }

  return {
    name: "Streaming Coverage",
    relayAssignments,
    pubkeyAssignments,
    orphanedPubkeys,
    params,
    executionTimeMs: performance.now() - start,
    notes: [
      `Single-pass over ${relayInfos.length} relays, buffer size ${k}`,
      `Final coverage: ${currentCoverage}`,
    ],
  };
}
