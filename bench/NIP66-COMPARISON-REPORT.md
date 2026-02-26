<!-- Loaded 71 non-cached results -->
<!-- After dedup: 66 results -->
<!-- Formed 33 NIP-66 vs no-NIP-66 pairs -->

# NIP-66 Liveness Filter: Before/After Benchmark Report

> Generated from 33 paired benchmark runs across 17 profiles and 4 time windows.

## Section 1: Infrastructure Impact

| Profile (follows) | Window | Relays (no NIP-66 -> NIP-66) | Dead % | Success rate (no -> yes) | Wall-clock (no -> yes) | Median connect (no -> yes) | Median query (no -> yes) |
|---|---|---|---|---|---|---|---|
| `76c71aae3a491f1d9eec` (108) | 1d | 175 -> 123 | 29.7% | 62.9% -> 86.2% | 30.6s -> 25.0s (+18%) | 658ms -> 714ms | 883ms -> 1.0s |
| `00f471f6312ce408f7eb` (114) | 1d | 259 -> 163 | 37.1% | 58.3% -> 90.2% | 33.1s -> 25.8s (+22%) | 648ms -> 700ms | 846ms -> 964ms |
| `c1fc7771f5fa418fd3ac` (137) | 1d | 188 -> 97 | 48.4% | 47.9% -> 86.6% | 32.4s -> 16.2s (+50%) | 643ms -> 701ms | 861ms -> 986ms |
| `3bf0c63fcb93463407af` (194) | 1d | 234 -> 141 | 39.7% | 56.4% -> 90.1% | 30.2s -> 19.5s (+36%) | 734ms -> 629ms | 953ms -> 804ms |
| `3bf0c63fcb93463407af` (194) | 7d | 233 -> 140 | 39.9% | 55.8% -> 87.1% | 42.9s -> 25.0s (+42%) | - | - |
| `3bf0c63fcb93463480ae` (194) | 1y | 233 -> 135 | 42.1% | 53.2% -> 88.9% | 43.9s -> 29.4s (+33%) | - | - |
| `3bf0c63fcb93463407af` (194) | 1y | 233 -> 140 | 39.9% | 55.4% -> 87.9% | 48.9s -> 34.8s (+29%) | - | - |
| `3bf0c63fcb93463480ae` (194) | 3y | 233 -> 135 | 42.1% | 53.2% -> 88.1% | 44.7s -> 33.5s (+25%) | - | - |
| `3bf0c63fcb93463407af` (194) | 3y | 233 -> 140 | 39.9% | 55.4% -> 87.1% | 47.6s -> 38.4s (+19%) | - | - |
| `eab0e756d32b80bcd464` (227) | 1d | 254 -> 118 | 53.5% | 42.5% -> 84.7% | 38.3s -> 27.4s (+28%) | 663ms -> 708ms | 882ms -> 982ms |
| `ee11a5dff40c19a555f4` (233) | 1d | 333 -> 152 | 54.4% | 42.9% -> 84.9% | 35.5s -> 20.3s (+43%) | 642ms -> 745ms | 847ms -> 1.0s |
| `3c827db6c45f7e6221fa` (283) | 1d | 300 -> 141 | 53.0% | 41.3% -> 82.3% | 41.8s -> 26.6s (+36%) | 643ms -> 690ms | 845ms -> 922ms |
| `6a0c596c1484eae2e813` (399) | 7d | 559 -> 182 | 67.4% | 26.1% -> 79.7% | 99.8s -> 35.9s (+64%) | - | - |
| `6a0c596c1484eae2e813` (399) | 1y | 559 -> 182 | 67.4% | 26.7% -> 78.0% | 98.6s -> 41.3s (+58%) | - | - |
| `6a0c596c1484eae2e813` (399) | 3y | 559 -> 182 | 67.4% | 26.8% -> 79.1% | 94.4s -> 36.3s (+62%) | - | - |
| `fff19947841c84c56740` (405) | 1d | 396 -> 177 | 55.3% | 40.9% -> 88.7% | 43.5s -> 27.2s (+38%) | 665ms -> 806ms | 876ms -> 1.2s |
| `e1ff3bfdd4e40315959b` (416) | 1d | 334 -> 152 | 54.5% | 40.7% -> 84.9% | 43.4s -> 23.8s (+45%) | 647ms -> 709ms | 847ms -> 951ms |
| `97c70a44366a6535c145` (442) | 7d | 487 -> 252 | 48.3% | 45.4% -> 82.9% | 102.3s -> 53.2s (+48%) | - | - |
| `97c70a44366a6535c145` (442) | 1y | 487 -> 252 | 48.3% | 45.6% -> 83.3% | 101.9s -> 69.2s (+32%) | - | - |
| `97c70a44366a6535c145` (442) | 3y | 487 -> 252 | 48.3% | 45.6% -> 82.1% | 110.3s -> 62.0s (+44%) | - | - |
| `bf2376e17ba4ec269d10` (821) | 1d | 609 -> 241 | 60.4% | 34.5% -> 83.0% | 69.1s -> 32.6s (+53%) | 590ms -> 660ms | 790ms -> 911ms |
| `32e1827635450ebb3c5a` (943) | 7d | 729 -> 296 | 59.4% | 35.4% -> 83.1% | 139.1s -> 55.4s (+60%) | - | - |
| `32e1827635450ebb3c5a` (943) | 1y | 729 -> 296 | 59.4% | 35.1% -> 82.1% | 152.9s -> 67.3s (+56%) | - | - |
| `32e1827635450ebb3c5a` (943) | 3y | 729 -> 296 | 59.4% | 35.3% -> 83.4% | 153.1s -> 79.4s (+48%) | - | - |
| `dd3a97900e337fd3d0f1` (1077) | 7d | 862 -> 354 | 58.9% | 35.2% -> 79.4% | 183.2s -> 79.8s (+56%) | - | - |
| `dd3a97900e337fd3d0f1` (1077) | 1y | 862 -> 354 | 58.9% | 34.7% -> 78.5% | 188.5s -> 89.1s (+53%) | - | - |
| `dd3a97900e337fd3d0f1` (1077) | 3y | 862 -> 354 | 58.9% | 34.6% -> 79.7% | 189.0s -> 89.7s (+53%) | - | - |
| `04c915daefee38317fa7` (1774) | 7d | 1201 -> 437 | 63.6% | 30.2% -> 76.2% | 262.3s -> 109.0s (+58%) | - | - |
| `04c915daefee38317fa7` (1774) | 1y | 1201 -> 437 | 63.6% | 29.9% -> 75.7% | 269.0s -> 117.9s (+56%) | - | - |
| `04c915daefee38317fa7` (1774) | 3y | 1201 -> 437 | 63.6% | 30.6% -> 76.0% | 265.9s -> 130.2s (+51%) | - | - |
| `2c65940725bbf10bfbbf` (2784) | 7d | 1642 -> 585 | 64.4% | 29.5% -> 74.0% | 334.7s -> 139.0s (+58%) | - | - |
| `2c65940725bbf10bfbbf` (2784) | 1y | 1642 -> 585 | 64.4% | 29.4% -> 74.4% | 352.2s -> 156.9s (+55%) | - | - |
| `2c65940725bbf10bfbbf` (2784) | 3y | 1642 -> 585 | 64.4% | 29.6% -> 73.8% | 351.0s -> 162.2s (+54%) | - | - |

## Section 2: Event Recall Impact

