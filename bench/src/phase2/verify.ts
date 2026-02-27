/**
 * Phase 2: Algorithm event verification against baseline.
 *
 * For each algorithm's selected relay set, count how many baseline events
 * are reachable through just those relays. Uses the query cache populated
 * during baseline collection — no additional network calls.
 */

import type { QueryCache } from "../relay-pool.ts";
import type {
  AlgorithmResult,
  AlgorithmVerification,
  PubkeyBaseline,
  Pubkey,
  RelayUrl,
} from "../types.ts";

export function verifyAlgorithm(
  result: AlgorithmResult,
  baselines: Map<Pubkey, PubkeyBaseline>,
  cache: QueryCache,
  allBaselineRelays: Set<RelayUrl>,
  declaredRelays: Set<RelayUrl>,
): AlgorithmVerification {
  // Build author sets
  const headlineSet: Pubkey[] = [];
  const partialSet: Pubkey[] = [];

  for (const [pubkey, baseline] of baselines) {
    if (baseline.classification === "testable-reliable") {
      headlineSet.push(pubkey);
    } else if (baseline.classification === "testable-partial") {
      partialSet.push(pubkey);
    }
  }

  const secondarySet = [...headlineSet, ...partialSet];

  // Track out-of-baseline relays
  const outOfBaselineRelays: RelayUrl[] = [];
  for (const relay of result.relayAssignments.keys()) {
    if (!allBaselineRelays.has(relay)) {
      outOfBaselineRelays.push(relay);
    }
  }
  if (outOfBaselineRelays.length > 0) {
    console.error(
      `[verify] ${result.name}: ${outOfBaselineRelays.length} out-of-baseline relays (skipped)`,
    );
  }

  // Compute recall for a given author set
  function computeRecall(authors: Pubkey[]): {
    totalBaseline: number;
    totalFound: number;
    authorsWithEvents: number;
    perAuthorRates: number[];
  } {
    let totalBaseline = 0;
    let totalFound = 0;
    let authorsWithEvents = 0;
    const perAuthorRates: number[] = [];

    for (const pubkey of authors) {
      const baseline = baselines.get(pubkey)!;
      totalBaseline += baseline.eventIds.size;

      // Get assigned relays for this pubkey from this algorithm
      const assignedRelays = result.pubkeyAssignments.get(pubkey);
      if (!assignedRelays || assignedRelays.size === 0) {
        // Not assigned by this algorithm — found = empty
        perAuthorRates.push(0);
        continue;
      }

      // Collect events from assigned relays (excluding out-of-baseline)
      const outSet = new Set(outOfBaselineRelays);
      const foundIds = new Set<string>();
      for (const relay of assignedRelays) {
        if (outSet.has(relay)) continue;
        const ids = cache.get(relay, pubkey);
        if (ids) {
          for (const id of ids) foundIds.add(id);
        }
      }

      // Intersect with baseline
      let intersectionCount = 0;
      for (const id of foundIds) {
        if (baseline.eventIds.has(id)) intersectionCount++;
      }

      totalFound += intersectionCount;
      if (intersectionCount > 0) authorsWithEvents++;
      perAuthorRates.push(
        baseline.eventIds.size > 0 ? intersectionCount / baseline.eventIds.size : 0,
      );
    }

    perAuthorRates.sort((a, b) => a - b);
    return { totalBaseline, totalFound, authorsWithEvents, perAuthorRates };
  }

  const headline = computeRecall(headlineSet);
  const secondary = computeRecall(secondarySet);

  // Selected relay success rate:
  // Only consider declared relays (not extra relays) since only declared relays
  // have success/failure tracked in baseline.relaysSucceeded
  const selectedRelays = new Set(result.relayAssignments.keys());
  const outSet = new Set(outOfBaselineRelays);
  let selectedInBaseline = 0;
  let selectedSucceeded = 0;
  for (const relay of selectedRelays) {
    if (outSet.has(relay)) continue;
    // Only count declared relays to avoid biasing the metric downward
    if (!declaredRelays.has(relay)) continue;
    selectedInBaseline++;
    // A relay "succeeded" if any author's baseline shows it in relaysSucceeded
    let succeeded = false;
    for (const [, baseline] of baselines) {
      if (baseline.relaysSucceeded.has(relay)) {
        succeeded = true;
        break;
      }
    }
    if (succeeded) selectedSucceeded++;
  }

  const selectedRelaySuccessRate = selectedInBaseline > 0
    ? selectedSucceeded / selectedInBaseline
    : null;

  return {
    algorithmName: result.name,
    eventRecallRate: headline.totalBaseline > 0
      ? headline.totalFound / headline.totalBaseline
      : 0,
    authorRecallRate: headlineSet.length > 0
      ? headline.authorsWithEvents / headlineSet.length
      : 0,
    eventRecallIncPartial: secondary.totalBaseline > 0
      ? secondary.totalFound / secondary.totalBaseline
      : 0,
    authorRecallIncPartial: secondarySet.length > 0
      ? secondary.authorsWithEvents / secondarySet.length
      : 0,
    selectedRelaySuccessRate,
    totalBaselineEventsReliable: headline.totalBaseline,
    totalBaselineEventsInclPartial: secondary.totalBaseline,
    totalFoundEventsReliable: headline.totalFound,
    totalFoundEventsInclPartial: secondary.totalFound,
    testableReliableAuthors: headlineSet.length,
    testablePartialAuthors: partialSet.length,
    authorsWithEvents: headline.authorsWithEvents,
    outOfBaselineRelays,
    perAuthorRecallRates: headline.perAuthorRates,
  };
}
