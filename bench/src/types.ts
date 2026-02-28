export type Pubkey = string; // hex 64-char
export type RelayUrl = string; // normalized wss://

export interface PubkeyRelayList {
  pubkey: Pubkey;
  writeRelays: RelayUrl[];
  readRelays: RelayUrl[];
  eventCreatedAt: number;
}

export interface FilteredUrlReport {
  localhost: string[];
  ipAddress: string[];
  insecureWs: string[];
  knownBad: string[];
  malformed: string[];
  totalRemoved: number;
}

export type FilterProfile = "strict" | "neutral";

export interface FetchMeta {
  indexerRelays: string[];
  perRelayStats: Record<
    string,
    {
      eventsReceived: number;
      uniquePubkeysCovered: number;
      connectionTimeMs: number;
      errors: string[];
    }
  >;
  totalFollows: number;
  followsWithRelayList: number;
  followsMissingRelayList: number;
  followsFilteredToEmpty: number;
  missingRate: number;
  filteredUrls: FilteredUrlReport;
  filterProfile: FilterProfile;
}

export interface BenchmarkInput {
  targetPubkey: Pubkey;
  follows: Pubkey[];
  relayLists: Map<Pubkey, PubkeyRelayList>;
  followsMissingRelayList: Pubkey[];
  relayToWriters: Map<RelayUrl, Set<Pubkey>>;
  writerToRelays: Map<Pubkey, Set<RelayUrl>>;
  fetchedAt: number;
  fetchMeta: FetchMeta;
}

export interface BenchmarkInputSnapshot {
  targetPubkey: Pubkey;
  follows: Pubkey[];
  relayLists: PubkeyRelayList[];
  followsMissingRelayList: Pubkey[];
  fetchedAt: number;
  fetchMeta: FetchMeta;
}

export interface AlgorithmParams {
  maxConnections?: number;
  maxRelaysPerUser?: number;
  relayGoalPerAuthor?: number;
  relayLimit?: number;
  runs?: number;
  skipTopRelays?: number;
  writeLimit?: number;
  seed?: number;
  /** Per-relay Beta distribution priors for Thompson Sampling. */
  relayPriors?: Map<RelayUrl, { alpha: number; beta: number }>;
  /** Epsilon for exploration (greedy-epsilon). */
  epsilon?: number;
  /** Max fraction of covered pubkeys any single relay may serve (0-1). */
  maxSharePerRelay?: number;
}

export interface Distribution {
  min: number;
  max: number;
  mean: number;
  median: number;
  p90: number;
  p99: number;
}

export interface AlgorithmResult {
  name: string;
  relayAssignments: Map<RelayUrl, Set<Pubkey>>;
  pubkeyAssignments: Map<Pubkey, Set<RelayUrl>>;
  orphanedPubkeys: Set<Pubkey>;
  params: AlgorithmParams;
  executionTimeMs: number;
  notes?: string[];
}

export interface AlgorithmMetrics {
  name: string;
  totalRelaysSelected: number;
  assignmentCoverage: number;
  coveredPubkeys: number;
  orphanedPubkeys: number;
  structuralOrphans: number;
  algorithmOrphans: number;
  avgRelaysPerPubkey: number;
  medianRelaysPerPubkey: number;
  pubkeysPerRelay: number;
  pubkeyRelayCountDistribution: Record<number, number>;
  relayLoadDistribution: Distribution;
  targetAttainmentRate: number;
  top1RelayShare: number;
  top5RelayShare: number;
  hhi: number;
  gini: number;
  executionTimeMs: number;
  stochastic?: StochasticStats;
}

export interface StochasticStats {
  runs: number;
  seed: number;
  mean: Partial<AlgorithmMetrics>;
  stddev: Partial<AlgorithmMetrics>;
  ci95: { lower: Partial<AlgorithmMetrics>; upper: Partial<AlgorithmMetrics> };
}

export type RelaySelectionAlgorithm = (
  input: BenchmarkInput,
  params: AlgorithmParams,
  rng: () => number,
) => AlgorithmResult;