| Profile | Window | Algorithm | Recall (no NIP-66) | Recall (NIP-66) | Delta | Flag |
|---|---|---|---|---|---|---|
| `76c71aae3a491f1d9eec` (108) | 1d | Bipartite Matching | 97.0% | 97.1% | +0.04pp |  |
| `76c71aae3a491f1d9eec` (108) | 1d | Direct Mapping (cap@20) | 98.0% | 99.5% | +1.49pp |  |
| `76c71aae3a491f1d9eec` (108) | 1d | Filter Decomposition (cap@20) | 84.9% | 97.6% | +12.65pp | improved |
| `76c71aae3a491f1d9eec` (108) | 1d | Greedy Coverage Sort | 72.3% | 73.3% | +1.07pp |  |
| `76c71aae3a491f1d9eec` (108) | 1d | Greedy Set-Cover | 100.0% | 100.0% | +0.00pp |  |
| `76c71aae3a491f1d9eec` (108) | 1d | Greedy+ε-Explore (seed=0, single run) | 100.0% | 100.0% | +0.00pp |  |
| `76c71aae3a491f1d9eec` (108) | 1d | Hybrid Greedy+Explore (seed=0, single run) | 96.5% | 96.6% | +0.04pp |  |
| `76c71aae3a491f1d9eec` (108) | 1d | ILP Optimal | 98.5% | 100.0% | +1.49pp |  |
| `76c71aae3a491f1d9eec` (108) | 1d | MAB-UCB Relay (seed=0, single run) | 98.5% | 100.0% | +1.49pp |  |
| `76c71aae3a491f1d9eec` (108) | 1d | Popular+Random (cap@20) | 99.0% | 98.5% | -0.48pp |  |
| `76c71aae3a491f1d9eec` (108) | 1d | Primal Aggregator | 40.8% | 41.6% | +0.72pp |  |
| `76c71aae3a491f1d9eec` (108) | 1d | Priority-Based (NDK) | 100.0% | 100.0% | +0.00pp |  |
| `76c71aae3a491f1d9eec` (108) | 1d | Spectral Clustering (seed=0, single run) | 100.0% | 100.0% | +0.00pp |  |
| `76c71aae3a491f1d9eec` (108) | 1d | Stochastic Greedy (seed=0, single run) | 48.3% | 89.2% | +40.97pp | improved |
| `76c71aae3a491f1d9eec` (108) | 1d | Streaming Coverage (seed=0, single run) | 98.5% | 99.5% | +1.00pp |  |
| `76c71aae3a491f1d9eec` (108) | 1d | Weighted Stochastic (seed=0, single run) | 98.3% | 99.3% | +1.00pp |  |
| `76c71aae3a491f1d9eec` (108) | 1d | Welshman+Thompson (seed=0, single run) | 98.3% | 99.3% | +1.00pp |  |
| `00f471f6312ce408f7eb` (114) | 1d | Bipartite Matching | 98.3% | 97.5% | -0.85pp |  |
| `00f471f6312ce408f7eb` (114) | 1d | Direct Mapping (cap@20) | 83.9% | 99.1% | +15.25pp | improved |
| `00f471f6312ce408f7eb` (114) | 1d | Filter Decomposition (cap@20) | 91.9% | 98.6% | +6.64pp | improved |
| `00f471f6312ce408f7eb` (114) | 1d | Greedy Coverage Sort | 79.3% | 78.7% | -0.55pp |  |
| `00f471f6312ce408f7eb` (114) | 1d | Greedy Set-Cover | 100.0% | 99.8% | -0.18pp |  |
| `00f471f6312ce408f7eb` (114) | 1d | Greedy+ε-Explore (seed=0, single run) | 100.0% | 98.9% | -1.07pp |  |
| `00f471f6312ce408f7eb` (114) | 1d | Hybrid Greedy+Explore (seed=0, single run) | 98.2% | 97.3% | -0.85pp |  |
| `00f471f6312ce408f7eb` (114) | 1d | ILP Optimal | 98.3% | 98.4% | +0.04pp |  |
| `00f471f6312ce408f7eb` (114) | 1d | MAB-UCB Relay (seed=0, single run) | 100.0% | 99.1% | -0.89pp |  |
| `00f471f6312ce408f7eb` (114) | 1d | Popular+Random (cap@20) | 99.4% | 99.1% | -0.34pp |  |
| `00f471f6312ce408f7eb` (114) | 1d | Primal Aggregator | 45.3% | 45.1% | -0.24pp |  |
| `00f471f6312ce408f7eb` (114) | 1d | Priority-Based (NDK) | 100.0% | 100.0% | +0.00pp |  |
| `00f471f6312ce408f7eb` (114) | 1d | Spectral Clustering (seed=0, single run) | 100.0% | 100.0% | +0.00pp |  |
| `00f471f6312ce408f7eb` (114) | 1d | Stochastic Greedy (seed=0, single run) | 53.0% | 96.6% | +43.57pp | improved |
| `00f471f6312ce408f7eb` (114) | 1d | Streaming Coverage (seed=0, single run) | 100.0% | 99.8% | -0.18pp |  |
| `00f471f6312ce408f7eb` (114) | 1d | Weighted Stochastic (seed=0, single run) | 91.9% | 98.7% | +6.82pp | improved |
| `00f471f6312ce408f7eb` (114) | 1d | Welshman+Thompson (seed=0, single run) | 91.9% | 98.7% | +6.82pp | improved |
| `c1fc7771f5fa418fd3ac` (137) | 1d | Bipartite Matching | 99.7% | 99.7% | +0.00pp |  |
| `c1fc7771f5fa418fd3ac` (137) | 1d | Direct Mapping (cap@20) | 95.5% | 95.5% | +0.00pp |  |
| `c1fc7771f5fa418fd3ac` (137) | 1d | Filter Decomposition (cap@20) | 91.3% | 92.2% | +0.90pp |  |
| `c1fc7771f5fa418fd3ac` (137) | 1d | Greedy Coverage Sort | 35.8% | 36.1% | +0.30pp |  |
| `c1fc7771f5fa418fd3ac` (137) | 1d | Greedy Set-Cover | 99.7% | 98.2% | -1.49pp |  |
| `c1fc7771f5fa418fd3ac` (137) | 1d | Greedy+ε-Explore (seed=0, single run) | 98.2% | 98.2% | +0.00pp |  |
| `c1fc7771f5fa418fd3ac` (137) | 1d | Hybrid Greedy+Explore (seed=0, single run) | 99.7% | 99.7% | +0.00pp |  |
| `c1fc7771f5fa418fd3ac` (137) | 1d | ILP Optimal | 99.7% | 99.7% | +0.00pp |  |
| `c1fc7771f5fa418fd3ac` (137) | 1d | MAB-UCB Relay (seed=0, single run) | 95.5% | 99.7% | +4.18pp | improved |
| `c1fc7771f5fa418fd3ac` (137) | 1d | Popular+Random (cap@20) | 93.7% | 95.5% | +1.79pp |  |
| `c1fc7771f5fa418fd3ac` (137) | 1d | Primal Aggregator | 44.2% | 44.2% | +0.00pp |  |
| `c1fc7771f5fa418fd3ac` (137) | 1d | Priority-Based (NDK) | 95.5% | 95.5% | +0.00pp |  |
| `c1fc7771f5fa418fd3ac` (137) | 1d | Spectral Clustering (seed=0, single run) | 99.7% | 99.7% | +0.00pp |  |
| `c1fc7771f5fa418fd3ac` (137) | 1d | Stochastic Greedy (seed=0, single run) | 63.3% | 72.5% | +9.25pp | improved |
| `c1fc7771f5fa418fd3ac` (137) | 1d | Streaming Coverage (seed=0, single run) | 100.0% | 85.7% | -14.33pp | **REGRESSED** |
| `c1fc7771f5fa418fd3ac` (137) | 1d | Weighted Stochastic (seed=0, single run) | 93.4% | 94.9% | +1.49pp |  |
| `c1fc7771f5fa418fd3ac` (137) | 1d | Welshman+Thompson (seed=0, single run) | 93.4% | 94.9% | +1.49pp |  |
| `3bf0c63fcb93463407af` (194) | 1d | Bipartite Matching | 99.7% | 99.1% | -0.57pp |  |
| `3bf0c63fcb93463407af` (194) | 1d | Direct Mapping (cap@20) | 93.7% | 93.9% | +0.16pp |  |
| `3bf0c63fcb93463407af` (194) | 1d | Filter Decomposition (cap@20) | 93.1% | 93.3% | +0.18pp |  |
| `3bf0c63fcb93463407af` (194) | 1d | Greedy Coverage Sort | 64.2% | 64.8% | +0.65pp |  |
| `3bf0c63fcb93463407af` (194) | 1d | Greedy Set-Cover | 99.4% | 98.8% | -0.57pp |  |
| `3bf0c63fcb93463407af` (194) | 1d | Greedy+ε-Explore (seed=0, single run) | 99.4% | 98.8% | -0.57pp |  |
| `3bf0c63fcb93463407af` (194) | 1d | Hybrid Greedy+Explore (seed=0, single run) | 94.9% | 94.5% | -0.45pp |  |
| `3bf0c63fcb93463407af` (194) | 1d | ILP Optimal | 99.7% | 99.1% | -0.57pp |  |
| `3bf0c63fcb93463407af` (194) | 1d | MAB-UCB Relay (seed=0, single run) | 94.0% | 95.3% | +1.32pp |  |
| `3bf0c63fcb93463407af` (194) | 1d | Popular+Random (cap@20) | 92.5% | 93.0% | +0.49pp |  |
| `3bf0c63fcb93463407af` (194) | 1d | Primal Aggregator | 52.2% | 51.2% | -1.08pp |  |
| `3bf0c63fcb93463407af` (194) | 1d | Priority-Based (NDK) | 95.5% | 95.1% | -0.46pp |  |
| `3bf0c63fcb93463407af` (194) | 1d | Spectral Clustering (seed=0, single run) | 99.7% | 99.1% | -0.57pp |  |
| `3bf0c63fcb93463407af` (194) | 1d | Stochastic Greedy (seed=0, single run) | 80.0% | 89.5% | +9.53pp | improved |
| `3bf0c63fcb93463407af` (194) | 1d | Streaming Coverage (seed=0, single run) | 99.7% | 99.1% | -0.57pp |  |
| `3bf0c63fcb93463407af` (194) | 1d | Weighted Stochastic (seed=0, single run) | 92.8% | 92.4% | -0.39pp |  |
| `3bf0c63fcb93463407af` (194) | 1d | Welshman+Thompson (seed=0, single run) | 92.8% | 92.4% | -0.39pp |  |
| `3bf0c63fcb93463407af` (194) | 7d | Greedy Set-Cover | 90.0% | 89.1% | -0.85pp |  |
| `3bf0c63fcb93463407af` (194) | 7d | Greedy+ε-Explore (seed=0, single run) | 91.4% | 90.5% | -0.87pp |  |
| `3bf0c63fcb93463407af` (194) | 7d | MAB-UCB Relay (seed=0, single run) | 91.1% | 93.8% | +2.66pp | improved |
| `3bf0c63fcb93463407af` (194) | 7d | Weighted Stochastic (seed=0, single run) | 90.3% | 88.6% | -1.71pp |  |
| `3bf0c63fcb93463407af` (194) | 7d | Welshman+Thompson (seed=0, single run) | 90.2% | 88.6% | -1.63pp |  |
| `3bf0c63fcb93463480ae` (194) | 1y | Bipartite Matching | 38.8% | 39.0% | +0.17pp |  |
| `3bf0c63fcb93463480ae` (194) | 1y | Direct Mapping (cap@20) | 17.9% | 21.3% | +3.44pp | improved |
| `3bf0c63fcb93463480ae` (194) | 1y | Filter Decomposition (cap@20) | 20.3% | 22.3% | +2.07pp | improved |
| `3bf0c63fcb93463480ae` (194) | 1y | Greedy Coverage Sort | 14.7% | 23.1% | +8.44pp | improved |
| `3bf0c63fcb93463480ae` (194) | 1y | Greedy Set-Cover | 15.9% | 19.9% | +4.04pp | improved |
| `3bf0c63fcb93463480ae` (194) | 1y | Hybrid Greedy+Explore (seed=0, single run) | 15.0% | 19.7% | +4.70pp | improved |
| `3bf0c63fcb93463480ae` (194) | 1y | ILP Optimal | 38.9% | 39.1% | +0.17pp |  |
| `3bf0c63fcb93463480ae` (194) | 1y | MAB-UCB Relay (seed=0, single run) | 43.6% | 44.9% | +1.23pp |  |
| `3bf0c63fcb93463480ae` (194) | 1y | NIP-66 Weighted Greedy | 29.7% | 29.8% | +0.12pp |  |
| `3bf0c63fcb93463480ae` (194) | 1y | Popular+Random (cap@20) | 12.4% | 13.2% | +0.79pp |  |
| `3bf0c63fcb93463480ae` (194) | 1y | Primal Aggregator | 2.2% | 2.2% | +0.01pp |  |
| `3bf0c63fcb93463480ae` (194) | 1y | Priority-Based (NDK) | 15.7% | 15.8% | +0.11pp |  |
| `3bf0c63fcb93463480ae` (194) | 1y | Spectral Clustering (seed=0, single run) | 38.5% | 39.1% | +0.57pp |  |
| `3bf0c63fcb93463480ae` (194) | 1y | Stochastic Greedy (seed=0, single run) | 13.1% | 12.5% | -0.58pp |  |
| `3bf0c63fcb93463480ae` (194) | 1y | Streaming Coverage (seed=0, single run) | 38.5% | 46.0% | +7.49pp | improved |
| `3bf0c63fcb93463480ae` (194) | 1y | Weighted Stochastic (seed=0, single run) | 16.7% | 43.0% | +26.26pp | improved |
| `3bf0c63fcb93463407af` (194) | 1y | Greedy Set-Cover | 15.9% | 16.3% | +0.39pp |  |
| `3bf0c63fcb93463407af` (194) | 1y | Greedy+ε-Explore (seed=0, single run) | 16.2% | 16.6% | +0.40pp |  |
| `3bf0c63fcb93463407af` (194) | 1y | MAB-UCB Relay (seed=0, single run) | 41.4% | 42.9% | +1.45pp |  |
| `3bf0c63fcb93463407af` (194) | 1y | Weighted Stochastic (seed=0, single run) | 23.9% | 39.9% | +15.95pp | improved |
| `3bf0c63fcb93463407af` (194) | 1y | Welshman+Thompson (seed=0, single run) | 38.8% | 39.9% | +1.09pp |  |
| `3bf0c63fcb93463480ae` (194) | 3y | Bipartite Matching | 20.9% | 23.3% | +2.39pp | improved |
| `3bf0c63fcb93463480ae` (194) | 3y | Direct Mapping (cap@20) | 9.6% | 12.7% | +3.11pp | improved |
| `3bf0c63fcb93463480ae` (194) | 3y | Filter Decomposition (cap@20) | 10.9% | 13.4% | +2.46pp | improved |
| `3bf0c63fcb93463480ae` (194) | 3y | Greedy Coverage Sort | 7.9% | 14.1% | +6.24pp | improved |
| `3bf0c63fcb93463480ae` (194) | 3y | Greedy Set-Cover | 9.2% | 22.9% | +13.62pp | improved |
| `3bf0c63fcb93463480ae` (194) | 3y | Hybrid Greedy+Explore (seed=0, single run) | 8.3% | 11.7% | +3.40pp | improved |
| `3bf0c63fcb93463480ae` (194) | 3y | ILP Optimal | 21.0% | 23.4% | +2.40pp | improved |
| `3bf0c63fcb93463480ae` (194) | 3y | MAB-UCB Relay (seed=0, single run) | 23.5% | 26.8% | +3.30pp | improved |
| `3bf0c63fcb93463480ae` (194) | 3y | NIP-66 Weighted Greedy | 19.4% | 21.6% | +2.24pp | improved |
| `3bf0c63fcb93463480ae` (194) | 3y | Popular+Random (cap@20) | 6.7% | 7.9% | +1.20pp |  |
| `3bf0c63fcb93463480ae` (194) | 3y | Primal Aggregator | 1.2% | 1.3% | +0.13pp |  |
| `3bf0c63fcb93463480ae` (194) | 3y | Priority-Based (NDK) | 9.1% | 10.5% | +1.41pp |  |
| `3bf0c63fcb93463480ae` (194) | 3y | Spectral Clustering (seed=0, single run) | 20.8% | 23.4% | +2.61pp | improved |
| `3bf0c63fcb93463480ae` (194) | 3y | Stochastic Greedy (seed=0, single run) | 19.2% | 14.0% | -5.21pp | **REGRESSED** |
| `3bf0c63fcb93463480ae` (194) | 3y | Streaming Coverage (seed=0, single run) | 20.8% | 43.1% | +22.30pp | improved |
| `3bf0c63fcb93463480ae` (194) | 3y | Weighted Stochastic (seed=0, single run) | 9.0% | 26.4% | +17.44pp | improved |
| `3bf0c63fcb93463407af` (194) | 3y | Greedy Set-Cover | 9.5% | 12.6% | +3.13pp | improved |
| `3bf0c63fcb93463407af` (194) | 3y | Greedy+ε-Explore (seed=0, single run) | 9.7% | 12.8% | +3.13pp | improved |
| `3bf0c63fcb93463407af` (194) | 3y | MAB-UCB Relay (seed=0, single run) | 23.0% | 23.3% | +0.29pp |  |
| `3bf0c63fcb93463407af` (194) | 3y | Weighted Stochastic (seed=0, single run) | 13.3% | 21.3% | +8.06pp | improved |
| `3bf0c63fcb93463407af` (194) | 3y | Welshman+Thompson (seed=0, single run) | 21.5% | 21.3% | -0.15pp |  |
| `eab0e756d32b80bcd464` (227) | 1d | Bipartite Matching | 99.7% | 100.0% | +0.32pp |  |
| `eab0e756d32b80bcd464` (227) | 1d | Direct Mapping (cap@20) | 91.6% | 97.8% | +6.20pp | improved |
| `eab0e756d32b80bcd464` (227) | 1d | Filter Decomposition (cap@20) | 91.1% | 96.2% | +5.10pp | improved |
| `eab0e756d32b80bcd464` (227) | 1d | Greedy Coverage Sort | 61.9% | 71.9% | +9.98pp | improved |
| `eab0e756d32b80bcd464` (227) | 1d | Greedy Set-Cover | 100.0% | 100.0% | +0.00pp |  |
| `eab0e756d32b80bcd464` (227) | 1d | Greedy+ε-Explore (seed=0, single run) | 100.0% | 100.0% | +0.00pp |  |
| `eab0e756d32b80bcd464` (227) | 1d | Hybrid Greedy+Explore (seed=0, single run) | 99.0% | 99.1% | +0.00pp |  |
| `eab0e756d32b80bcd464` (227) | 1d | ILP Optimal | 100.0% | 100.0% | +0.00pp |  |
| `eab0e756d32b80bcd464` (227) | 1d | MAB-UCB Relay (seed=0, single run) | 97.8% | 97.8% | +0.01pp |  |
| `eab0e756d32b80bcd464` (227) | 1d | Popular+Random (cap@20) | 97.1% | 97.2% | +0.01pp |  |
| `eab0e756d32b80bcd464` (227) | 1d | Primal Aggregator | 36.8% | 37.1% | +0.30pp |  |
| `eab0e756d32b80bcd464` (227) | 1d | Priority-Based (NDK) | 100.0% | 100.0% | +0.00pp |  |
| `eab0e756d32b80bcd464` (227) | 1d | Spectral Clustering (seed=0, single run) | 100.0% | 100.0% | +0.00pp |  |
| `eab0e756d32b80bcd464` (227) | 1d | Stochastic Greedy (seed=0, single run) | 93.2% | 71.7% | -21.45pp | **REGRESSED** |
| `eab0e756d32b80bcd464` (227) | 1d | Streaming Coverage (seed=0, single run) | 100.0% | 100.0% | +0.00pp |  |
| `eab0e756d32b80bcd464` (227) | 1d | Weighted Stochastic (seed=0, single run) | 89.7% | 97.3% | +7.63pp | improved |
| `eab0e756d32b80bcd464` (227) | 1d | Welshman+Thompson (seed=0, single run) | 89.7% | 97.3% | +7.63pp | improved |
| `ee11a5dff40c19a555f4` (233) | 1d | Bipartite Matching | 99.8% | 99.8% | -0.00pp |  |
| `ee11a5dff40c19a555f4` (233) | 1d | Direct Mapping (cap@20) | 90.1% | 90.7% | +0.62pp |  |
| `ee11a5dff40c19a555f4` (233) | 1d | Filter Decomposition (cap@20) | 86.5% | 89.5% | +3.00pp | improved |
| `ee11a5dff40c19a555f4` (233) | 1d | Greedy Coverage Sort | 76.8% | 79.6% | +2.76pp | improved |
| `ee11a5dff40c19a555f4` (233) | 1d | Greedy Set-Cover | 88.8% | 90.7% | +1.98pp |  |
| `ee11a5dff40c19a555f4` (233) | 1d | Greedy+ε-Explore (seed=0, single run) | 88.8% | 90.7% | +1.98pp |  |
| `ee11a5dff40c19a555f4` (233) | 1d | Hybrid Greedy+Explore (seed=0, single run) | 96.1% | 96.9% | +0.83pp |  |
| `ee11a5dff40c19a555f4` (233) | 1d | ILP Optimal | 99.8% | 99.8% | -0.00pp |  |
| `ee11a5dff40c19a555f4` (233) | 1d | MAB-UCB Relay (seed=0, single run) | 90.1% | 90.7% | +0.62pp |  |
| `ee11a5dff40c19a555f4` (233) | 1d | Popular+Random (cap@20) | 88.1% | 88.5% | +0.43pp |  |
| `ee11a5dff40c19a555f4` (233) | 1d | Primal Aggregator | 35.4% | 35.7% | +0.24pp |  |
| `ee11a5dff40c19a555f4` (233) | 1d | Priority-Based (NDK) | 88.2% | 88.9% | +0.61pp |  |
| `ee11a5dff40c19a555f4` (233) | 1d | Spectral Clustering (seed=0, single run) | 99.8% | 99.8% | -0.00pp |  |
| `ee11a5dff40c19a555f4` (233) | 1d | Stochastic Greedy (seed=0, single run) | 86.4% | 82.8% | -3.52pp | **REGRESSED** |
| `ee11a5dff40c19a555f4` (233) | 1d | Streaming Coverage (seed=0, single run) | 90.6% | 92.5% | +1.82pp |  |
| `ee11a5dff40c19a555f4` (233) | 1d | Weighted Stochastic (seed=0, single run) | 87.6% | 90.4% | +2.83pp | improved |
| `ee11a5dff40c19a555f4` (233) | 1d | Welshman+Thompson (seed=0, single run) | 87.6% | 90.4% | +2.83pp | improved |
| `3c827db6c45f7e6221fa` (283) | 1d | Bipartite Matching | 99.7% | 99.7% | +0.00pp |  |
| `3c827db6c45f7e6221fa` (283) | 1d | Direct Mapping (cap@20) | 95.7% | 95.7% | +0.04pp |  |
| `3c827db6c45f7e6221fa` (283) | 1d | Filter Decomposition (cap@20) | 75.9% | 76.7% | +0.78pp |  |
| `3c827db6c45f7e6221fa` (283) | 1d | Greedy Coverage Sort | 87.2% | 87.4% | +0.11pp |  |
| `3c827db6c45f7e6221fa` (283) | 1d | Greedy Set-Cover | 100.0% | 100.0% | +0.00pp |  |
| `3c827db6c45f7e6221fa` (283) | 1d | Greedy+ε-Explore (seed=0, single run) | 100.0% | 100.0% | +0.00pp |  |
| `3c827db6c45f7e6221fa` (283) | 1d | Hybrid Greedy+Explore (seed=0, single run) | 95.4% | 95.4% | +0.04pp |  |
| `3c827db6c45f7e6221fa` (283) | 1d | ILP Optimal | 99.7% | 99.7% | +0.00pp |  |
| `3c827db6c45f7e6221fa` (283) | 1d | MAB-UCB Relay (seed=0, single run) | 95.7% | 95.7% | +0.04pp |  |
| `3c827db6c45f7e6221fa` (283) | 1d | Popular+Random (cap@20) | 95.1% | 92.2% | -2.83pp | **REGRESSED** |
| `3c827db6c45f7e6221fa` (283) | 1d | Primal Aggregator | 38.8% | 39.4% | +0.53pp |  |
| `3c827db6c45f7e6221fa` (283) | 1d | Priority-Based (NDK) | 100.0% | 100.0% | +0.00pp |  |
| `3c827db6c45f7e6221fa` (283) | 1d | Spectral Clustering (seed=0, single run) | 99.7% | 99.7% | +0.00pp |  |
| `3c827db6c45f7e6221fa` (283) | 1d | Stochastic Greedy (seed=0, single run) | 72.5% | 78.7% | +6.27pp | improved |
| `3c827db6c45f7e6221fa` (283) | 1d | Streaming Coverage (seed=0, single run) | 99.4% | 97.1% | -2.29pp | **REGRESSED** |
| `3c827db6c45f7e6221fa` (283) | 1d | Weighted Stochastic (seed=0, single run) | 89.9% | 91.1% | +1.24pp |  |
| `3c827db6c45f7e6221fa` (283) | 1d | Welshman+Thompson (seed=0, single run) | 89.9% | 91.1% | +1.24pp |  |
| `6a0c596c1484eae2e813` (399) | 7d | Greedy Set-Cover | 82.2% | 82.7% | +0.48pp |  |
| `6a0c596c1484eae2e813` (399) | 7d | Greedy+ε-Explore (seed=0, single run) | 82.2% | 82.7% | +0.48pp |  |
| `6a0c596c1484eae2e813` (399) | 7d | MAB-UCB Relay (seed=0, single run) | 83.7% | 86.0% | +2.34pp | improved |
| `6a0c596c1484eae2e813` (399) | 7d | Weighted Stochastic (seed=0, single run) | 83.1% | 83.6% | +0.43pp |  |
| `6a0c596c1484eae2e813` (399) | 7d | Welshman+Thompson (seed=0, single run) | 83.9% | 83.6% | -0.31pp |  |
| `6a0c596c1484eae2e813` (399) | 1y | Greedy Set-Cover | 13.8% | 13.7% | -0.04pp |  |
| `6a0c596c1484eae2e813` (399) | 1y | Greedy+ε-Explore (seed=0, single run) | 13.8% | 13.7% | -0.04pp |  |
| `6a0c596c1484eae2e813` (399) | 1y | MAB-UCB Relay (seed=0, single run) | 22.6% | 27.7% | +5.10pp | improved |
| `6a0c596c1484eae2e813` (399) | 1y | Weighted Stochastic (seed=0, single run) | 19.1% | 24.5% | +5.44pp | improved |
| `6a0c596c1484eae2e813` (399) | 1y | Welshman+Thompson (seed=0, single run) | 25.7% | 24.5% | -1.13pp |  |
| `6a0c596c1484eae2e813` (399) | 3y | Greedy Set-Cover | 9.1% | 8.9% | -0.15pp |  |
| `6a0c596c1484eae2e813` (399) | 3y | Greedy+ε-Explore (seed=0, single run) | 9.1% | 8.9% | -0.15pp |  |
| `6a0c596c1484eae2e813` (399) | 3y | MAB-UCB Relay (seed=0, single run) | 14.8% | 17.8% | +3.00pp | improved |
| `6a0c596c1484eae2e813` (399) | 3y | Weighted Stochastic (seed=0, single run) | 12.5% | 15.7% | +3.16pp | improved |
| `6a0c596c1484eae2e813` (399) | 3y | Welshman+Thompson (seed=0, single run) | 14.4% | 15.7% | +1.34pp |  |
| `fff19947841c84c56740` (405) | 1d | Bipartite Matching | 100.0% | 100.0% | +0.00pp |  |
| `fff19947841c84c56740` (405) | 1d | Direct Mapping (cap@20) | 81.7% | 85.8% | +4.11pp | improved |
| `fff19947841c84c56740` (405) | 1d | Filter Decomposition (cap@20) | 78.3% | 82.0% | +3.70pp | improved |
| `fff19947841c84c56740` (405) | 1d | Greedy Coverage Sort | 48.6% | 51.0% | +2.34pp | improved |
| `fff19947841c84c56740` (405) | 1d | Greedy Set-Cover | 94.5% | 98.3% | +3.85pp | improved |
| `fff19947841c84c56740` (405) | 1d | Greedy+ε-Explore (seed=0, single run) | 94.5% | 95.3% | +0.87pp |  |
| `fff19947841c84c56740` (405) | 1d | Hybrid Greedy+Explore (seed=0, single run) | 96.8% | 97.9% | +1.08pp |  |
| `fff19947841c84c56740` (405) | 1d | ILP Optimal | 89.1% | 100.0% | +10.87pp | improved |
| `fff19947841c84c56740` (405) | 1d | MAB-UCB Relay (seed=0, single run) | 83.6% | 85.8% | +2.19pp | improved |
| `fff19947841c84c56740` (405) | 1d | Popular+Random (cap@20) | 83.2% | 84.7% | +1.56pp |  |
| `fff19947841c84c56740` (405) | 1d | Primal Aggregator | 44.6% | 45.0% | +0.45pp |  |
| `fff19947841c84c56740` (405) | 1d | Priority-Based (NDK) | 85.3% | 86.2% | +0.91pp |  |
| `fff19947841c84c56740` (405) | 1d | Spectral Clustering (seed=0, single run) | 89.1% | 100.0% | +10.87pp | improved |
| `fff19947841c84c56740` (405) | 1d | Stochastic Greedy (seed=0, single run) | 74.2% | 48.6% | -25.58pp | **REGRESSED** |
| `fff19947841c84c56740` (405) | 1d | Streaming Coverage (seed=0, single run) | 100.0% | 100.0% | +0.00pp |  |
| `fff19947841c84c56740` (405) | 1d | Weighted Stochastic (seed=0, single run) | 81.4% | 84.1% | +2.63pp | improved |
| `fff19947841c84c56740` (405) | 1d | Welshman+Thompson (seed=0, single run) | 81.4% | 84.1% | +2.63pp | improved |
| `e1ff3bfdd4e40315959b` (416) | 1d | Bipartite Matching | 99.8% | 99.8% | +0.00pp |  |
| `e1ff3bfdd4e40315959b` (416) | 1d | Direct Mapping (cap@20) | 95.2% | 96.6% | +1.38pp |  |
| `e1ff3bfdd4e40315959b` (416) | 1d | Filter Decomposition (cap@20) | 84.2% | 84.9% | +0.78pp |  |
| `e1ff3bfdd4e40315959b` (416) | 1d | Greedy Coverage Sort | 81.4% | 81.1% | -0.32pp |  |
| `e1ff3bfdd4e40315959b` (416) | 1d | Greedy Set-Cover | 99.8% | 99.8% | +0.00pp |  |
| `e1ff3bfdd4e40315959b` (416) | 1d | Greedy+ε-Explore (seed=0, single run) | 99.8% | 99.8% | +0.00pp |  |
| `e1ff3bfdd4e40315959b` (416) | 1d | Hybrid Greedy+Explore (seed=0, single run) | 97.7% | 97.8% | +0.02pp |  |
| `e1ff3bfdd4e40315959b` (416) | 1d | ILP Optimal | 99.8% | 99.8% | +0.00pp |  |
| `e1ff3bfdd4e40315959b` (416) | 1d | MAB-UCB Relay (seed=0, single run) | 96.6% | 96.6% | +0.02pp |  |
| `e1ff3bfdd4e40315959b` (416) | 1d | Popular+Random (cap@20) | 94.8% | 94.6% | -0.19pp |  |
| `e1ff3bfdd4e40315959b` (416) | 1d | Primal Aggregator | 34.2% | 33.9% | -0.23pp |  |
| `e1ff3bfdd4e40315959b` (416) | 1d | Priority-Based (NDK) | 96.6% | 96.6% | +0.02pp |  |
| `e1ff3bfdd4e40315959b` (416) | 1d | Spectral Clustering (seed=0, single run) | 100.0% | 99.8% | -0.22pp |  |
| `e1ff3bfdd4e40315959b` (416) | 1d | Stochastic Greedy (seed=0, single run) | 68.8% | 67.6% | -1.14pp |  |
| `e1ff3bfdd4e40315959b` (416) | 1d | Streaming Coverage (seed=0, single run) | 99.1% | 100.0% | +0.90pp |  |
| `e1ff3bfdd4e40315959b` (416) | 1d | Weighted Stochastic (seed=0, single run) | 95.2% | 95.5% | +0.26pp |  |
| `e1ff3bfdd4e40315959b` (416) | 1d | Welshman+Thompson (seed=0, single run) | 95.2% | 95.5% | +0.26pp |  |
| `97c70a44366a6535c145` (442) | 7d | Bipartite Matching | 90.9% | 93.6% | +2.67pp | improved |
| `97c70a44366a6535c145` (442) | 7d | Direct Mapping (cap@20) | 85.6% | 88.3% | +2.71pp | improved |
| `97c70a44366a6535c145` (442) | 7d | Filter Decomposition (cap@20) | 75.3% | 78.5% | +3.16pp | improved |
| `97c70a44366a6535c145` (442) | 7d | Greedy Coverage Sort | 59.2% | 61.1% | +1.93pp |  |
| `97c70a44366a6535c145` (442) | 7d | Greedy Set-Cover | 87.6% | 86.5% | -1.15pp |  |
| `97c70a44366a6535c145` (442) | 7d | Hybrid Greedy+Explore (seed=0, single run) | 73.0% | 79.3% | +6.24pp | improved |
| `97c70a44366a6535c145` (442) | 7d | ILP Optimal | 95.1% | 95.8% | +0.66pp |  |
| `97c70a44366a6535c145` (442) | 7d | MAB-UCB Relay (seed=0, single run) | 87.2% | 88.8% | +1.57pp |  |
| `97c70a44366a6535c145` (442) | 7d | NIP-66 Weighted Greedy | 87.6% | 86.4% | -1.21pp |  |
| `97c70a44366a6535c145` (442) | 7d | Popular+Random (cap@20) | 84.2% | 86.9% | +2.75pp | improved |
| `97c70a44366a6535c145` (442) | 7d | Primal Aggregator | 36.8% | 37.0% | +0.14pp |  |
| `97c70a44366a6535c145` (442) | 7d | Priority-Based (NDK) | 82.6% | 86.1% | +3.50pp | improved |
| `97c70a44366a6535c145` (442) | 7d | Spectral Clustering (seed=0, single run) | 92.5% | 93.4% | +0.85pp |  |
| `97c70a44366a6535c145` (442) | 7d | Stochastic Greedy (seed=0, single run) | 69.5% | 73.0% | +3.58pp | improved |
| `97c70a44366a6535c145` (442) | 7d | Streaming Coverage (seed=0, single run) | 92.8% | 95.2% | +2.38pp | improved |
| `97c70a44366a6535c145` (442) | 7d | Weighted Stochastic (seed=0, single run) | 82.6% | 84.8% | +2.21pp | improved |
| `97c70a44366a6535c145` (442) | 1y | Bipartite Matching | 34.7% | 33.1% | -1.59pp |  |
| `97c70a44366a6535c145` (442) | 1y | Direct Mapping (cap@20) | 32.7% | 44.1% | +11.37pp | improved |
| `97c70a44366a6535c145` (442) | 1y | Filter Decomposition (cap@20) | 23.0% | 26.2% | +3.21pp | improved |
| `97c70a44366a6535c145` (442) | 1y | Greedy Coverage Sort | 26.7% | 29.6% | +2.86pp | improved |
| `97c70a44366a6535c145` (442) | 1y | Greedy Set-Cover | 15.6% | 16.3% | +0.72pp |  |
| `97c70a44366a6535c145` (442) | 1y | Hybrid Greedy+Explore (seed=0, single run) | 12.6% | 16.1% | +3.54pp | improved |
| `97c70a44366a6535c145` (442) | 1y | ILP Optimal | 38.7% | 35.9% | -2.86pp | **REGRESSED** |
| `97c70a44366a6535c145` (442) | 1y | MAB-UCB Relay (seed=0, single run) | 46.6% | 54.0% | +7.36pp | improved |
| `97c70a44366a6535c145` (442) | 1y | NIP-66 Weighted Greedy | 15.6% | 20.1% | +4.47pp | improved |
| `97c70a44366a6535c145` (442) | 1y | Popular+Random (cap@20) | 30.5% | 21.8% | -8.76pp | **REGRESSED** |
| `97c70a44366a6535c145` (442) | 1y | Primal Aggregator | 3.7% | 3.5% | -0.25pp |  |
| `97c70a44366a6535c145` (442) | 1y | Priority-Based (NDK) | 14.0% | 13.9% | -0.10pp |  |
| `97c70a44366a6535c145` (442) | 1y | Spectral Clustering (seed=0, single run) | 39.7% | 36.5% | -3.26pp | **REGRESSED** |
| `97c70a44366a6535c145` (442) | 1y | Stochastic Greedy (seed=0, single run) | 13.6% | 8.2% | -5.41pp | **REGRESSED** |
| `97c70a44366a6535c145` (442) | 1y | Streaming Coverage (seed=0, single run) | 34.8% | 34.9% | +0.09pp |  |
| `97c70a44366a6535c145` (442) | 1y | Weighted Stochastic (seed=0, single run) | 27.5% | 30.7% | +3.17pp | improved |
| `97c70a44366a6535c145` (442) | 3y | Bipartite Matching | 26.1% | 26.8% | +0.69pp |  |
| `97c70a44366a6535c145` (442) | 3y | Direct Mapping (cap@20) | 21.9% | 32.3% | +10.37pp | improved |
| `97c70a44366a6535c145` (442) | 3y | Filter Decomposition (cap@20) | 16.2% | 19.7% | +3.50pp | improved |
| `97c70a44366a6535c145` (442) | 3y | Greedy Coverage Sort | 17.4% | 19.5% | +2.04pp | improved |
| `97c70a44366a6535c145` (442) | 3y | Greedy Set-Cover | 9.5% | 11.3% | +1.83pp |  |
| `97c70a44366a6535c145` (442) | 3y | Hybrid Greedy+Explore (seed=0, single run) | 13.6% | 11.5% | -2.06pp | **REGRESSED** |
| `97c70a44366a6535c145` (442) | 3y | ILP Optimal | 28.9% | 29.0% | +0.02pp |  |
| `97c70a44366a6535c145` (442) | 3y | MAB-UCB Relay (seed=0, single run) | 31.2% | 31.6% | +0.45pp |  |
| `97c70a44366a6535c145` (442) | 3y | NIP-66 Weighted Greedy | 9.5% | 14.6% | +5.05pp | improved |
| `97c70a44366a6535c145` (442) | 3y | Popular+Random (cap@20) | 20.1% | 14.2% | -5.93pp | **REGRESSED** |
| `97c70a44366a6535c145` (442) | 3y | Primal Aggregator | 2.4% | 2.4% | +0.01pp |  |
| `97c70a44366a6535c145` (442) | 3y | Priority-Based (NDK) | 8.5% | 9.2% | +0.66pp |  |
| `97c70a44366a6535c145` (442) | 3y | Spectral Clustering (seed=0, single run) | 26.5% | 26.3% | -0.20pp |  |
| `97c70a44366a6535c145` (442) | 3y | Stochastic Greedy (seed=0, single run) | 13.8% | 5.8% | -8.00pp | **REGRESSED** |
| `97c70a44366a6535c145` (442) | 3y | Streaming Coverage (seed=0, single run) | 23.7% | 28.2% | +4.57pp | improved |
| `97c70a44366a6535c145` (442) | 3y | Weighted Stochastic (seed=0, single run) | 18.6% | 15.5% | -3.03pp | **REGRESSED** |
| `bf2376e17ba4ec269d10` (821) | 1d | Bipartite Matching | 99.3% | 99.3% | +0.07pp |  |
| `bf2376e17ba4ec269d10` (821) | 1d | Direct Mapping (cap@20) | 97.7% | 98.4% | +0.68pp |  |
| `bf2376e17ba4ec269d10` (821) | 1d | Filter Decomposition (cap@20) | 86.3% | 90.7% | +4.36pp | improved |
| `bf2376e17ba4ec269d10` (821) | 1d | Greedy Coverage Sort | 85.0% | 85.4% | +0.42pp |  |
| `bf2376e17ba4ec269d10` (821) | 1d | Greedy Set-Cover | 97.6% | 97.7% | +0.14pp |  |
| `bf2376e17ba4ec269d10` (821) | 1d | Greedy+ε-Explore (seed=0, single run) | 97.6% | 97.6% | +0.07pp |  |
| `bf2376e17ba4ec269d10` (821) | 1d | Hybrid Greedy+Explore (seed=0, single run) | 96.9% | 97.0% | +0.07pp |  |
| `bf2376e17ba4ec269d10` (821) | 1d | ILP Optimal | 99.3% | 99.3% | +0.07pp |  |
| `bf2376e17ba4ec269d10` (821) | 1d | MAB-UCB Relay (seed=0, single run) | 98.3% | 98.4% | +0.07pp |  |
| `bf2376e17ba4ec269d10` (821) | 1d | Popular+Random (cap@20) | 96.5% | 97.1% | +0.61pp |  |
| `bf2376e17ba4ec269d10` (821) | 1d | Primal Aggregator | 54.3% | 54.4% | +0.10pp |  |
| `bf2376e17ba4ec269d10` (821) | 1d | Priority-Based (NDK) | 97.6% | 97.6% | +0.07pp |  |
| `bf2376e17ba4ec269d10` (821) | 1d | Spectral Clustering (seed=0, single run) | 99.3% | 99.3% | +0.07pp |  |
| `bf2376e17ba4ec269d10` (821) | 1d | Stochastic Greedy (seed=0, single run) | 94.2% | 95.2% | +1.02pp |  |
| `bf2376e17ba4ec269d10` (821) | 1d | Streaming Coverage (seed=0, single run) | 99.3% | 98.4% | -0.81pp |  |
| `bf2376e17ba4ec269d10` (821) | 1d | Weighted Stochastic (seed=0, single run) | 96.3% | 93.8% | -2.58pp | **REGRESSED** |
| `bf2376e17ba4ec269d10` (821) | 1d | Welshman+Thompson (seed=0, single run) | 96.3% | 93.8% | -2.58pp | **REGRESSED** |
| `32e1827635450ebb3c5a` (943) | 7d | Bipartite Matching | 93.0% | 92.8% | -0.22pp |  |
| `32e1827635450ebb3c5a` (943) | 7d | Direct Mapping (cap@20) | 90.5% | 92.6% | +2.02pp | improved |
| `32e1827635450ebb3c5a` (943) | 7d | Filter Decomposition (cap@20) | 77.6% | 77.7% | +0.11pp |  |
| `32e1827635450ebb3c5a` (943) | 7d | Greedy Coverage Sort | 64.6% | 71.1% | +6.46pp | improved |
| `32e1827635450ebb3c5a` (943) | 7d | Greedy Set-Cover | 85.6% | 83.9% | -1.67pp |  |
| `32e1827635450ebb3c5a` (943) | 7d | Hybrid Greedy+Explore (seed=0, single run) | 75.9% | 77.4% | +1.54pp |  |
| `32e1827635450ebb3c5a` (943) | 7d | ILP Optimal | 93.9% | 93.3% | -0.66pp |  |
| `32e1827635450ebb3c5a` (943) | 7d | MAB-UCB Relay (seed=0, single run) | 94.4% | 94.5% | +0.10pp |  |
| `32e1827635450ebb3c5a` (943) | 7d | NIP-66 Weighted Greedy | 85.6% | 83.9% | -1.74pp |  |
| `32e1827635450ebb3c5a` (943) | 7d | Popular+Random (cap@20) | 86.5% | 87.8% | +1.33pp |  |
| `32e1827635450ebb3c5a` (943) | 7d | Primal Aggregator | 26.8% | 27.0% | +0.29pp |  |
| `32e1827635450ebb3c5a` (943) | 7d | Priority-Based (NDK) | 86.5% | 84.1% | -2.38pp | **REGRESSED** |
| `32e1827635450ebb3c5a` (943) | 7d | Spectral Clustering (seed=0, single run) | 94.4% | 94.9% | +0.58pp |  |
| `32e1827635450ebb3c5a` (943) | 7d | Stochastic Greedy (seed=0, single run) | 67.2% | 74.4% | +7.22pp | improved |
| `32e1827635450ebb3c5a` (943) | 7d | Streaming Coverage (seed=0, single run) | 93.5% | 90.6% | -2.96pp | **REGRESSED** |
| `32e1827635450ebb3c5a` (943) | 7d | Weighted Stochastic (seed=0, single run) | 87.1% | 89.0% | +1.89pp |  |
| `32e1827635450ebb3c5a` (943) | 1y | Bipartite Matching | 38.0% | 39.9% | +1.96pp |  |
| `32e1827635450ebb3c5a` (943) | 1y | Direct Mapping (cap@20) | 27.5% | 38.7% | +11.27pp | improved |
| `32e1827635450ebb3c5a` (943) | 1y | Filter Decomposition (cap@20) | 21.3% | 23.7% | +2.43pp | improved |
| `32e1827635450ebb3c5a` (943) | 1y | Greedy Coverage Sort | 15.4% | 23.1% | +7.76pp | improved |
| `32e1827635450ebb3c5a` (943) | 1y | Greedy Set-Cover | 18.1% | 18.9% | +0.82pp |  |
| `32e1827635450ebb3c5a` (943) | 1y | Hybrid Greedy+Explore (seed=0, single run) | 10.9% | 17.9% | +7.01pp | improved |
| `32e1827635450ebb3c5a` (943) | 1y | ILP Optimal | 26.9% | 28.0% | +1.15pp |  |
| `32e1827635450ebb3c5a` (943) | 1y | MAB-UCB Relay (seed=0, single run) | 36.8% | 38.6% | +1.78pp |  |
| `32e1827635450ebb3c5a` (943) | 1y | NIP-66 Weighted Greedy | 17.1% | 18.9% | +1.85pp |  |
| `32e1827635450ebb3c5a` (943) | 1y | Popular+Random (cap@20) | 19.4% | 22.1% | +2.71pp | improved |
| `32e1827635450ebb3c5a` (943) | 1y | Primal Aggregator | 2.9% | 3.1% | +0.25pp |  |
| `32e1827635450ebb3c5a` (943) | 1y | Priority-Based (NDK) | 17.3% | 19.3% | +1.98pp |  |
| `32e1827635450ebb3c5a` (943) | 1y | Spectral Clustering (seed=0, single run) | 30.8% | 32.5% | +1.69pp |  |
| `32e1827635450ebb3c5a` (943) | 1y | Stochastic Greedy (seed=0, single run) | 12.1% | 13.2% | +1.18pp |  |
| `32e1827635450ebb3c5a` (943) | 1y | Streaming Coverage (seed=0, single run) | 31.1% | 28.3% | -2.81pp | **REGRESSED** |
| `32e1827635450ebb3c5a` (943) | 1y | Weighted Stochastic (seed=0, single run) | 22.8% | 25.2% | +2.34pp | improved |
| `32e1827635450ebb3c5a` (943) | 3y | Bipartite Matching | 27.2% | 26.7% | -0.52pp |  |
| `32e1827635450ebb3c5a` (943) | 3y | Direct Mapping (cap@20) | 20.4% | 27.3% | +6.86pp | improved |
| `32e1827635450ebb3c5a` (943) | 3y | Filter Decomposition (cap@20) | 15.9% | 16.3% | +0.43pp |  |
| `32e1827635450ebb3c5a` (943) | 3y | Greedy Coverage Sort | 10.6% | 15.4% | +4.81pp | improved |
| `32e1827635450ebb3c5a` (943) | 3y | Greedy Set-Cover | 12.6% | 12.6% | +0.04pp |  |
| `32e1827635450ebb3c5a` (943) | 3y | Hybrid Greedy+Explore (seed=0, single run) | 7.8% | 12.7% | +4.89pp | improved |
| `32e1827635450ebb3c5a` (943) | 3y | ILP Optimal | 19.2% | 18.6% | -0.66pp |  |
| `32e1827635450ebb3c5a` (943) | 3y | MAB-UCB Relay (seed=0, single run) | 27.6% | 26.8% | -0.80pp |  |
| `32e1827635450ebb3c5a` (943) | 3y | NIP-66 Weighted Greedy | 12.3% | 12.6% | +0.33pp |  |
| `32e1827635450ebb3c5a` (943) | 3y | Popular+Random (cap@20) | 14.8% | 15.2% | +0.36pp |  |
| `32e1827635450ebb3c5a` (943) | 3y | Primal Aggregator | 2.0% | 2.1% | +0.01pp |  |
| `32e1827635450ebb3c5a` (943) | 3y | Priority-Based (NDK) | 12.4% | 12.8% | +0.40pp |  |
| `32e1827635450ebb3c5a` (943) | 3y | Spectral Clustering (seed=0, single run) | 22.7% | 22.5% | -0.24pp |  |
| `32e1827635450ebb3c5a` (943) | 3y | Stochastic Greedy (seed=0, single run) | 12.3% | 9.0% | -3.34pp | **REGRESSED** |
| `32e1827635450ebb3c5a` (943) | 3y | Streaming Coverage (seed=0, single run) | 23.1% | 18.8% | -4.30pp | **REGRESSED** |
| `32e1827635450ebb3c5a` (943) | 3y | Weighted Stochastic (seed=0, single run) | 16.9% | 16.9% | -0.02pp |  |
| `dd3a97900e337fd3d0f1` (1077) | 7d | Greedy Set-Cover | 77.2% | 76.6% | -0.52pp |  |
| `dd3a97900e337fd3d0f1` (1077) | 7d | Greedy+ε-Explore (seed=0, single run) | 77.2% | 76.6% | -0.53pp |  |
| `dd3a97900e337fd3d0f1` (1077) | 7d | MAB-UCB Relay (seed=0, single run) | 89.6% | 92.5% | +2.93pp | improved |
| `dd3a97900e337fd3d0f1` (1077) | 7d | Weighted Stochastic (seed=0, single run) | 79.7% | 80.7% | +0.96pp |  |
| `dd3a97900e337fd3d0f1` (1077) | 7d | Welshman+Thompson (seed=0, single run) | 82.8% | 80.7% | -2.09pp | **REGRESSED** |
| `dd3a97900e337fd3d0f1` (1077) | 1y | Greedy Set-Cover | 18.5% | 21.4% | +2.92pp | improved |
| `dd3a97900e337fd3d0f1` (1077) | 1y | Greedy+ε-Explore (seed=0, single run) | 18.5% | 21.4% | +2.88pp | improved |
| `dd3a97900e337fd3d0f1` (1077) | 1y | MAB-UCB Relay (seed=0, single run) | 31.9% | 41.7% | +9.84pp | improved |
| `dd3a97900e337fd3d0f1` (1077) | 1y | Weighted Stochastic (seed=0, single run) | 18.4% | 28.7% | +10.33pp | improved |
| `dd3a97900e337fd3d0f1` (1077) | 1y | Welshman+Thompson (seed=0, single run) | 23.7% | 28.7% | +4.99pp | improved |
| `dd3a97900e337fd3d0f1` (1077) | 3y | Greedy Set-Cover | 12.1% | 15.4% | +3.20pp | improved |
| `dd3a97900e337fd3d0f1` (1077) | 3y | Greedy+ε-Explore (seed=0, single run) | 12.1% | 15.3% | +3.17pp | improved |
| `dd3a97900e337fd3d0f1` (1077) | 3y | MAB-UCB Relay (seed=0, single run) | 23.8% | 31.5% | +7.74pp | improved |
| `dd3a97900e337fd3d0f1` (1077) | 3y | Weighted Stochastic (seed=0, single run) | 11.6% | 20.4% | +8.76pp | improved |
| `dd3a97900e337fd3d0f1` (1077) | 3y | Welshman+Thompson (seed=0, single run) | 16.7% | 20.4% | +3.67pp | improved |
| `04c915daefee38317fa7` (1774) | 7d | Bipartite Matching | 86.6% | 86.6% | -0.04pp |  |
| `04c915daefee38317fa7` (1774) | 7d | Direct Mapping (cap@20) | 86.5% | 88.1% | +1.52pp |  |
| `04c915daefee38317fa7` (1774) | 7d | Filter Decomposition (cap@20) | 70.3% | 73.6% | +3.39pp | improved |
| `04c915daefee38317fa7` (1774) | 7d | Greedy Coverage Sort | 56.5% | 58.7% | +2.20pp | improved |
| `04c915daefee38317fa7` (1774) | 7d | Greedy Set-Cover | 73.2% | 73.7% | +0.53pp |  |
| `04c915daefee38317fa7` (1774) | 7d | Hybrid Greedy+Explore (seed=0, single run) | 62.5% | 63.0% | +0.47pp |  |
| `04c915daefee38317fa7` (1774) | 7d | ILP Optimal | 87.5% | 89.0% | +1.47pp |  |
| `04c915daefee38317fa7` (1774) | 7d | MAB-UCB Relay (seed=0, single run) | 85.3% | 88.8% | +3.56pp | improved |
| `04c915daefee38317fa7` (1774) | 7d | NIP-66 Weighted Greedy | 73.2% | 73.7% | +0.49pp |  |
| `04c915daefee38317fa7` (1774) | 7d | Popular+Random (cap@20) | 76.2% | 78.8% | +2.56pp | improved |
| `04c915daefee38317fa7` (1774) | 7d | Primal Aggregator | 32.5% | 32.7% | +0.26pp |  |
| `04c915daefee38317fa7` (1774) | 7d | Priority-Based (NDK) | 73.2% | 73.5% | +0.34pp |  |
| `04c915daefee38317fa7` (1774) | 7d | Spectral Clustering (seed=0, single run) | 86.2% | 87.7% | +1.41pp |  |
| `04c915daefee38317fa7` (1774) | 7d | Stochastic Greedy (seed=0, single run) | 32.7% | 64.9% | +32.20pp | improved |
| `04c915daefee38317fa7` (1774) | 7d | Streaming Coverage (seed=0, single run) | 87.4% | 88.6% | +1.17pp |  |
| `04c915daefee38317fa7` (1774) | 7d | Weighted Stochastic (seed=0, single run) | 75.7% | 78.0% | +2.29pp | improved |
| `04c915daefee38317fa7` (1774) | 1y | Bipartite Matching | 22.3% | 20.7% | -1.66pp |  |
| `04c915daefee38317fa7` (1774) | 1y | Direct Mapping (cap@20) | 35.9% | 34.2% | -1.70pp |  |
| `04c915daefee38317fa7` (1774) | 1y | Filter Decomposition (cap@20) | 28.8% | 28.2% | -0.55pp |  |
| `04c915daefee38317fa7` (1774) | 1y | Greedy Coverage Sort | 18.7% | 21.4% | +2.70pp | improved |
| `04c915daefee38317fa7` (1774) | 1y | Greedy Set-Cover | 15.4% | 14.4% | -1.03pp |  |
| `04c915daefee38317fa7` (1774) | 1y | Hybrid Greedy+Explore (seed=0, single run) | 10.4% | 9.8% | -0.64pp |  |
| `04c915daefee38317fa7` (1774) | 1y | ILP Optimal | 22.1% | 30.8% | +8.71pp | improved |
| `04c915daefee38317fa7` (1774) | 1y | MAB-UCB Relay (seed=0, single run) | 24.3% | 34.4% | +10.12pp | improved |
| `04c915daefee38317fa7` (1774) | 1y | NIP-66 Weighted Greedy | 15.4% | 14.4% | -1.03pp |  |
| `04c915daefee38317fa7` (1774) | 1y | Popular+Random (cap@20) | 21.2% | 21.6% | +0.46pp |  |
| `04c915daefee38317fa7` (1774) | 1y | Primal Aggregator | 4.7% | 4.4% | -0.29pp |  |
| `04c915daefee38317fa7` (1774) | 1y | Priority-Based (NDK) | 15.5% | 14.4% | -1.03pp |  |
| `04c915daefee38317fa7` (1774) | 1y | Spectral Clustering (seed=0, single run) | 22.1% | 20.7% | -1.46pp |  |
| `04c915daefee38317fa7` (1774) | 1y | Stochastic Greedy (seed=0, single run) | 6.9% | 11.3% | +4.39pp | improved |
| `04c915daefee38317fa7` (1774) | 1y | Streaming Coverage (seed=0, single run) | 22.2% | 28.1% | +5.93pp | improved |
| `04c915daefee38317fa7` (1774) | 1y | Weighted Stochastic (seed=0, single run) | 21.6% | 24.1% | +2.47pp | improved |
| `04c915daefee38317fa7` (1774) | 3y | Bipartite Matching | 16.2% | 16.1% | -0.09pp |  |
| `04c915daefee38317fa7` (1774) | 3y | Direct Mapping (cap@20) | 27.5% | 28.7% | +1.21pp |  |
| `04c915daefee38317fa7` (1774) | 3y | Filter Decomposition (cap@20) | 23.0% | 24.4% | +1.45pp |  |
| `04c915daefee38317fa7` (1774) | 3y | Greedy Coverage Sort | 13.2% | 18.7% | +5.46pp | improved |
| `04c915daefee38317fa7` (1774) | 3y | Greedy Set-Cover | 10.9% | 11.0% | +0.06pp |  |
| `04c915daefee38317fa7` (1774) | 3y | Hybrid Greedy+Explore (seed=0, single run) | 7.5% | 7.5% | +0.06pp |  |
| `04c915daefee38317fa7` (1774) | 3y | ILP Optimal | 16.0% | 29.3% | +13.24pp | improved |
| `04c915daefee38317fa7` (1774) | 3y | MAB-UCB Relay (seed=0, single run) | 19.3% | 28.5% | +9.24pp | improved |
| `04c915daefee38317fa7` (1774) | 3y | NIP-66 Weighted Greedy | 10.9% | 11.0% | +0.06pp |  |
| `04c915daefee38317fa7` (1774) | 3y | Popular+Random (cap@20) | 16.6% | 17.2% | +0.58pp |  |
| `04c915daefee38317fa7` (1774) | 3y | Primal Aggregator | 3.4% | 3.4% | +0.03pp |  |
| `04c915daefee38317fa7` (1774) | 3y | Priority-Based (NDK) | 11.1% | 11.3% | +0.24pp |  |
| `04c915daefee38317fa7` (1774) | 3y | Spectral Clustering (seed=0, single run) | 16.0% | 16.1% | +0.05pp |  |
| `04c915daefee38317fa7` (1774) | 3y | Stochastic Greedy (seed=0, single run) | 6.3% | 8.8% | +2.50pp | improved |
| `04c915daefee38317fa7` (1774) | 3y | Streaming Coverage (seed=0, single run) | 16.0% | 25.2% | +9.20pp | improved |
| `04c915daefee38317fa7` (1774) | 3y | Weighted Stochastic (seed=0, single run) | 15.7% | 18.8% | +3.08pp | improved |
| `2c65940725bbf10bfbbf` (2784) | 7d | Greedy Set-Cover | 81.3% | 81.4% | +0.13pp |  |
| `2c65940725bbf10bfbbf` (2784) | 7d | Greedy+ε-Explore (seed=0, single run) | 81.2% | 81.4% | +0.20pp |  |
| `2c65940725bbf10bfbbf` (2784) | 7d | MAB-UCB Relay (seed=0, single run) | 85.3% | 90.1% | +4.87pp | improved |
| `2c65940725bbf10bfbbf` (2784) | 7d | Weighted Stochastic (seed=0, single run) | 78.1% | 81.8% | +3.68pp | improved |
| `2c65940725bbf10bfbbf` (2784) | 7d | Welshman+Thompson (seed=0, single run) | 83.9% | 81.8% | -2.13pp | **REGRESSED** |
| `2c65940725bbf10bfbbf` (2784) | 1y | Greedy Set-Cover | 19.3% | 20.7% | +1.31pp |  |
| `2c65940725bbf10bfbbf` (2784) | 1y | Greedy+ε-Explore (seed=0, single run) | 19.3% | 20.7% | +1.32pp |  |
| `2c65940725bbf10bfbbf` (2784) | 1y | MAB-UCB Relay (seed=0, single run) | 26.3% | 49.0% | +22.72pp | improved |
| `2c65940725bbf10bfbbf` (2784) | 1y | Weighted Stochastic (seed=0, single run) | 23.5% | 33.1% | +9.67pp | improved |
| `2c65940725bbf10bfbbf` (2784) | 1y | Welshman+Thompson (seed=0, single run) | 38.9% | 33.1% | -5.73pp | **REGRESSED** |
| `2c65940725bbf10bfbbf` (2784) | 3y | Greedy Set-Cover | 15.6% | 16.2% | +0.67pp |  |
| `2c65940725bbf10bfbbf` (2784) | 3y | Greedy+ε-Explore (seed=0, single run) | 15.5% | 16.2% | +0.68pp |  |
| `2c65940725bbf10bfbbf` (2784) | 3y | MAB-UCB Relay (seed=0, single run) | 22.7% | 41.6% | +18.97pp | improved |
| `2c65940725bbf10bfbbf` (2784) | 3y | Weighted Stochastic (seed=0, single run) | 19.6% | 27.1% | +7.57pp | improved |
| `2c65940725bbf10bfbbf` (2784) | 3y | Welshman+Thompson (seed=0, single run) | 32.6% | 27.1% | -5.43pp | **REGRESSED** |

