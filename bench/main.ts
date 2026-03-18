import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { npubToHex, fetchBenchmarkInput } from "./src/fetch.ts";
import { readCachedInput, writeCachedInput } from "./src/cache.ts";
import { mulberry32, resolveSeed } from "./src/seed.ts";
import {
  getAlgorithms,
  runAlgorithm,
  runStochastic,
} from "./src/algorithms/mod.ts";
import { computeMetrics } from "./src/metrics.ts";
import {
  printFetchQuality,
  printRegimeATable,
  printRegimeBTable,
  printSweepTable,
  buildJsonOutput,
  writeJsonOutput,
} from "./src/report.ts";
import { runPhase2 } from "./src/phase2/run.ts";
import { printPhase2Table, printNip66Correlation } from "./src/phase2/report.ts";
import { computeNip66Correlation } from "./src/phase2/nip66-correlation.ts";
import {
  computeNip77Correlation,
  printNip77CorrelationTable,
} from "./src/phase2/nip77-correlation.ts";
import { probeRelays } from "./src/phase2/probe.ts";
import type { ProbeResult } from "./src/phase2/probe.ts";
import {
  runNip77Reconciliation,
  printNip77ReconcileReport,
} from "./src/phase2/nip77-reconcile.ts";
import { fetchNip66MonitorData } from "./src/nip66/fetch.ts";
import { parseNip66FilterArg, classifyCandidates } from "./src/nip66/filter.ts";
import {
  loadRelayScores,
  updateRelayScores,
  updateRelayScoresCW,
  updateRelayScoresSE,
  updateRelayScoresPW,
  saveRelayScores,
  getRelayPriors,
  getRelayLatencies,
} from "./src/relay-scores.ts";
import { QueryCache } from "./src/relay-pool.ts";
import { enrichWithRelayHints } from "./src/hint-enrichment.ts";
import type { HintMap } from "./src/hint-enrichment.ts";
import { probeHintRelays } from "./src/phase2/hint-probe.ts";
import type {
  AlgorithmMetrics,
  AlgorithmParams,
  AlgorithmResult,
  BenchmarkInput,
  CliOptions,
  DecayConfig,
  DecayUnit,
  FilterProfile,
  Nip66RelayData,
  Phase2Result,
  RelayUrl,
  SweepRow,
} from "./src/types.ts";

const SWEEP_BUDGETS_FULL: (number | "unlimited")[] = [5, 10, 15, 20, 25, 28, 30, 50, 100, "unlimited"];
const SWEEP_BUDGETS_FAST: (number | "unlimited")[] = [10, 20, 28, 50, "unlimited"];
const REGIME_B_VALUES = [1, 2, 3, 4];

function printUsage(): void {
  console.log(`
Outbox Model Benchmark Tool

Usage:
  deno task bench <npub_or_hex> [options]

Options:
  --algorithms <list>       all,greedy,ndk,welshman,nostur,rust-nostr,direct (default: all)
  --max-connections <n>     Override maxConnections for all algorithms
  --relays-per-user <n>     Override relaysPerUser for all algorithms
  --runs <n>                Runs for stochastic algorithm (default: 10)
  --seed <n|random>         PRNG seed (default: 0)
  --sweep                   Run at multiple connection caps
  --fast                    Reduced sweep + stochastic runs for quick results
  --follows <file>          Load follow list from file instead of kind 3
  --indexers <list>         Comma-separated indexer relay URLs
  --filter-profile <name>   strict (default) or neutral
  --output <format>         table, json, both (default: both)
  --full-assignments        Include full relay/pubkey maps in JSON
  --verify                  Run Phase 2 event verification after Phase 1
  --verify-window <sec>     Phase 2 time window in seconds (default: 86400)
  --verify-windows <list>   Comma-separated windows (e.g., 604800,31536000)
  --verify-concurrency <n>  Phase 2 max concurrent connections (default: 20)
  --enrich-hints            Enrich relay sets with p-tag relay hints from kind-1 events
  --nip66-filter <mode>     NIP-66 liveness filter: liveness (default), strict
  --nip66-ttl <ms>          NIP-66 cache TTL override in ms
  --decay-factor <n>        Thompson decay factor (default: 0.95)
  --decay-unit <unit>       Decay unit: session (default) or hour
  --cache-ttl <ms>          Input data cache TTL in ms (default: 3600000 = 1hr)
  --nip77-probe             Test actual NIP-77 support via NEG-OPEN probe
  --nip77-reconcile         Full NIP-77 reconciliation benchmark (implies --nip77-probe + --no-phase2-cache)
  --nip77-concurrency <n>   Max concurrent reconciliation connections (default: 5)
  --no-cache                Skip cache
  --no-phase2-cache         Skip Phase 2 baseline disk cache
  --verbose                 Per-relay details, raw vs post-processed metrics
  --help                    Show this help
`);
}