export type Nip66FilterMode = false | "strict" | "liveness";

export interface CliOptions {
  target: string;
  algorithms: string[];
  maxConnections?: number;
  relaysPerUser?: number;
  runs: number;
  seed: number | "random";
  sweep: boolean;
  fast: boolean;
  followsFile?: string;
  indexers: string[];
  filterProfile: FilterProfile;
  output: "table" | "json" | "both";
  fullAssignments: boolean;
  noCache: boolean;
  verbose: boolean;
  verify: boolean;
  verifyWindow: number;
  verifyWindows: number[];
  verifyConcurrency: number;
  nip66Filter: Nip66FilterMode;
  nip66TtlMs?: number;
  noPhase2Cache: boolean;
  enrichHints: boolean;
}

export interface SerializedAlgorithmResult {
  name: string;
  params: AlgorithmParams;
  executionTimeMs: number;
  relayAssignments: Record<RelayUrl, Pubkey[]>;
  pubkeyAssignments: Record<Pubkey, RelayUrl[]>;
  orphanedPubkeys: Pubkey[];
  notes?: string[];
}

export interface BenchmarkOutput {
  meta: {
    targetPubkey: Pubkey;
    fetchedAt: number;
    follows: number;
    followsMissingRelayList: number;
    fetchMeta: FetchMeta;
    seed: number;
    nip66Filter: boolean;
    nip66FilterMode: "strict" | "liveness" | null;
  };
  metrics: AlgorithmMetrics[];
  results: SerializedAlgorithmResult[];
}

export interface SweepRow {
  name: string;
  coverageByBudget: Partial<Record<number | "unlimited", number>>;
}

// --- Utility functions ---

export function buildBenchmarkInput(
  snapshot: BenchmarkInputSnapshot,
): BenchmarkInput {
  const relayLists = new Map<Pubkey, PubkeyRelayList>();
  for (const relayList of snapshot.relayLists) {
    relayLists.set(relayList.pubkey, relayList);
  }

  const relayToWriters = new Map<RelayUrl, Set<Pubkey>>();
  const writerToRelays = new Map<Pubkey, Set<RelayUrl>>();

  for (const pubkey of snapshot.follows) {
    const relayList = relayLists.get(pubkey);
    if (!relayList) continue;

    const relays = new Set<RelayUrl>(relayList.writeRelays);
    if (relays.size === 0) continue;

    writerToRelays.set(pubkey, relays);

    for (const relay of relays) {
      const writers = relayToWriters.get(relay) ?? new Set<Pubkey>();
      writers.add(pubkey);
      relayToWriters.set(relay, writers);
    }
  }

  return {
    targetPubkey: snapshot.targetPubkey,
    follows: snapshot.follows,
    relayLists,
    followsMissingRelayList: snapshot.followsMissingRelayList,
    relayToWriters,
    writerToRelays,
    fetchedAt: snapshot.fetchedAt,
    fetchMeta: snapshot.fetchMeta,
  };
}

export function benchmarkInputToSnapshot(
  input: BenchmarkInput,
): BenchmarkInputSnapshot {
  return {
    targetPubkey: input.targetPubkey,
    follows: [...input.follows],
    relayLists: [...input.relayLists.values()],
    followsMissingRelayList: [...input.followsMissingRelayList],
    fetchedAt: input.fetchedAt,
    fetchMeta: input.fetchMeta,
  };
}

export function mapSetToRecord<K extends string, V extends string>(
  map: Map<K, Set<V>>,
): Record<K, V[]> {
  const output = {} as Record<K, V[]>;
  for (const [key, values] of map.entries()) {
    output[key] = [...values].sort();
  }
  return output;
}

export function serializeAlgorithmResult(
  result: AlgorithmResult,
): SerializedAlgorithmResult {
  return {
    name: result.name,
    params: result.params,
    executionTimeMs: result.executionTimeMs,
    relayAssignments: mapSetToRecord(result.relayAssignments),
    pubkeyAssignments: mapSetToRecord(result.pubkeyAssignments),
    orphanedPubkeys: [...result.orphanedPubkeys].sort(),
    notes: result.notes,
  };
}

