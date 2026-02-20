/**
 * Reusable WebSocket connection pool with concurrency limit,
 * LRU eviction, and query cache for Phase 2 verification.
 */

import { connectToRelay } from "./fetch.ts";
import type { NostrEvent } from "./fetch.ts";
import type { Pubkey, RelayUrl } from "./types.ts";

export const MAX_EVENTS_PER_PAIR = 100;

export interface RelayOutcome {
  connected: boolean;
  reachedEose: boolean;
  connectTimeMs: number;
  error?: string;
}

// --- Semaphore for concurrency control ---

class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.active--;
    }
  }
}

// --- Query Cache ---

export class QueryCache {
  private cache = new Map<string, Set<string>>();
  private _totalEventIds = 0;

  private key(relay: RelayUrl, pubkey: Pubkey): string {
    return `${relay}\0${pubkey}`;
  }

  set(relay: RelayUrl, pubkey: Pubkey, eventIds: Set<string>): void {
    const k = this.key(relay, pubkey);
    const existing = this.cache.get(k);
    if (existing) {
      this._totalEventIds -= existing.size;
    }
    this.cache.set(k, eventIds);
    this._totalEventIds += eventIds.size;
  }

  get(relay: RelayUrl, pubkey: Pubkey): Set<string> | undefined {
    return this.cache.get(this.key(relay, pubkey));
  }

  getForPubkeyAcrossRelays(pubkey: Pubkey, relays: RelayUrl[]): Set<string> {
    const result = new Set<string>();
    for (const relay of relays) {
      const ids = this.get(relay, pubkey);
      if (ids) {
        for (const id of ids) result.add(id);
      }
    }
    return result;
  }

  get totalEntries(): number {
    return this.cache.size;
  }

  get totalEventIds(): number {
    return this._totalEventIds;
  }
}

// --- Relay Pool ---

interface PooledConnection {
  ws: WebSocket;
  relay: RelayUrl;
  lastUsed: number;
  idle: boolean;
  connectTimeMs: number;
}

export class RelayPool {
  private readonly semaphore: Semaphore;
  private readonly maxOpenSockets: number;
  private readonly connectTimeoutMs: number;
  private readonly eoseTimeoutMs: number;
  private readonly maxEventsPerPair: number;

  private connections = new Map<RelayUrl, PooledConnection>();
  private relayOutcomes = new Map<RelayUrl, RelayOutcome>();
  private subCounter = 0;

  constructor(opts: {
    maxConcurrent: number;
    maxOpenSockets: number;
    connectTimeoutMs: number;
    eoseTimeoutMs: number;
    maxEventsPerPair?: number;
  }) {
    this.semaphore = new Semaphore(opts.maxConcurrent);
    this.maxOpenSockets = opts.maxOpenSockets;
    this.connectTimeoutMs = opts.connectTimeoutMs;
    this.eoseTimeoutMs = opts.eoseTimeoutMs;
    this.maxEventsPerPair = opts.maxEventsPerPair ?? MAX_EVENTS_PER_PAIR;
  }

  /**
   * Query a relay for events from multiple pubkeys, batched.
   * Stores results in the query cache and returns per-pubkey event ID sets.
   */
  async queryBatched(
    relay: RelayUrl,
    pubkeys: Pubkey[],
    filter: { kinds: number[]; since: number },
    batchSize: number,
    cache: QueryCache,
  ): Promise<{ perPubkey: Map<Pubkey, Set<string>>; reachedEose: boolean }> {
    await this.semaphore.acquire();
    let reachedEose = false;
    // Collect full events per pubkey for proper capping
    const eventsPerPubkey = new Map<Pubkey, NostrEvent[]>();
    for (const pk of pubkeys) eventsPerPubkey.set(pk, []);

    try {
      const pooled = await this.getOrConnect(relay);
      if (!pooled) {
        const result = new Map<Pubkey, Set<string>>();
        for (const pk of pubkeys) result.set(pk, new Set());
        return { perPubkey: result, reachedEose: false };
      }

      for (let i = 0; i < pubkeys.length; i += batchSize) {
        const batch = pubkeys.slice(i, i + batchSize);
        const subId = `p2-${this.subCounter++}`;

        // Use the low-level subscribe pattern from fetch.ts
        const events = await this.subscribeWithTimeout(pooled, subId, {
          kinds: filter.kinds,
          authors: batch,
          since: filter.since,
        });

        if (events.eose) reachedEose = true;

        for (const event of events.events) {
          const pk = event.pubkey as Pubkey;
          const arr = eventsPerPubkey.get(pk);
          if (arr) arr.push(event);
        }
      }

      // Mark connection idle
      pooled.idle = true;
      pooled.lastUsed = Date.now();

      // Update outcome
      this.relayOutcomes.set(relay, {
        connected: true,
        reachedEose,
        connectTimeMs: pooled.connectTimeMs,
      });

    } catch (err) {
      if (!this.relayOutcomes.has(relay)) {
        this.relayOutcomes.set(relay, {
          connected: false,
          reachedEose: false,
          connectTimeMs: 0,
          error: String(err),
        });
      }
    } finally {
      this.semaphore.release();
    }

    // Cap and store in cache
    const perPubkey = new Map<Pubkey, Set<string>>();
    for (const pk of pubkeys) {
      const events = eventsPerPubkey.get(pk) ?? [];
      const ids = this.capEvents(events);
      perPubkey.set(pk, ids);
      cache.set(relay, pk, ids);
    }

    if (cache.totalEventIds > 500_000) {
      console.error(`[pool] Warning: query cache has ${cache.totalEventIds} event IDs (>500K)`);
    }

    return { perPubkey, reachedEose };
  }