function parseCliOptions(): CliOptions {
  const args = parseArgs(Deno.args, {
    string: [
      "algorithms",
      "max-connections",
      "relays-per-user",
      "runs",
      "seed",
      "follows",
      "indexers",
      "filter-profile",
      "output",
      "verify-window",
      "verify-windows",
      "verify-concurrency",
      "nip66-filter",
      "nip66-ttl",
      "decay-factor",
      "decay-unit",
      "cache-ttl",
      "nip77-concurrency",
    ],
    boolean: ["sweep", "fast", "full-assignments", "no-cache", "no-phase2-cache", "verbose", "verify", "enrich-hints", "nip77-probe", "nip77-reconcile", "help"],
    default: {
      algorithms: "all",
      runs: "10",
      seed: "0",
      "filter-profile": "strict",
      output: "both",
      "verify-window": "86400",
      "verify-concurrency": "20",
    },
  });

  if (args.help) {
    printUsage();
    Deno.exit(0);
  }

  const target = args._[0]?.toString();
  if (!target) {
    console.error("Error: target npub or hex pubkey required");
    printUsage();
    Deno.exit(1);
  }

  const seedInput = args.seed === "random" ? "random" as const : parseInt(args.seed!, 10);

  // Parse verify-windows: comma-separated list of window seconds
  const verifyWindows: number[] = args["verify-windows"]
    ? args["verify-windows"].split(",").map((s: string) => parseInt(s.trim(), 10))
    : [];

  const decayFactor = parseDecayFactor(args["decay-factor"]);
  const decayUnit = parseDecayUnit(args["decay-unit"]);
  const cacheTtlMs = parseCacheTtlMs(args["cache-ttl"]);

  return {
    target,
    algorithms: args.algorithms!.split(",").map((s: string) => s.trim()),
    maxConnections: args["max-connections"]
      ? parseInt(args["max-connections"], 10)
      : undefined,
    relaysPerUser: args["relays-per-user"]
      ? parseInt(args["relays-per-user"], 10)
      : undefined,
    runs: parseInt(args.runs!, 10),
    seed: seedInput,
    sweep: !!args.sweep,
    fast: !!args.fast,
    followsFile: args.follows,
    indexers: args.indexers
      ? args.indexers.split(",").map((s: string) => s.trim())
      : [],
    filterProfile: args["filter-profile"] as FilterProfile,
    output: args.output as "table" | "json" | "both",
    fullAssignments: !!args["full-assignments"],
    noCache: !!args["no-cache"],
    noPhase2Cache: !!args["no-phase2-cache"],
    enrichHints: !!args["enrich-hints"],
    verbose: !!args.verbose,
    verify: !!args.verify,
    verifyWindow: parseInt(args["verify-window"]!, 10),
    verifyWindows,
    verifyConcurrency: parseInt(args["verify-concurrency"]!, 10),
    nip66Filter: parseNip66FilterArg(args["nip66-filter"]),
    nip66TtlMs: args["nip66-ttl"] ? parseInt(args["nip66-ttl"], 10) : undefined,
    decayFactor,
    decayUnit,
    cacheTtlMs,
    nip77Probe: !!args["nip77-probe"] || !!args["nip77-reconcile"],
    nip77Reconcile: !!args["nip77-reconcile"],
    nip77Concurrency: args["nip77-concurrency"] ? parseInt(args["nip77-concurrency"], 10) : 5,
  };
}