## Section 3: Aggregate Summary

**Pairs analyzed:** 33

### Infrastructure Metrics

| Metric | Mean | Median | Min | Max |
|---|---|---|---|---|
| Dead relay % (pruned by NIP-66) | 53.8% | 55.3% | 29.7% | 67.4% |
| Success rate improvement (pp) | 41.7pp | 44.1pp | 23.3pp | 53.6pp |
| Wall-clock reduction | 45.0% | 48.2% | 18.2% | 64.0% |

### Event Recall Delta by Algorithm (percentage points)

| Algorithm | Mean delta | Median delta | Min | Max | # regressed (>2pp) | # improved (>2pp) |
|---|---|---|---|---|---|---|
| Bipartite Matching | +0.13pp | +0.00pp | -1.66pp | +2.67pp | 0 | 2 |
| Direct Mapping (cap@20) | +3.91pp | +2.02pp | -1.70pp | +15.25pp | 0 | 11 |
| Filter Decomposition (cap@20) | +2.84pp | +2.46pp | -0.55pp | +12.65pp | 0 | 13 |
| Greedy Coverage Sort | +3.22pp | +2.34pp | -0.55pp | +9.98pp | 0 | 13 |
| Greedy Set-Cover | +0.98pp | +0.13pp | -1.67pp | +13.62pp | 0 | 6 |
| Greedy+ε-Explore (seed=0, single run) | +0.54pp | +0.04pp | -1.07pp | +3.17pp | 0 | 3 |
| Hybrid Greedy+Explore (seed=0, single run) | +1.43pp | +0.07pp | -2.06pp | +7.01pp | 1 | 6 |
| ILP Optimal | +1.69pp | +0.04pp | -2.86pp | +13.24pp | 1 | 4 |
| MAB-UCB Relay (seed=0, single run) | +3.90pp | +2.19pp | -0.89pp | +22.72pp | 0 | 17 |
| NIP-66 Weighted Greedy | +0.97pp | +0.33pp | -1.74pp | +5.05pp | 0 | 3 |
| Popular+Random (cap@20) | -0.04pp | +0.49pp | -8.76pp | +2.75pp | 3 | 3 |
| Primal Aggregator | +0.07pp | +0.10pp | -1.08pp | +0.72pp | 0 | 0 |
| Priority-Based (NDK) | +0.30pp | +0.07pp | -2.38pp | +3.50pp | 1 | 1 |
| Spectral Clustering (seed=0, single run) | +0.61pp | +0.00pp | -3.26pp | +10.87pp | 1 | 2 |
| Stochastic Greedy (seed=0, single run) | +4.17pp | +1.18pp | -25.58pp | +43.57pp | 7 | 10 |
| Streaming Coverage (seed=0, single run) | +1.36pp | +0.09pp | -14.33pp | +22.30pp | 5 | 6 |
| Weighted Stochastic (seed=0, single run) | +4.59pp | +2.63pp | -3.03pp | +26.26pp | 2 | 21 |
| Welshman+Thompson (seed=0, single run) | +0.61pp | +0.63pp | -5.73pp | +7.63pp | 5 | 6 |

**Total algorithm comparisons:** 406
- Regressions (>2pp drop): **26**
- Improvements (>2pp gain): **127**
- Neutral (within +/-2pp): **253**

## Section 4: Key Findings

1. **NIP-66 liveness filtering prunes 53.8% of relays on average** (range: 29.7%--67.4%), eliminating dead/unresponsive relays before the benchmark even begins querying.

2. **Wall-clock collection time drops by 45% on average** (median 48%). The biggest winner was `6a0c596c1484eae2e813` (399 follows) at 64% reduction (99.8s -> 35.9s).

3. **Relay success rate improves by +41.7 percentage points on average**, confirming that NIP-66 removes relays that would have failed anyway, concentrating queries on healthy infrastructure.

4. **Event recall is virtually unchanged** (mean delta: +1.88pp across 406 algorithm comparisons). Only 26 out of 406 comparisons show a regression >2pp, indicating NIP-66 filtering does not sacrifice recall quality.

5. **Larger profiles benefit more from NIP-66 filtering.** Profiles with >500 follows see a 55% wall-clock reduction vs 39% for profiles with <=500 follows, because larger follow graphs encounter more diverse (and more dead) relays.

