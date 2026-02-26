Loaded 71 phase2 records (after filtering cached runs)
After dedup: 66 unique (pubkey, window, nip66) combos
Complete pairs (both nip66 and no-nip66): 33

========================================================================================================
          Pubkey    Fol  Win   R_no   R_66   Dead%   SR_no   SR_66   SR+pp      WC_no      WC_66    WC-%
========================================================================================================
76c71aae3a491f1d    108   1d    175    123   29.7%   62.9%   86.2%  +23.3     30578ms     25023ms  +18.2%
00f471f6312ce408    114   1d    259    163   37.1%   58.3%   90.2%  +31.9     33140ms     25819ms  +22.1%
c1fc7771f5fa418f    137   1d    188     97   48.4%   47.9%   86.6%  +38.7     32410ms     16187ms  +50.1%
3bf0c63fcb934634    194   1d    234    141   39.7%   56.4%   90.1%  +33.7     30196ms     19468ms  +35.5%
3bf0c63fcb934634    194   1w    233    133   42.9%   55.4%   91.7%  +36.4     27259ms     21646ms  +20.6%
3bf0c63fcb934634    194   1y    233    135   42.1%   53.2%   88.9%  +35.7     43910ms     29352ms  +33.2%
3bf0c63fcb934634    194   1y    233    133   42.9%   54.1%   91.0%  +36.9     33836ms     22084ms  +34.7%
3bf0c63fcb934634    194   3y    233    135   42.1%   53.2%   88.1%  +34.9     44678ms     33512ms  +25.0%
3bf0c63fcb934634    194   3y    233    140   39.9%   55.4%   87.1%  +31.8     47586ms     38364ms  +19.4%
eab0e756d32b80bc    227   1d    254    118   53.5%   42.5%   84.7%  +42.2     38300ms     27387ms  +28.5%
ee11a5dff40c19a5    233   1d    333    152   54.4%   42.9%   84.9%  +41.9     35481ms     20254ms  +42.9%
3c827db6c45f7e62    283   1d    300    141   53.0%   41.3%   82.3%  +40.9     41806ms     26592ms  +36.4%
6a0c596c1484eae2    399   1w    559    182   67.4%   26.1%   79.7%  +53.6     99765ms     35948ms  +64.0%
6a0c596c1484eae2    399   1y    559    182   67.4%   26.7%   78.0%  +51.4     98633ms     41333ms  +58.1%
6a0c596c1484eae2    399   3y    559    182   67.4%   26.8%   79.1%  +52.3     94442ms     36324ms  +61.5%
fff19947841c84c5    405   1d    396    177   55.3%   40.9%   88.7%  +47.8     43482ms     27151ms  +37.6%
e1ff3bfdd4e40315    416   1d    334    152   54.5%   40.7%   84.9%  +44.1     43439ms     23847ms  +45.1%
97c70a44366a6535    442   1w    487    252   48.3%   45.4%   82.9%  +37.6    102347ms     53218ms  +48.0%
97c70a44366a6535    442   1y    487    252   48.3%   45.6%   83.3%  +37.7    101912ms     69240ms  +32.1%
97c70a44366a6535    442   3y    487    252   48.3%   45.6%   82.1%  +36.6    110278ms     62045ms  +43.7%
bf2376e17ba4ec26    821   1d    609    241   60.4%   34.5%   83.0%  +48.5     69145ms     32615ms  +52.8%
32e1827635450ebb    943   1w    729    296   59.4%   35.4%   83.1%  +47.7    139085ms     55377ms  +60.2%
32e1827635450ebb    943   1y    729    296   59.4%   35.1%   82.1%  +47.0    152938ms     67338ms  +56.0%
32e1827635450ebb    943   3y    729    296   59.4%   35.3%   83.4%  +48.2    153148ms     79369ms  +48.2%
dd3a97900e337fd3   1077   1w    862    354   58.9%   35.2%   79.4%  +44.2    183245ms     79831ms  +56.4%
dd3a97900e337fd3   1077   1y    862    354   58.9%   34.7%   78.5%  +43.8    188494ms     89143ms  +52.7%
dd3a97900e337fd3   1077   3y    862    354   58.9%   34.6%   79.7%  +45.1    189046ms     89689ms  +52.6%
04c915daefee3831   1774   1w   1201    437   63.6%   30.2%   76.2%  +46.0    262347ms    108953ms  +58.5%
04c915daefee3831   1774   1y   1201    437   63.6%   29.9%   75.7%  +45.9    269050ms    117857ms  +56.2%
04c915daefee3831   1774   3y   1201    437   63.6%   30.6%   76.0%  +45.3    265924ms    130216ms  +51.0%
2c65940725bbf10b   2784   1w   1642    585   64.4%   29.5%   74.0%  +44.5    334651ms    138984ms  +58.5%
2c65940725bbf10b   2784   1y   1642    585   64.4%   29.4%   74.4%  +44.9    352248ms    156891ms  +55.5%
2c65940725bbf10b   2784   3y   1642    585   64.4%   29.6%   73.8%  +44.2    350976ms    162221ms  +53.8%
========================================================================================================

CORRELATION ANALYSIS (Pearson r)
------------------------------------------------------------
  Follow count vs Dead relay %:        r = +0.6279  (p ~ 0.0000, n=33)
  Follow count vs Wall-clock reduction: r = +0.5717  (p ~ 0.0001, n=33)
  Follow count vs Success rate improve: r = +0.3984  (p ~ 0.0156, n=33)

CORRELATION BY WINDOW:
------------------------------------------------------------
   1d (n=10): dead% r=+0.711  wc% r=+0.630  sr pp r=+0.732
   1w (n= 7): dead% r=+0.559  wc% r=+0.449  sr pp r=+0.189
   1y (n= 8): dead% r=+0.629  wc% r=+0.605  sr pp r=+0.402
   3y (n= 8): dead% r=+0.629  wc% r=+0.517  sr pp r=+0.384

SUMMARY STATISTICS:
------------------------------------------------------------
  Mean dead relay %:              54.0%
  Mean wall-clock reduction %:   +44.5%
  Mean success rate improvement: +42.0 pp

  LOW-follow  accounts (    108-405, n=16):
    Dead relay %:     49.0%
    WC reduction:   +36.7%
    SR improvement: +39.6 pp

  HIGH-follow accounts (   416-2784, n=17):
    Dead relay %:     58.7%
    WC reduction:   +51.8%
    SR improvement: +44.2 pp

============================================================
DOES NIP-66 BENEFIT SCALE WITH FOLLOW COUNT?
============================================================

  Dead relay % vs follows      : r=+0.628 (strong positive) -> more benefit at higher follow counts
  Wall-clock reduction vs follows: r=+0.572 (moderate positive) -> more benefit at higher follow counts
  Success rate gain vs follows  : r=+0.398 (moderate positive) -> more benefit at higher follow counts

YES - NIP-66 benefit clearly scales with follow count. Users who follow
  more accounts encounter proportionally more dead/offline relays, and NIP-66
  filtering removes them, yielding greater relay count reduction, faster
  wall-clock times, and higher success rates for high-follow-count accounts.