function parseDecayFactor(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const v = parseFloat(raw);
  if (!Number.isFinite(v) || v < 0 || v > 1) {
    console.error(`Invalid --decay-factor: ${raw} (must be a number in [0, 1])`);
    Deno.exit(1);
  }
  return v;
}

function parseDecayUnit(raw: string | undefined): DecayUnit | undefined {
  if (!raw) return undefined;
  if (raw !== "session" && raw !== "hour") {
    console.error(`Invalid --decay-unit: ${raw} (must be "session" or "hour")`);
    Deno.exit(1);
  }
  return raw;
}

function parseCacheTtlMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const v = parseInt(raw, 10);
  if (!Number.isFinite(v) || v <= 0) {
    console.error(`Invalid --cache-ttl: ${raw} (must be a positive integer in ms)`);
    Deno.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const opts = parseCliOptions();

  // --nip77-reconcile requires --verify and implies --no-phase2-cache
  if (opts.nip77Reconcile) {
    if (!opts.verify) {
      console.error("Error: --nip77-reconcile requires --verify");
      Deno.exit(1);
    }
    opts.noPhase2Cache = true;
  }

  // Resolve target pubkey
  const targetPubkey = npubToHex(opts.target);
  if (!targetPubkey) {
    console.error(`Error: invalid npub or hex pubkey: ${opts.target}`);
    Deno.exit(1);
  }

  // Resolve seed
  const seed = resolveSeed(opts.seed);
  const runs = opts.fast ? Math.min(opts.runs, 3) : opts.runs;

  console.log(`Target: ${targetPubkey.slice(0, 16)}...`);
  console.log(`Seed: ${seed} | Filter: ${opts.filterProfile} | Runs: ${runs}`);

  // Fetch or cache input data
  let input: BenchmarkInput | null = null;

  if (!opts.noCache) {
    input = await readCachedInput(
      targetPubkey,
      opts.filterProfile,
      opts.indexers.length ? opts.indexers : ["wss://purplepag.es", "wss://relay.damus.io", "wss://nos.lol"],
      opts.cacheTtlMs,
    );
    if (input && input.follows.length === 0) {
      console.log("Cached data has 0 follows — treating as stale, re-fetching...");
      input = null;
    } else if (input) {
      console.log(`Using cached data (fetched ${new Date(input.fetchedAt).toISOString()})`);
    }
  }

  if (!input) {
    input = await fetchBenchmarkInput({
      targetPubkey,
      followsFile: opts.followsFile,
      indexerRelays: opts.indexers.length ? opts.indexers : undefined,
      filterProfile: opts.filterProfile,
    });

    // Retry once on 0 follows — indexers intermittently fail for large contact lists
    if (input.follows.length === 0 && !opts.followsFile) {
      console.log("0 follows found. Retrying in 5s...");
      await new Promise((r) => setTimeout(r, 5000));
      input = await fetchBenchmarkInput({
        targetPubkey,
        indexerRelays: opts.indexers.length ? opts.indexers : undefined,
        filterProfile: opts.filterProfile,
      });
    }

    // Only cache successful fetches (never cache 0-follows results)
    if (!opts.noCache && input.follows.length > 0) {
      await writeCachedInput(
        input,
        opts.filterProfile,
        opts.indexers.length ? opts.indexers : ["wss://purplepag.es", "wss://relay.damus.io", "wss://nos.lol"],
      );
    }
  }

  if (input.follows.length === 0) {
    console.log("0 follows found. Nothing to analyze.");
    Deno.exit(1);
  }

  // Print fetch quality
  const showTable = opts.output === "table" || opts.output === "both";
  const showJson = opts.output === "json" || opts.output === "both";

  if (showTable) {
    printFetchQuality(input.fetchMeta);
    console.log(`Unique valid write relays: ${input.relayToWriters.size} | Seed: ${seed}`);
  }

  // NIP-66 liveness filter: remove dead relays before algorithm runs
  let nip66Data: Map<string, Nip66RelayData> | undefined;
  if (opts.nip66Filter) {
    nip66Data = await fetchNip66MonitorData(opts.nip66TtlMs);

    if (nip66Data.size > 0) {
      const { knownAlive, unknown, onionPreserved, parseFailedPreserved } =
        classifyCandidates(input.relayToWriters.keys(), nip66Data);

      const removedRelays = new Set(unknown);
      const beforeRelays = input.relayToWriters.size;

      // Remove dead relays from input maps
      let authorsFilteredToEmpty = 0;
      for (const relay of removedRelays) {
        const writers = input.relayToWriters.get(relay);
        if (writers) {
          for (const pubkey of writers) {
            const pubRelays = input.writerToRelays.get(pubkey);
            if (pubRelays) {
              pubRelays.delete(relay);
              if (pubRelays.size === 0) {
                input.writerToRelays.delete(pubkey);
                authorsFilteredToEmpty++;
              }
            }
          }
          input.relayToWriters.delete(relay);
        }
      }

      console.log(`\n=== NIP-66 Liveness Filter (${opts.nip66Filter}) ===`);
      console.log(`Monitor data: ${nip66Data.size} relays`);
      console.log(`Candidate relays: ${beforeRelays}`);
      console.log(`  Known alive: ${knownAlive.size}`);
      console.log(`  Unknown (removed): ${removedRelays.size}`);
      console.log(`  .onion preserved: ${onionPreserved}`);
      console.log(`  Parse-failed preserved: ${parseFailedPreserved}`);
      console.log(`  Authors filtered to empty: ${authorsFilteredToEmpty}`);
      console.log(`Relays after filter: ${input.relayToWriters.size}`);
    } else {
      console.log("\n[nip66] No monitor data available — skipping filter");
    }
  }

  // Relay hint enrichment: add relays from p-tag hints
  let hintMap: HintMap | undefined;
  if (opts.enrichHints) {
    const indexerRelays = opts.indexers.length
      ? opts.indexers
      : ["wss://purplepag.es", "wss://relay.damus.io", "wss://nos.lol"];
    const beforeRelays = input.relayToWriters.size;
    const beforeAuthors = input.writerToRelays.size;
    const enrichResult = await enrichWithRelayHints(input, indexerRelays);
    hintMap = enrichResult.hintMap;
    console.log(`Relays: ${beforeRelays} → ${input.relayToWriters.size} | Authors with relays: ${beforeAuthors} → ${input.writerToRelays.size}`);
  }

  // Get algorithms
  const algorithms = getAlgorithms(opts.algorithms);

  if (opts.sweep) {
    if (opts.maxConnections !== undefined) {
      console.log("Warning: --sweep overrides --max-connections");
    }
    await runSweep(input, algorithms, opts, seed, runs, showTable, showJson, hintMap, nip66Data);
  } else {
    await runDefault(input, algorithms, opts, seed, runs, showTable, showJson, hintMap, nip66Data);
  }
}

