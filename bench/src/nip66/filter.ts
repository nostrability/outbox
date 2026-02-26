/**
 * NIP-66 liveness filter: classifies candidate relays as alive or dead
 * using NIP-66 monitor data and/or the nostr.watch HTTP API.
 *
 * Modes:
 * - "strict":   NIP-66 data only (original behavior)
 * - "liveness": NIP-66 + nostr.watch HTTP API union (default when flag is bare)
 */

import type { Nip66FilterMode, Nip66RelayData, RelayUrl } from "../types.ts";

export type { Nip66FilterMode };

export function parseNip66FilterArg(value: string | undefined): Nip66FilterMode {
  if (value === undefined) return false;
  if (value === "" || value === "liveness") return "liveness";
  if (value === "strict") return "strict";
  if (value === "true") return "liveness";
  if (value === "false") return false;
  throw new Error(`Unknown --nip66-filter value: "${value}". Valid: liveness, strict`);
}

export interface ClassifyResult {
  knownAlive: Set<RelayUrl>;
  unknown: RelayUrl[];
  onionPreserved: number;
  parseFailedPreserved: number;
}

export function classifyCandidates(
  candidates: Iterable<RelayUrl>,
  monitorData: Map<RelayUrl, Nip66RelayData>,
): ClassifyResult {
  const knownAlive = new Set<RelayUrl>();
  const unknown: RelayUrl[] = [];
  let onionPreserved = 0;
  let parseFailedPreserved = 0;

  for (const url of candidates) {
    // Check if known alive via any monitor source
    if (monitorData.has(url)) {
      knownAlive.add(url);
      continue;
    }

    // Preserve .onion relays — can't validate without Tor
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      // Malformed URL — preserve to avoid silently dropping
      knownAlive.add(url);
      parseFailedPreserved++;
      continue;
    }

    if (hostname.endsWith(".onion")) {
      knownAlive.add(url);
      onionPreserved++;
      continue;
    }

    // Not seen by any monitor source
    unknown.push(url);
  }

  return { knownAlive, unknown, onionPreserved, parseFailedPreserved };
}
