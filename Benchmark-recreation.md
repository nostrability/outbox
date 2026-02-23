# Benchmark Recreation Guide

Step-by-step instructions to reproduce all results in the outbox model analysis.

## Prerequisites

- [Deno](https://deno.com/) v2+
- Internet connection (for initial relay data fetch and Phase 2 event verification)
- ~10 minutes for Phase 1 (all 26 profiles), ~30-60 minutes for Phase 2 (per profile)

## 1. Setup

```bash
cd bench
```

All commands below assume you're in the `bench/` directory.

## 2. Academic: Assignment Coverage (Phase 1)

Phase 1 computes relay-to-pubkey assignments from NIP-65 data. It fetches kind 3 (contact list) and kind 10002 (relay list) events from indexer relays, then runs all 14 algorithms against the same input. **No relay connections are made beyond the initial data fetch.**

### Run a single profile

```bash
deno task bench <hex_pubkey>
```

This runs all 14 algorithms at the default 20-connection cap, outputs a table and JSON results.

### Run all 26 profiles from the report

The profiles used in the report, with hex pubkeys:

```bash
# ODELL (1,779 follows)
deno task bench 04c915daefee38317fa734444acee390a8269fe5810b2241e5e6dd343dfbecc9

# Derek Ross (1,328)
deno task bench 3f770d65d3a764a9c5cb503ae123e62ec7598ad035d836e2a810f3877a745b24

# pablof7z (1,050)
deno task bench fa984bd7dbb282f07e16e7ae87b26a2a7b9b90b7246a44771f0cf5ae58018f52

# Gigi (1,033)
deno task bench 6e468422dfb74a5738702a8823b9b28168abab8655faacb6853cd0ee15deee93

# jb55 (943)
deno task bench 32e1827635450ebb3c5a7d12c1f8e7b2b514439ac10a67eef3d9fd9c5c68e245

# verbiricha (938)
deno task bench 7fa56f5d6962ab1e3cd424e758c3002b8665f7b0d8dcee9fe9e288d7751ac194

# miljan (811)
deno task bench d61f3bc5b3eb4400efdae6169a5c17cabf3246b514361de939ce4a1a0da6ef4a

# Calle (718)
deno task bench 50d94fc2d8580c682b071a542f8b1e31a200b0508bab95a33bef0855df281d63

# jack (694)
deno task bench 82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2

# Karnage (581)
deno task bench 1bc70a0148b3f316da33fe3c89f23e3e71ac4ff998027ec712b905cd24f6a411

# NVK (502)
deno task bench e88a691e98d9987c964521dff60025f60700378a4879180dcbbb4a5027850411

# hodlbod (442)
deno task bench 97c70a44366a6535c145b333f973ea86dfdc2d7a99da618c40c64705ad98e322

# Alex Gleason (434)
deno task bench 0461fcbecc4c3374439932d6b8f11269ccdb7cc973ad7a50ae362db135a474dd

# Semisol (421)
deno task bench 52b4a076bcbbbdc3a1aefa3735816cf74993b1b8db202b01c883c58be7fad8bd

# Martti Malmi (395)
deno task bench 4523be58d395b1b196a9b8c82b038b6895cb02b683d0c253a955068dba1facd0

# hzrd149 (388)
deno task bench 266815e0c9210dfa324c6cba3573b14bee49da4209a9456f9484e5106cd408a5

# Kieran (377)
deno task bench 63fe6318dc58583cfe16810f86dd09e18bfd76aabc24a0081ce2856f330504ed

# Preston Pysh (369)
deno task bench 85080d3bad70ccdcd7f74c29a44f55bb85cbcd3dd0cbb957da1d215bdb931204

# Tony Giorgio (361)
deno task bench 5be6446aa8a31c11b3b453bf8dafc9b346ff328d1fa11a0fa02a1e6461f6a9b1

# Snowden (354)
deno task bench 84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240

# Vitor (240)
deno task bench 460c25e682fda7832b52d1f22d3d22b3176d972f60dcdc3212ed8c92ef85065c

# Dilger (233)
deno task bench ee11a5dff40c19a555f41fe42b48f00e618c91225622ae37b6c2bb67b76c4e49

# Lyn Alden (226)
deno task bench eab0e756d32b80bcd464f3d844b8040303075a13eabc3599a762c9ac7ab91f4f

# fiatjaf (194)
deno task bench 3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d

# Ben Arc (137)
deno task bench c1fc7771f5fa418fd3ac49221a18f19b42ccb7a663da8f04cbbf6c08c80d20b1

# Rabble (105)
deno task bench 76c71aae3a491f1d9eec47cba17e229cda4113a0bbb6e6ae1776d7643e29cafa
```

### Run specific algorithms only

```bash
# Client-derived only
deno task bench <hex> --algorithms greedy,ndk,welshman,nostur,rust-nostr,direct

# CS-inspired only
deno task bench <hex> --algorithms ilp,matching,spectral,mab,streaming,stochastic-greedy

# Baselines only
deno task bench <hex> --algorithms primal,popular-random
```

### Connection budget sweep

Runs each algorithm at multiple connection caps (5, 10, 15, 20, 25, 28, 30, 50, 100, unlimited):

```bash
deno task bench <hex> --sweep
```

## 3. Real-World: Event Verification (Phase 2)

Phase 2 connects to actual relays and queries for kind-1 events, comparing each algorithm's selected relay set against a multi-relay baseline. **This is network-intensive and slow.**

### Run event verification (default 24h window)

```bash
deno task bench <hex> --verify
```

### Run with specific time windows

```bash
# 7 days
deno task bench <hex> --verify --verify-window 604800

# 30 days
deno task bench <hex> --verify --verify-window 2592000

# 365 days
deno task bench <hex> --verify --verify-window 31536000

# 3 years (1095 days)
deno task bench <hex> --verify --verify-window 94608000
```

### Reproduce the report's Phase 2 results

The Phase 2 table in the report was generated from fiatjaf's profile across 6 time windows. To reproduce:

```bash
# Run each window separately (each takes 10-30 minutes)
deno task bench 3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d --verify --verify-window 604800
deno task bench 3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d --verify --verify-window 1209600
deno task bench 3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d --verify --verify-window 2592000
deno task bench 3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d --verify --verify-window 7776000
deno task bench 3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d --verify --verify-window 31536000
deno task bench 3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d --verify --verify-window 94608000
```

## 4. Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--algorithms` | `all` | Comma-separated list or `all` |
| `--max-connections` | `20` | Global connection cap |
| `--relays-per-user` | varies | Override per-pubkey relay target |
| `--runs` | `10` | Stochastic algorithm repetitions |
| `--seed` | `0` | PRNG seed (use `random` for non-deterministic) |
| `--filter-profile` | `strict` | `strict` or `neutral` relay filtering |
| `--verify` | off | Enable Phase 2 event verification |
| `--verify-window` | `86400` | Time window in seconds |
| `--verify-concurrency` | `20` | Max concurrent relay connections |
| `--no-cache` | off | Force fresh data fetch |
| `--verbose` | off | Per-relay details |
| `--fast` | off | Reduced sweep + stochastic runs |

## 5. Output

- **Table output** prints to stdout
- **JSON results** written to `bench/results/<pubkey>_<timestamp>.json`
- **Cache** stored in `bench/.cache/` (1-hour TTL, auto-refreshes)

## 6. Expected Variability

Results may differ from the report due to:

- **NIP-65 data changes.** Users update their relay lists. Follow counts change. A profile with 943 follows today may have 960 next week.
- **Relay availability.** Phase 2 results depend on which relays are online at query time. The 55% relay success rate is structural (auth-required, WoT-gated) but individual relay outages vary.
- **Event retention.** Relays prune old events. Long-window (365d, 1095d) results will drift over time as events age out.
- **Stochastic algorithms.** Welshman, MAB-UCB, Streaming, Spectral, and Stochastic Greedy use randomness. Use `--seed 0` for deterministic reproduction; results with different seeds will vary within the confidence intervals reported.

Phase 1 (academic coverage) results should be nearly identical if run within a few days of the original benchmarks with cached data. Phase 2 (real-world event recall) results will show more variance.

## 7. Algorithm IDs

For use with `--algorithms`:

| ID | Algorithm |
|----|-----------|
| `greedy` | Greedy Set-Cover |
| `ndk` | Priority-Based (NDK) |
| `welshman` | Weighted Stochastic |
| `nostur` | Greedy Coverage Sort |
| `rust-nostr` | Filter Decomposition |
| `direct` | Direct Mapping |
| `primal` | Primal Aggregator |
| `popular-random` | Popular+Random |
| `ilp` | ILP Optimal |
| `stochastic-greedy` | Stochastic Greedy |
| `mab` | MAB-UCB |
| `streaming` | Streaming Coverage |
| `matching` | Bipartite Matching |
| `spectral` | Spectral Clustering |