async function runDefault(
  input: BenchmarkInput,
  algorithms: ReturnType<typeof getAlgorithms>,
  opts: CliOptions,
  seed: number,
  runs: number,
  showTable: boolean,
  showJson: boolean,
  hintMap?: HintMap,
  nip66Data?: ReadonlyMap<string, Nip66RelayData>,
): Promise<void> {
  const maxConnections = opts.maxConnections ?? 20;

  // Load per-algorithm Thompson Sampling priors (if available from previous sessions)
  const THOMPSON_IDS = new Set(["welshman-thompson", "fd-thompson", "welshman-thompson-latency", "fd-thompson-latency", "ndk-thompson", "ndk-thompson-unified", "greedy-thompson", "ndk-thompson-neutral", "ndk-thompson-neutral-unified", "ndk-thompson-cw", "ndk-thompson-cg", "ndk-thompson-cg2", "ndk-thompson-cg3", "ndk-thompson-sb"]);
  const ALT_SCORING_IDS: Record<string, typeof updateRelayScores> = {
    "ndk-thompson-cw": updateRelayScoresCW,
    "ndk-thompson-cg": updateRelayScoresSE,
    "ndk-thompson-cg2": updateRelayScoresSE,
    "ndk-thompson-cg3": updateRelayScoresPW,
  };
  const hasThompson = algorithms.some((a) => THOMPSON_IDS.has(a.id));
  const thompsonDBs = new Map<string, ReturnType<typeof loadRelayScores>>();
  const thompsonPriors = new Map<string, Map<string, { alpha: number; beta: number }>>();
  const thompsonLatencies = new Map<string, Map<string, number>>();

  if (hasThompson && opts.verify) {
    for (const entry of algorithms) {
      if (!THOMPSON_IDS.has(entry.id)) continue;
      const db = loadRelayScores(input.targetPubkey, opts.verifyWindow, opts.nip66Filter || undefined, entry.id);
      thompsonDBs.set(entry.id, db);
      const priors = getRelayPriors(db);
      if (priors.size > 0) {
        thompsonPriors.set(entry.id, priors);
        console.log(`\nThompson Sampling [${entry.id}]: loaded ${priors.size} relay priors (session ${db.sessionCount})`);
      }
      // Load latencies for latency-aware variants
      if (entry.id.endsWith("-latency")) {
        const latencies = getRelayLatencies(db);
        if (latencies.size > 0) {
          thompsonLatencies.set(entry.id, latencies);
          console.log(`  Latency data: ${latencies.size} relays with EWMA latencies`);
        }
      }
    }
  }

  // Regime A: Fixed connections
  const regimeAMetrics: AlgorithmMetrics[] = [];
  const regimeAResults: AlgorithmResult[] = [];

  for (const entry of algorithms) {
    const params: AlgorithmParams = {
      ...entry.defaults,
      maxConnections,
    };
    if (opts.relaysPerUser !== undefined) {
      params.maxRelaysPerUser = opts.relaysPerUser;
      params.relayGoalPerAuthor = opts.relaysPerUser;
      params.relayLimit = opts.relaysPerUser;
      params.writeLimit = opts.relaysPerUser;
    }

    // Inject per-algorithm Thompson Sampling priors
    if (THOMPSON_IDS.has(entry.id) && thompsonPriors.has(entry.id)) {
      params.relayPriors = thompsonPriors.get(entry.id);
    }
    // Inject latency data for latency-aware variants
    if (thompsonLatencies.has(entry.id)) {
      params.relayLatencies = thompsonLatencies.get(entry.id);
    }

    if (entry.stochastic) {
      const { result, metrics } = runStochastic(
        entry,
        input,
        params,
        seed,
        runs,
      );
      regimeAMetrics.push(metrics);
      regimeAResults.push(result);
    } else {
      const rng = mulberry32(seed);
      const result = runAlgorithm(entry, input, params, rng);
      const metrics = computeMetrics(result, input, params);
      regimeAMetrics.push(metrics);
      regimeAResults.push(result);
    }
  }

  if (showTable) {
    printRegimeATable(regimeAMetrics, maxConnections);
  }

  // Regime B: Fixed relays per author
  if (!opts.fast) {
    const target = opts.relaysPerUser ?? 2;
    const regimeBMetrics: AlgorithmMetrics[] = [];

    for (const entry of algorithms) {
      const params: AlgorithmParams = {
        ...entry.defaults,
        maxRelaysPerUser: target,
        relayGoalPerAuthor: target,
        relayLimit: target,
        writeLimit: target,
      };

      if (entry.stochastic) {
        const { metrics } = runStochastic(entry, input, params, seed, runs);
        regimeBMetrics.push(metrics);
      } else {
        const rng = mulberry32(seed);
        const result = runAlgorithm(entry, input, params, rng);
        const metrics = computeMetrics(result, input, params);
        regimeBMetrics.push(metrics);
      }
    }

    if (showTable) {
      printRegimeBTable(regimeBMetrics, target);
    }
  }

  // NIP-77 probe: test actual NIP-77 support via NEG-OPEN
  let nip77ProbeResults: ProbeResult[] | undefined;
  if (opts.nip77Probe && opts.verify) {
    const allRelays = [...input.relayToWriters.keys()];
    console.error(`\n=== NIP-77 Probe: testing ${allRelays.length} relays ===`);
    nip77ProbeResults = await probeRelays(allRelays, {
      concurrency: 15,
      probeNip77: true,
    });
    const supported = nip77ProbeResults.filter((r) => r.nip77Supported).length;
    const errored = nip77ProbeResults.filter((r) => r.nip77Probed && !r.nip77Supported).length;
    console.error(`  NIP-77 supported: ${supported} | Unsupported/errored: ${errored}`);
  }

  // Phase 2: Event verification
  let phase2Result: Phase2Result | undefined;
  if (opts.verify) {
    // For stochastic algorithms, Phase 2 uses a single deterministic run (seed=0).
    // Replace stochastic results with single-run result for verification.
    const verifyResults = regimeAResults.map((result, i) => {
      const entry = algorithms[i];
      if (entry.stochastic) {
        const params: AlgorithmParams = {
          ...entry.defaults,
          maxConnections,
        };
        if (opts.relaysPerUser !== undefined) {
          params.maxRelaysPerUser = opts.relaysPerUser;
          params.relayGoalPerAuthor = opts.relaysPerUser;
          params.relayLimit = opts.relaysPerUser;
          params.writeLimit = opts.relaysPerUser;
        }
        // Inject per-algorithm Thompson Sampling priors for the verify run too
        if (THOMPSON_IDS.has(entry.id) && thompsonPriors.has(entry.id)) {
          params.relayPriors = thompsonPriors.get(entry.id);
        }
        // Inject latency data for latency-aware variants
        if (thompsonLatencies.has(entry.id)) {
          params.relayLatencies = thompsonLatencies.get(entry.id);
        }
        const rng = mulberry32(0);
        const singleResult = runAlgorithm(entry, input, params, rng);
        return {
          ...singleResult,
          name: `${entry.name} (seed=0, single run)`,
        };
      }
      return result;
    });

    phase2Result = await runPhase2(
      input,
      verifyResults,
      {
        windowSeconds: opts.verifyWindow,
        maxConcurrentConns: opts.verifyConcurrency,
      },
      opts.noPhase2Cache,
    );

    if (showTable) {
      printPhase2Table(phase2Result);
    }

    // NIP-66 RTT vs measured latency correlation
    if (nip66Data && phase2Result._relayOutcomes) {
      phase2Result.nip66Correlation = computeNip66Correlation(
        nip66Data, phase2Result._relayOutcomes,
      );
      if (showTable && phase2Result.nip66Correlation.n > 0) {
        printNip66Correlation(phase2Result.nip66Correlation);
      }
    }

    // NIP-77 capability correlation
    if (nip66Data && phase2Result._relayOutcomes) {
      phase2Result.nip77Correlation = computeNip77Correlation(
        nip66Data, phase2Result._relayOutcomes,
      );

      // Enrich with probe accuracy if available
      if (nip77ProbeResults && phase2Result.nip77Correlation) {
        const nip66Claimed = new Set<RelayUrl>();
        for (const [url, data] of nip66Data) {
          if (data.supportedNips?.includes(77)) nip66Claimed.add(url);
        }

        let probed = 0;
        let actuallySupported = 0;
        let claimedButRejected = 0;
        let unclaimedButSupported = 0;

        for (const pr of nip77ProbeResults) {
          if (!pr.nip77Probed) continue;
          probed++;
          const claimed = nip66Claimed.has(pr.relay);
          if (pr.nip77Supported) {
            actuallySupported++;
            if (!claimed) unclaimedButSupported++;
          } else if (claimed) {
            claimedButRejected++;
          }
        }

        phase2Result.nip77Correlation.probeStats = {
          probed,
          actuallySupported,
          claimedButRejected,
          unclaimedButSupported,
        };
      }

      if (showTable && phase2Result.nip77Correlation.nip77Relays > 0) {
        printNip77CorrelationTable(phase2Result.nip77Correlation);
      }
    }

    // NIP-77 full reconciliation
    if (opts.nip77Reconcile && phase2Result._relayOutcomes && phase2Result._cache) {
      const probeMap = new Map<RelayUrl, boolean>();
      if (nip77ProbeResults) {
        for (const pr of nip77ProbeResults) {
          if (pr.nip77Probed) probeMap.set(pr.relay, pr.nip77Supported ?? false);
        }
      }

      phase2Result.nip77Reconcile = await runNip77Reconciliation(
        input,
        phase2Result._cache as QueryCache,
        phase2Result._relayOutcomes,
        {
          concurrency: opts.nip77Concurrency,
          probeResults: probeMap.size > 0 ? probeMap : undefined,
        },
      );

      if (showTable) {
        printNip77ReconcileReport(phase2Result.nip77Reconcile);
      }
    }

    // Thompson Sampling learning: update relay scores from Phase 2 results (per-algorithm)
    if (hasThompson && phase2Result._baselines && phase2Result._cache) {
      const decayConfig: DecayConfig | undefined = opts.decayFactor !== undefined || opts.decayUnit !== undefined
        ? { factor: opts.decayFactor ?? 0.95, unit: opts.decayUnit ?? "session" }
        : undefined;

      for (let i = 0; i < algorithms.length; i++) {
        const entry = algorithms[i];
        if (!THOMPSON_IDS.has(entry.id)) continue;

        const thompsonResult = verifyResults[i];
        let db = thompsonDBs.get(entry.id) ??
          loadRelayScores(input.targetPubkey, opts.verifyWindow, opts.nip66Filter || undefined, entry.id);

        const altScoring = ALT_SCORING_IDS[entry.id];
        if (altScoring) {
          db = altScoring(
            db,
            entry.id,
            thompsonResult.relayAssignments,
            thompsonResult.pubkeyAssignments,
            phase2Result._baselines,
            phase2Result._cache as QueryCache,
            phase2Result._relayOutcomes,
            input.writerToRelays,
            decayConfig,
          );
        } else {
          db = updateRelayScores(
            db,
            entry.id,
            thompsonResult.relayAssignments,
            thompsonResult.pubkeyAssignments,
            phase2Result._baselines,
            phase2Result._cache as QueryCache,
            phase2Result._relayOutcomes,
            undefined,
            decayConfig,
          );
        }
        db.decayFactor = decayConfig?.factor ?? 0.95;
        db.decayUnit = decayConfig?.unit ?? "session";
        thompsonDBs.set(entry.id, db);
        await saveRelayScores(db, opts.nip66Filter || undefined, entry.id);

        // Print learning state summary
        const entries = Object.values(db.relays);
        const meanAlpha = entries.length > 0
          ? entries.reduce((s, e) => s + e.alpha, 0) / entries.length
          : 1;
        const meanBeta = entries.length > 0
          ? entries.reduce((s, e) => s + e.beta, 0) / entries.length
          : 1;
        const strongPreference = entries.filter((e) => e.alpha > 5).length;
        const learnedToAvoid = entries.filter((e) => e.beta > 5).length;

        console.log(`\nThompson Sampling [${entry.id}] learning state:`);
        console.log(`  Session: ${db.sessionCount}`);
        console.log(`  Relays with observations: ${entries.length}`);
        console.log(`  Mean prior α: ${meanAlpha.toFixed(1)}, β: ${meanBeta.toFixed(1)}`);
        console.log(`  Relays with strong preference (α>5): ${strongPreference}`);
        console.log(`  Relays learned to avoid (β>5): ${learnedToAvoid}`);
      }
    }

    // Hint Tier 2: probe hint relays for uncovered authors
    if (hintMap && phase2Result._baselines && phase2Result._cache) {
      await probeHintRelays(
        phase2Result._baselines,
        phase2Result._cache as QueryCache,
        verifyResults,
        phase2Result.algorithms,
        hintMap,
        { kinds: [1], windowSeconds: opts.verifyWindow, maxConcurrentConns: opts.verifyConcurrency },
      );
    }
  }

  // JSON output
  if (showJson) {
    const output = buildJsonOutput(
      input,
      regimeAMetrics,
      regimeAResults,
      seed,
      opts.fullAssignments,
      opts.nip66Filter,
    );
    // Include Phase 2 results if available (strip internal fields)
    if (phase2Result) {
      const { _baselines: _, _cache: __, _relayOutcomes: ___, ...serializablePhase2 } = phase2Result;
      // deno-lint-ignore no-explicit-any
      (output as any).phase2 = serializablePhase2;
    }
    const path = await writeJsonOutput(output, input.targetPubkey);
    console.log(`\nJSON results written to: ${path}`);
  }
}

