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
import { printPhase2Table } from "./src/phase2/report.ts";
import { fetchNip66MonitorData } from "./src/nip66/fetch.ts";
import { parseNip66FilterArg, classifyCandidates } from "./src/nip66/filter.ts";
import {
  loadRelayScores,
  updateRelayScores,
  saveRelayScores,
  getRelayPriors,
} from "./src/relay-scores.ts";
import { QueryCache } from "./src/relay-pool.ts";
import type {
  AlgorithmMetrics,
  AlgorithmParams,
  AlgorithmResult,
  BenchmarkInput,
  CliOptions,
  FilterProfile,
  Phase2Result,
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
  --nip66-filter <mode>     NIP-66 liveness filter: liveness (default), strict
  --nip66-ttl <ms>          NIP-66 cache TTL override in ms
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
    ],
    boolean: ["sweep", "fast", "full-assignments", "no-cache", "no-phase2-cache", "verbose", "verify", "help"],
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
    verbose: !!args.verbose,
    verify: !!args.verify,
    verifyWindow: parseInt(args["verify-window"]!, 10),
    verifyWindows,
    verifyConcurrency: parseInt(args["verify-concurrency"]!, 10),
    nip66Filter: parseNip66FilterArg(args["nip66-filter"]),
    nip66TtlMs: args["nip66-ttl"] ? parseInt(args["nip66-ttl"], 10) : undefined,
  };
}

async function main(): Promise<void> {
  const opts = parseCliOptions();

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
    );
    if (input) {
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

    if (!opts.noCache) {
      await writeCachedInput(
        input,
        opts.filterProfile,
        opts.indexers.length ? opts.indexers : ["wss://purplepag.es", "wss://relay.damus.io", "wss://nos.lol"],
      );
    }
  }

  if (input.follows.length === 0) {
    console.log("0 follows found. Nothing to analyze.");
    return;
  }

  // Print fetch quality
  const showTable = opts.output === "table" || opts.output === "both";
  const showJson = opts.output === "json" || opts.output === "both";

  if (showTable) {
    printFetchQuality(input.fetchMeta);
    console.log(`Unique valid write relays: ${input.relayToWriters.size} | Seed: ${seed}`);
  }

  // NIP-66 liveness filter: remove dead relays before algorithm runs
  if (opts.nip66Filter) {
    const nip66Data = await fetchNip66MonitorData(opts.nip66TtlMs);

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

  // Get algorithms
  const algorithms = getAlgorithms(opts.algorithms);

  if (opts.sweep) {
    if (opts.maxConnections !== undefined) {
      console.log("Warning: --sweep overrides --max-connections");
    }
    await runSweep(input, algorithms, opts, seed, runs, showTable, showJson);
  } else {
    await runDefault(input, algorithms, opts, seed, runs, showTable, showJson);
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
): Promise<void> {
  const maxConnections = opts.maxConnections ?? 20;

  // Load Thompson Sampling priors (if available from previous sessions)
  const THOMPSON_IDS = new Set(["welshman-thompson", "fd-thompson"]);
  const hasThompson = algorithms.some((a) => THOMPSON_IDS.has(a.id));
  let relayScoreDB = hasThompson && opts.verify
    ? loadRelayScores(input.targetPubkey, opts.verifyWindow, opts.nip66Filter || undefined)
    : null;
  const relayPriors = relayScoreDB ? getRelayPriors(relayScoreDB) : undefined;

  if (relayPriors && relayPriors.size > 0) {
    console.log(`\nThompson Sampling: loaded ${relayPriors.size} relay priors (session ${relayScoreDB!.sessionCount})`);
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

    // Inject Thompson Sampling priors
    if (THOMPSON_IDS.has(entry.id) && relayPriors) {
      params.relayPriors = relayPriors;
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
        // Inject Thompson Sampling priors for the verify run too
        if (THOMPSON_IDS.has(entry.id) && relayPriors) {
          params.relayPriors = relayPriors;
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

    // Thompson Sampling learning: update relay scores from Phase 2 results
    if (hasThompson && phase2Result._baselines && phase2Result._cache) {
      // Learn from the first Thompson algorithm found
      const thompsonIdx = algorithms.findIndex((a) => THOMPSON_IDS.has(a.id));
      if (thompsonIdx >= 0) {
        const thompsonResult = verifyResults[thompsonIdx];
        if (!relayScoreDB) {
          relayScoreDB = loadRelayScores(input.targetPubkey, opts.verifyWindow, opts.nip66Filter || undefined);
        }
        relayScoreDB = updateRelayScores(
          relayScoreDB,
          algorithms[thompsonIdx].id,
          thompsonResult.relayAssignments,
          thompsonResult.pubkeyAssignments,
          phase2Result._baselines,
          phase2Result._cache as QueryCache,
        );
        await saveRelayScores(relayScoreDB, opts.nip66Filter || undefined);

        // Print learning state summary
        const entries = Object.values(relayScoreDB.relays);
        const meanAlpha = entries.length > 0
          ? entries.reduce((s, e) => s + e.alpha, 0) / entries.length
          : 1;
        const meanBeta = entries.length > 0
          ? entries.reduce((s, e) => s + e.beta, 0) / entries.length
          : 1;
        const strongPreference = entries.filter((e) => e.alpha > 5).length;
        const learnedToAvoid = entries.filter((e) => e.beta > 5).length;

        console.log(`\nThompson Sampling learning state:`);
        console.log(`  Session: ${relayScoreDB.sessionCount}`);
        console.log(`  Relays with observations: ${entries.length}`);
        console.log(`  Mean prior α: ${meanAlpha.toFixed(1)}, β: ${meanBeta.toFixed(1)}`);
        console.log(`  Relays with strong preference (α>5): ${strongPreference}`);
        console.log(`  Relays learned to avoid (β>5): ${learnedToAvoid}`);
      }
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
      const { _baselines: _, _cache: __, ...serializablePhase2 } = phase2Result;
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
  await runDefault(input, algorithms, opts, seed, runs, showTable, showJson);
}

main().then(() => {
  Deno.exit(0);
}).catch((err) => {
  console.error("Fatal error:", err);
  Deno.exit(1);
});
