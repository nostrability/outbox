import { connectToRelay, subscribeAndCollect, closeRelay } from "./fetch.ts";
import { filterRelayUrl } from "./normalize.ts";
import type { BenchmarkInput, Pubkey, RelayUrl } from "./types.ts";

const HINT_BATCH_SIZE = 5;
const MAX_HINTS_PER_AUTHOR = 5;

/** pubkey → relay → mention count */
export type HintMap = Map<Pubkey, Map<RelayUrl, number>>;

interface HintEnrichmentStats {
  relaysAdded: number;
  authorsEnriched: number;
  authorsEnrichedExisting: number;
  authorsEnrichedHintOnly: number;
}

export interface HintEnrichmentResult extends HintEnrichmentStats {
  hintMap: HintMap;
}

/**
 * Sanitize a relay URL from a p-tag hint.
 * Handles whitespace, trailing punctuation, and multi-protocol junk.
 */
function sanitizeHintUrl(raw: string): string | null {
  // Take first whitespace-delimited token
  const token = raw.trim().split(/\s/)[0];
  if (!token) return null;
  // Strip trailing commas/semicolons
  const cleaned = token.replace(/[,;]+$/, "");
  if (!cleaned) return null;
  // Reject if multiple :// (garbled URLs)
  const protoMatches = cleaned.match(/:\/\//g);
  if (protoMatches && protoMatches.length > 1) return null;
  return cleaned;
}

export async function enrichWithRelayHints(
  input: BenchmarkInput,
  indexerRelays: string[],
): Promise<HintEnrichmentResult> {
  const followsSet = new Set(input.follows);
  const authors = [...input.follows];

  // Connect to indexer relays
  const conns = [];
  for (const url of indexerRelays) {
    const conn = await connectToRelay(url);
    if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
      conns.push(conn);
    } else {
      closeRelay(conn);
    }
  }

  if (conns.length === 0) {
    console.log("[hints] Failed to connect to any indexer relay");
    return { relaysAdded: 0, authorsEnriched: 0, authorsEnrichedExisting: 0, authorsEnrichedHintOnly: 0, hintMap: new Map() };
  }

  console.log(`[hints] Connected to ${conns.length}/${indexerRelays.length} indexer relays`);

  // Fetch kind-1 events in batches and extract p-tag hints
  // hintedPubkey → relay → count
  const hintCounts = new Map<Pubkey, Map<RelayUrl, number>>();
  const seenEventIds = new Set<string>();

  for (let i = 0; i < authors.length; i += HINT_BATCH_SIZE) {
    const batch = authors.slice(i, i + HINT_BATCH_SIZE);
    const subId = `hints-${i}`;

    const batchEvents = await Promise.all(
      conns.map((conn) =>
        subscribeAndCollect(conn, subId, {
          kinds: [1],
          authors: batch,
          limit: 200,
        })
      ),
    );

    for (const events of batchEvents) {
      for (const event of events) {
        if (seenEventIds.has(event.id)) continue;
        seenEventIds.add(event.id);

        for (const tag of event.tags) {
          if (tag[0] !== "p" || !tag[1] || !tag[2]) continue;
          const hintedPubkey = tag[1];
          if (!followsSet.has(hintedPubkey)) continue;

          const sanitized = sanitizeHintUrl(tag[2]);
          if (!sanitized) continue;

          const filterResult = filterRelayUrl(sanitized, input.fetchMeta.filterProfile);
          if (!filterResult.accepted) continue;

          const relayUrl = filterResult.url;
          let relayCounts = hintCounts.get(hintedPubkey);
          if (!relayCounts) {
            relayCounts = new Map();
            hintCounts.set(hintedPubkey, relayCounts);
          }
          relayCounts.set(relayUrl, (relayCounts.get(relayUrl) ?? 0) + 1);
        }
      }
    }

    if (i + HINT_BATCH_SIZE < authors.length && (i / HINT_BATCH_SIZE) % 20 === 0) {
      console.log(`[hints] Scanned ${Math.min(i + HINT_BATCH_SIZE, authors.length)}/${authors.length} authors`);
    }
  }

  // Close connections
  for (const conn of conns) closeRelay(conn);

  // Apply top-N hints to maps
  let relaysAdded = 0;
  let authorsEnrichedExisting = 0;
  let authorsEnrichedHintOnly = 0;

  for (const [pubkey, relayCounts] of hintCounts) {
    const existingRelays = input.writerToRelays.get(pubkey);
    const existingSet = existingRelays ?? new Set<RelayUrl>();

    // Sort by count descending, take top N not already in set
    const candidates = [...relayCounts.entries()]
      .filter(([url]) => !existingSet.has(url))
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_HINTS_PER_AUTHOR);

    if (candidates.length === 0) continue;

    const hadExisting = existingRelays !== undefined && existingRelays.size > 0;

    if (!existingRelays) {
      input.writerToRelays.set(pubkey, new Set());
    }
    const pubRelays = input.writerToRelays.get(pubkey)!;

    for (const [relayUrl] of candidates) {
      pubRelays.add(relayUrl);
      const writers = input.relayToWriters.get(relayUrl) ?? new Set<Pubkey>();
      writers.add(pubkey);
      input.relayToWriters.set(relayUrl, writers);
      relaysAdded++;
    }

    if (hadExisting) {
      authorsEnrichedExisting++;
    } else {
      authorsEnrichedHintOnly++;
    }
  }

  const authorsEnriched = authorsEnrichedExisting + authorsEnrichedHintOnly;
  const authorsWithZeroHints = input.follows.length - hintCounts.size;

  console.log(`\n=== Relay Hint Enrichment ===`);
  console.log(`Events scanned: ${seenEventIds.size}`);
  console.log(`Follows with hints: ${hintCounts.size}/${input.follows.length}`);
  console.log(`  Enriched (had NIP-65): ${authorsEnrichedExisting}`);
  console.log(`  Enriched (hint-only, no NIP-65): ${authorsEnrichedHintOnly}`);
  console.log(`  Zero hints: ${authorsWithZeroHints}`);
  console.log(`Relays added: ${relaysAdded} (${authorsEnriched} authors, avg ${authorsEnriched > 0 ? (relaysAdded / authorsEnriched).toFixed(1) : 0}/author)`);

  return { relaysAdded, authorsEnriched, authorsEnrichedExisting, authorsEnrichedHintOnly, hintMap: hintCounts };
}
