/**
 * Phase 2: NIP-11 + connect test + latency probing.
 *
 * After Phase 1 selects relays, probe them to check:
 * - NIP-11 info document availability
 * - WebSocket connection success
 * - Round-trip latency
 *
 * Stub: not yet implemented.
 */

import type { RelayUrl } from "../types.ts";

export interface ProbeResult {
  relay: RelayUrl;
  nip11Available: boolean;
  connectable: boolean;
  latencyMs: number | null;
  error?: string;
}

export async function probeRelay(_relay: RelayUrl): Promise<ProbeResult> {
  // TODO: Phase 2 implementation
  throw new Error("Phase 2 probe not yet implemented");
}