  getRelayOutcome(relay: RelayUrl): RelayOutcome | undefined {
    return this.relayOutcomes.get(relay);
  }

  closeAll(): void {
    for (const [, pooled] of this.connections) {
      try {
        if (pooled.ws.readyState === WebSocket.OPEN) pooled.ws.close();
      } catch { /* ignore */ }
    }
    this.connections.clear();
  }

  /**
   * Cap events to maxEventsPerPair: keep highest created_at,
   * tie-break by lexicographically lowest event id.
   */
  private capEvents(events: NostrEvent[]): Set<string> {
    if (events.length <= this.maxEventsPerPair) {
      return new Set(events.map((e) => e.id));
    }
    // Sort: highest created_at first, then lowest id
    events.sort((a, b) => {
      if (a.created_at !== b.created_at) return b.created_at - a.created_at;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return new Set(events.slice(0, this.maxEventsPerPair).map((e) => e.id));
  }

  private async getOrConnect(relay: RelayUrl): Promise<PooledConnection | null> {
    const existing = this.connections.get(relay);
    if (existing && existing.ws.readyState === WebSocket.OPEN) {
      existing.idle = false;
      existing.lastUsed = Date.now();
      return existing;
    }
    // Remove stale entry
    if (existing) this.connections.delete(relay);

    // Evict idle connections if at capacity
    this.evictIfNeeded();

    const conn = await connectToRelay(relay);
    if (conn.errors.length > 0 && (!conn.ws || conn.ws.readyState !== WebSocket.OPEN)) {
      this.relayOutcomes.set(relay, {
        connected: false,
        reachedEose: false,
        connectTimeMs: conn.connectTimeMs,
        error: conn.errors.join("; "),
      });
      return null;
    }

    const pooled: PooledConnection = {
      ws: conn.ws,
      relay,
      lastUsed: Date.now(),
      idle: false,
      connectTimeMs: conn.connectTimeMs,
    };
    this.connections.set(relay, pooled);
    return pooled;
  }

  private evictIfNeeded(): void {
    while (this.connections.size >= this.maxOpenSockets) {
      // Prefer evicting idle connections (LRU)
      let victim: PooledConnection | null = null;
      for (const [, pooled] of this.connections) {
        if (pooled.idle && (!victim || pooled.lastUsed < victim.lastUsed)) {
          victim = pooled;
        }
      }
      // If no idle, force-evict LRU
      if (!victim) {
        for (const [, pooled] of this.connections) {
          if (!victim || pooled.lastUsed < victim.lastUsed) {
            victim = pooled;
          }
        }
      }
      if (!victim) break;
      try {
        if (victim.ws.readyState === WebSocket.OPEN) victim.ws.close();
      } catch { /* ignore */ }
      this.connections.delete(victim.relay);
    }
  }

  /**
   * Send a REQ and collect events until EOSE or timeout.
   * Returns whether EOSE was received (vs timeout).
   */
  private subscribeWithTimeout(
    pooled: PooledConnection,
    subId: string,
    filter: Record<string, unknown>,
  ): Promise<{ events: NostrEvent[]; eose: boolean }> {
    return new Promise((resolve) => {
      if (pooled.ws.readyState !== WebSocket.OPEN) {
        resolve({ events: [], eose: false });
        return;
      }

      const events: NostrEvent[] = [];
      const timeout = setTimeout(() => {
        pooled.ws.removeEventListener("message", handler);
        resolve({ events, eose: false });
      }, this.eoseTimeoutMs);

      const handler = (msg: MessageEvent) => {
        try {
          const data = JSON.parse(msg.data);
          if (!Array.isArray(data)) return;
          if (data[0] === "EVENT" && data[1] === subId && data[2]) {
            events.push(data[2] as NostrEvent);
          } else if (data[0] === "EOSE" && data[1] === subId) {
            clearTimeout(timeout);
            pooled.ws.removeEventListener("message", handler);
            resolve({ events, eose: true });
          }
        } catch { /* ignore parse errors */ }
      };

      pooled.ws.addEventListener("message", handler);
      pooled.ws.send(JSON.stringify(["REQ", subId, filter]));
    });
  }
}
