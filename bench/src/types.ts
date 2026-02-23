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
  verifyConcurrency: number;
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
  };
  algorithms: AlgorithmVerification[];
}
