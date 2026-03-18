# NIP-77 (Negentropy) Relay Correlation: Phase 1 Findings

> Initial results from one profile. More data points needed before drawing strong conclusions.

## Question

Are NIP-77-capable relays better relays? If a relay supports negentropy sync (NIP-77), does that correlate with better performance on the metrics we already measure?

## Method

Partition all relays queried during Phase 2 verification by NIP-77 support (detected from NIP-66 monitor `supported_nips` data). Compare group-level performance: connect latency, query latency, success rate, event delivery rate, timeout rate, mean event count.

No new network calls. Pure data plumbing over existing Phase 2 + NIP-66 data.

```
deno task bench <pubkey> --verify --nip66-filter liveness --algorithms greedy --fast --output table
```

## Results

**Profile: 2c6594... (2,747 follows) | 2026-03-18 | 1d window | NIP-66 liveness filter**

566 relays queried after liveness filter. NIP-66 data from 13 monitors.

| Group | Count | Connect (median) | Query (median) | Success Rate | Delivery Rate | Timeout Rate | Mean Events |
|-------|------:|------------------:|---------------:|-------------:|--------------:|-------------:|------------:|
| NIP-77 | 146 | 581ms | 842ms | 99.3% | 47.3% | 1.4% | 95 |
| Non-NIP-77 | 420 | 613ms | 838ms | 83.1% | 26.0% | 10.5% | 11 |

### Key observations

1. **Success rate gap is large.** NIP-77 relays connect 99.3% vs 83.1%. These relays are better-maintained infrastructure.

2. **Delivery rate nearly 2x.** 47.3% of NIP-77 relays returned events for the queried pubkeys vs 26.0% for non-NIP-77 relays. NIP-77 relays store more content.

3. **Timeout rate 7.5x lower.** 1.4% vs 10.5%. NIP-77 relays are more responsive.

4. **Mean event count ~9x higher.** 95 vs 11 events per relay. NIP-77 relays hold significantly more data per author.

5. **Latency is similar.** Connect: 581ms vs 613ms. Query: 842ms vs 838ms. NIP-77 doesn't predict latency well -- relay location and network path dominate.

### Interpretation

NIP-77 support is a strong signal for relay quality. This makes intuitive sense: implementing negentropy requires a relay operator who (a) runs recent software, (b) actively maintains their relay, and (c) has enough storage to make sync worthwhile. These same traits correlate with uptime, responsiveness, and content availability.

This does NOT mean NIP-77 *causes* better performance. It's a selection effect: serious relay operators adopt NIP-77; serious relay operators also have better infrastructure.

## Implications for relay selection

If NIP-77 support is this strong a quality signal, it could be used as:

1. **Tiebreaker in relay selection.** When two relays cover similar pubkeys, prefer the NIP-77-capable one.
2. **Lightweight health heuristic.** Cheaper than probing -- just check NIP-66 data.
3. **Connection budget optimization.** If NIP-77 relays are more reliable, you can trust them with more pubkey assignments (lower redundancy needed).

These hypotheses need validation across more profiles before acting on them.

## Limitations

- **Single profile.** n=1. The correlation could differ for profiles with different follow-graph characteristics.
- **NIP-66 detection only.** Some relays may support NIP-77 but not be reported by monitors. Phase 2 (NEG-OPEN probe) will validate this.
- **Survivorship bias.** The NIP-66 liveness filter already removed ~1,068 dead relays before this analysis. The non-NIP-77 group still includes many weak relays that passed liveness but are marginal.
- **Correlation, not causation.** See interpretation above.

## Next steps

- **Phase 2: NEG-OPEN probe.** Test actual NIP-77 support via live NEG-OPEN messages. Compare NIP-66 claims vs reality. (`--nip77-probe`)
- **Phase 3: Reconciliation benchmark.** Measure actual bandwidth savings. (`--nip77-reconcile`)
- **Multi-profile runs.** Run across 5+ profiles to validate the correlation holds.

## Reproducibility

```bash
# Exact command used
deno task bench 2c65940725bbf10b452197fba41c6cb14afd41e28e0be22aab49bf246b0c84e3 \
  --verify --nip66-filter liveness --algorithms greedy --fast --output table
```

Phase 1 correlation runs automatically when `--verify` + NIP-66 data are both available. No additional flags needed.