export function toSortedNumericArray(values: Iterable<number>): number[] {
  return [...values].sort((a, b) => a - b);
}

export function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const clamped = Math.min(Math.max(p, 0), 1);
  const index = Math.floor((sorted.length - 1) * clamped);
  return sorted[index];
}

export function meanOf(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function stddev(values: number[]): number {
  if (values.length <= 1) return 0;
  const m = meanOf(values);
  const variance =
    values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// --- Phase 2 types ---

export interface Phase2Options {
  kinds: number[];
  windowSeconds: number;
  maxConcurrentConns: number;
  maxOpenSockets: number;
  maxEventsPerPair: number;
  batchSize: number;
  eoseTimeoutMs: number;
  connectTimeoutMs: number;
}

export type BaselineClassification =
  | "testable-reliable"
  | "testable-partial"
  | "zero-baseline"
  | "unreliable";

export interface PubkeyBaseline {
  pubkey: Pubkey;
  eventIds: Set<string>;
  relaysQueried: number;
  relaysSucceeded: Set<RelayUrl>;
  relaysFailed: Set<RelayUrl>;
  relaysWithEvents: Set<RelayUrl>;
  reliability: "reliable" | "partial";
  classification: BaselineClassification;
}

/** Per-algorithm latency simulation stats.
 *  Simulates querying only this algorithm's relay set in parallel.
 *  Only available when Phase 2 runs fresh (not from cache). */
export interface AlgorithmLatencyStats {
  /** Estimated time-to-first-event: min(connectTimeMs + firstEventMs) across relays with events (ms). */
  ttfeMs: number | null;
  /** Estimated time-to-first-event using connect-only fallback when firstEventMs unavailable. */
  ttfeConnectOnlyMs: number | null;
  /** Median query time across connected relays (ms). */
  queryP50Ms: number | null;
  /** 80th percentile query time across connected relays (ms). */
  queryP80Ms: number | null;
  /** Max query time across all relays (ms), typically dominated by timeouts. */
  queryMaxMs: number | null;
  /** Number of relays in the algorithm's set that timed out. */
  timeoutCount: number;
  /** Number of relays in the algorithm's set with outcomes. */
  relaysWithOutcomes: number;
  /** Number of relays that connected successfully. */
  relaysConnected: number;
  /** Number of relays that delivered at least one event. */
  relaysWithEvents: number;
  /** Total events across all relays in the set. */
  totalEvents: number;
  /** Estimated timeout tax: how much dead relays slow down the query.
   *  Computed as ceil(timeoutCount / concurrency) × eoseTimeoutMs.
   *  Represents additional wall-clock delay from dead relay timeouts
   *  blocking concurrency slots that could serve live relays. */
  timeoutTaxMs: number;
  /** Number of relays that connected but returned zero events. */
  relaysConnectedNoEvents: number;
  /** Progressive completeness: fraction of algorithm's eventual recall
   *  achieved at each time window (seconds). Simulates parallel relay queries. */
  progressiveCompleteness?: Record<number, number>;
  /** EOSE-race simulation: fraction of algorithm's eventual recall achieved
   *  at firstEoseMs + graceMs. Keys are grace periods in ms. */
  eoseRace?: Record<number, { cutoffMs: number; completeness: number }>;
}

/** Profile-view latency simulation.
 *  Simulates querying each followed author's write relays directly
 *  (bypassing the algorithm's relay selection). This measures the
 *  long-tail lookup path: tapping on a user's profile to see their notes. */
export interface ProfileViewLatencyStats {
  /** Number of authors simulated. */
  authorCount: number;
  /** Mean TTFE across profile views (ms). */
  meanTtfeMs: number | null;
  /** Median TTFE across profile views (ms). */
  medianTtfeMs: number | null;
  /** p95 TTFE across profile views (ms). */
  p95TtfeMs: number | null;
  /** Mean number of write relays queried per profile view. */
  meanRelaysQueried: number;
  /** Mean number of write relays that returned events. */
  meanRelaysWithEvents: number;
  /** Fraction of profile views where at least one relay returned events. */
  hitRate: number;
  /** Mean timeout count per profile view. */
  meanTimeouts: number;
}

export interface AlgorithmVerification {
  algorithmName: string;
  eventRecallRate: number;
  authorRecallRate: number;
  eventRecallIncPartial: number;
  authorRecallIncPartial: number;
  selectedRelaySuccessRate: number | null;
  totalBaselineEventsReliable: number;
  totalBaselineEventsInclPartial: number;
  totalFoundEventsReliable: number;
  totalFoundEventsInclPartial: number;
  testableReliableAuthors: number;
  testablePartialAuthors: number;
  authorsWithEvents: number;
  outOfBaselineRelays: RelayUrl[];
  /** Per-author event recall rates (testable-reliable only), sorted ascending. */
  perAuthorRecallRates: number[];
  /** Latency simulation stats. Only present for fresh (non-cached) Phase 2 runs. */
  latency?: AlgorithmLatencyStats;
}

export interface Phase2Result {
  options: Phase2Options;
  since: number;
  totalAuthorsWithRelayData: number;
  testableReliableAuthors: number;
  testablePartialAuthors: number;
  authorsZeroBaseline: number;
  authorsUnreliableBaseline: number;
  baselineStats: {
    totalRelaysQueried: number;
    relaySuccessRate: number;
    totalUniqueEvents: number;
    meanEventsPerTestableAuthor: number;
    medianEventsPerTestableAuthor: number;
    collectionTimeMs: number;
    timingStats?: {
      connectMs: { median: number; p95: number; mean: number };
      queryMs: { median: number; p95: number; mean: number };
      timeoutCount: number;
      timeoutRelayCount: number;
      totalRelayCount: number;
    };
  };
  algorithms: AlgorithmVerification[];
  /** Profile-view latency simulation (algorithm-independent). Only for fresh runs. */
  profileViewLatency?: ProfileViewLatencyStats;
  /** Baselines map, available for score persistence. Not serialized to JSON. */
  _baselines?: Map<Pubkey, PubkeyBaseline>;
  /** Query cache, available for score persistence. Not serialized to JSON. */
  _cache?: unknown;
}

// --- NIP-66 types ---

export interface Nip66RelayData {
  relayUrl: RelayUrl;
  rttOpenMs: number | null;
  rttReadMs: number | null;
  rttWriteMs: number | null;
  supportedNips: number[];
  network: string | null;
  lastSeenAt: number;
  monitorPubkey: string;
}

export interface Nip66RelayScore {
  relayUrl: RelayUrl;
  score: number;
  factors: {
    uptime: number;
    rtt: number;
    freshness: number;
    nipSupport: number;
  };
}

export interface Nip66CacheEnvelope {
  schemaVersion: number;
  fetchedAt: number;
  ttlSeconds: number;
  source: "nostr" | "http-api" | "synthetic";
  relays: Nip66RelayDataSerialized[];
}

export interface Nip66RelayDataSerialized {
  relayUrl: string;
  rttOpenMs: number | null;
  rttReadMs: number | null;
  rttWriteMs: number | null;
  supportedNips: number[];
  network: string | null;
  lastSeenAt: number;
  monitorPubkey: string;
}

// --- Relay Score DB (Thompson Sampling persistence) ---

export interface RelayScoreEntry {
  alpha: number;
  beta: number;
  lastQueried: number;
  totalEvents: number;
  totalExpected: number;
  /** Per-session delivery rate history (most recent last). */
  sessionRates?: number[];
  /** Trend direction: "improving", "declining", or "stable". */
  trend?: "improving" | "declining" | "stable";
}

export interface RelayScoreDB {
  schemaVersion: 1;
  pubkey: string;
  windowSeconds: number;
  updatedAt: number;
  sessionCount: number;
  relays: Record<RelayUrl, RelayScoreEntry>;
}