async function runSweep(
  input: BenchmarkInput,
  algorithms: ReturnType<typeof getAlgorithms>,
  opts: CliOptions,
  seed: number,
  runs: number,
  showTable: boolean,
  showJson: boolean,
  hintMap?: HintMap,
  nip66Data?: ReadonlyMap<string, Nip66RelayData>,
): Promise<void> {
  const budgets = opts.fast ? SWEEP_BUDGETS_FAST : SWEEP_BUDGETS_FULL;
  const sweepRows: SweepRow[] = [];

  for (const entry of algorithms) {
    const row: SweepRow = {
      name: entry.name,
      coverageByBudget: {},
    };

    for (const budget of budgets) {
      const maxConn = budget === "unlimited" ? Infinity : budget;
      const params: AlgorithmParams = {
        ...entry.defaults,
        maxConnections: maxConn,
      };
      if (opts.relaysPerUser !== undefined) {
        params.maxRelaysPerUser = opts.relaysPerUser;
        params.relayGoalPerAuthor = opts.relaysPerUser;
        params.relayLimit = opts.relaysPerUser;
        params.writeLimit = opts.relaysPerUser;
      }

      let coverage: number;
      if (entry.stochastic) {
        // Single run during sweep for speed
        const rng = mulberry32(seed);
        const result = runAlgorithm(entry, input, params, rng);
        const metrics = computeMetrics(result, input, params);
        coverage = metrics.assignmentCoverage;
      } else {
        const rng = mulberry32(seed);
        const result = runAlgorithm(entry, input, params, rng);
        const metrics = computeMetrics(result, input, params);
        coverage = metrics.assignmentCoverage;
      }

      row.coverageByBudget[budget] = coverage;
    }

    sweepRows.push(row);
  }

  if (showTable) {
    printSweepTable(sweepRows, budgets);
  }

  // Also run default regime for full metrics at default cap
  console.log("");
  await runDefault(input, algorithms, opts, seed, runs, showTable, showJson, hintMap, nip66Data);
}

main().then(() => {
  Deno.exit(0);
}).catch((err) => {
  console.error("Fatal error:", err);
  Deno.exit(1);
});
