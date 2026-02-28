import type {
  AlgorithmResult,
  AlgorithmParams,
  BenchmarkInput,
  Pubkey,
  RelayUrl,
} from "../types.ts";

/**
 * Ditto-Mew baseline: broadcasts all feed queries to 4 hardcoded app relays
 * regardless of followed authors' NIP-65 declarations.
 *
 * This mirrors ditto-mew's actual feed behavior: no per-author routing,
 * no outbox model for feeds. Every author is assigned to every app relay.
 * Phase 2 verification measures what those relays actually return.
 *
 * Ref: https://gitlab.com/soapbox-pub/ditto-mew (NostrProvider.tsx reqRouter)
 */
const APP_RELAYS: RelayUrl[] = [
  "wss://relay.ditto.pub",
  "wss://relay.primal.net",
  "wss://relay.damus.io",
  "wss://nos.lol",
];

export function dittoMew(
  input: BenchmarkInput,
  params: AlgorithmParams,
  _rng: () => number,
): AlgorithmResult {
  const start = performance.now();

  const relayAssignments = new Map<RelayUrl, Set<Pubkey>>();
  const pubkeyAssignments = new Map<Pubkey, Set<RelayUrl>>();

  // Initialize relay assignments with all follows
  const allFollows = new Set(input.follows);
  for (const relay of APP_RELAYS) {
    relayAssignments.set(relay, new Set(allFollows));
  }

  // Every author assigned to every app relay (broadcast)
  const relaySet = new Set(APP_RELAYS);
  for (const pubkey of input.follows) {
    pubkeyAssignments.set(pubkey, new Set(relaySet));
  }

  return {
    name: "Ditto-Mew (4 app relays)",
    relayAssignments,
    pubkeyAssignments,
    orphanedPubkeys: new Set<Pubkey>(), // no orphans — everyone is assigned
    params,
    executionTimeMs: performance.now() - start,
    notes: [
      `Broadcast: ${input.follows.length} authors × ${APP_RELAYS.length} relays`,
      `No per-author routing — mirrors ditto-mew feed behavior`,
    ],
  };
}
