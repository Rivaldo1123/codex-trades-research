# Independent audit of development screen v1

Generated from audit tooling commit `5cdf73fd3339f048e9c72369714d366d64451241`. Reviewed search commit `0512ed7823e33264a27cd34b7376986b57a04fd6` and result commit `5d93aaf097e45edd74853d41245d446322c397ea`.

## Direct conclusion

The simulator was sufficiently accurate for the narrow claim that none of the tested 1HZ100V, 1–10-tick, fixed-stake indicator configurations passed the frozen rules. It was not accurate enough to claim observed historical contract profitability, and the search cannot support a claim about other symbols, products, clock durations, or strategy classes.

No verified correction creates a qualifying strategy. The appropriate decision is to stop expanding the same short-tick technical-indicator search. Completing the 90-day archive remains useful for replication and null calibration, not as an automatic reason to search more variants.

## Baseline preservation and reproducibility

- Original ledger: 12,012 rows, SHA-256 `23da90a773cdffb77c1f71187083985f4cf2916a38eb477875dfbdffe58dccd3`; every configuration/trial ID was unique and every scenario/accounting field was independently recomputed.
- The original mutable whole-manifest identifier was `da4b901cde363a48d92e2d2ecafabb12a20fdae69c07300fcb070da6ea22599c`. The independently verified fixed slice is now identified by content SHA-256 `8e3196f7d9faba44791fea5e0da1db797dd779355b656419e39667c7752a6d69` and relevant-slice manifest SHA-256 `a1e3d1834337c127013a2d24d5952a3cc3516bce96ae2991e154a692ffe78383`.
- Exact slice: 2,591,993 of 2,592,000 seconds, with the original seven-second gap preserved.
- v1 artifacts were not edited or overwritten. This audit is versioned separately as v2.

## Historical collection status during the audit

The authorized 90-day public backfill is FAILED, and its recorded PID is not active. It checkpointed 250,000 rows across 250 pages in this invocation before the public API exhausted bounded retries: Historical request exhausted 8 bounded retries: Deriv API error RateLimit: You have reached the rate limit for ticks_history.
Approximately 4,934,000 older target seconds remain before the requested start. The audit did not restart or duplicate the stopped collector. Resume only after the rate limit clears with `node src/historical-backfill-cli.js --from 1783483200 --to 1791259200`; the immutable chunks and checkpoint remain in place.

## Confirmed defects

1. **High — mutable-manifest provenance.** The checkpoint keyed the entire append-only manifest rather than the fixed evaluated slice, and the original manifest snapshot was not retained. An unrelated older backfill therefore makes v1 non-resumable. The new independent slice auditor hashes exact chronological content and only the relevant chunk descriptor. The present slice has the same row count and gap as v1, but the missing original manifest snapshot prevents a cryptographic proof that its old whole-manifest hash described exactly this chunk list.
2. **Medium — inferential estimand/dependence mismatch.** The v1 t test and bootstrap averaged active-day return ratios equally, while the reported target was profit per unit staked. Its bootstrap resampled individual days independently, so it handled within-day clustering but not adjacent-day dependence. A ratio-of-sums clustered check and circular three-day moving-block sensitivity were run on the predefined top 20. Zero passed either corrected evidence check.
3. **Medium — rejection-label ambiguity.** Only 20 configurations received the original bootstrap and only 100 received neighboring-setting calculations, yet every other row was labelled `failed_or_not_shortlisted`. Non-evaluation is now reported separately from an evaluated failure.
4. **Low — non-finite ledger serialization.** 84 rows with at least one no-trade stress scenario computed an internal negative-infinity sentinel that JSON encoded as null. The pre-serialization rule rejected them correctly, but the persisted field is ambiguous. The independent ledger validator reconstructs the fail-closed value from scenario counts.

These defects affect provenance and strength of inference. They do not change the frozen economic screen: every configuration still has at least one non-positive 0.80 stress window/delay, and targeted replay reproduced the original trade counts exactly.

## Contract and simulator verification

- All 99 recorded Bot Builder observations (85 one-tick and 14 five-tick) matched archive entry at purchase+1 tick and exit at entry+duration; 99 reproduced +0.90/-1 accounting, including 3 strict-comparison ties as losses. Zero have the account, contract, settlement-status, and exact-strategy identity required to count as broker-settlement evidence.
- The separate guarded API journal contains 1 bought/settled Demo chain with a purchase contract ID and +0.90 accounting. It lacks account identity, exact strategy hash, entry spot, and reconstructable entry timing, so it is an observed journal settlement but not eligible strategy evidence or simulator-parity proof.
- The saved unauthenticated `contracts_for` probe on 2026-10-08 reported 1HZ100V CALL/PUT tick contracts spanning 1–10 ticks. This is a point-in-time product observation, not proof of historical availability or prices. Tick and clock durations remain distinct API units.
- Official terms define Digital Options entry as the next tick after server processing. Deriv's worked 5-tick example shows start, entry one second later, and exit five ticks after entry. The manual fixture and shared-engine parity tests reproduce this convention.
- The search used raw ticks, not candles. Indicators include the known decision tick, never a future tick; outcomes require complete signal-to-settlement presence and stay inside one chronological window.
- Indicator warm-up cannot cross a chronological-window boundary or genuine source gap; any label whose decision-to-expiry path crosses either boundary is excluded rather than purged data being reused.
- The audited 1HZ100V instrument is a documented one-second variant. Deriv documents ordinary Volatility Indices at one tick every two seconds; v1 delays and durations are tick counts, so its elapsed-time behavior and conclusions do not transfer silently to those instruments.
- At one decision per 60 seconds and a maximum 3-tick delay plus 10-tick duration, modeled positions cannot overlap on the audited one-second symbol. Vectorized outcomes matched the separate sequential reference engine.
- Gross payout and net profit are distinct: the v1 values +0.90/+0.80/+0.70 are net win profits per $1 stake; a loss or strict tie is -$1.

Unverified by available evidence: account-specific historical quotes, proposal expiry/requotes, processing delays beyond three ticks, rejected/unavailable purchases, cancellations/refunds, server corrections, and whether public history always equals the settlement tick stream. Those limitations prevent interpreting simulated P/L as observed contract profit.

## Statistical findings kept separate

- A — base 0.90 model: 11,931 lost; 81 were non-negative; 11,960 missed the frozen +0.02 threshold.
- B — conservative 0.80 stress: 12,012 missed +0.01 and 12,012 had a non-positive window/delay.
- C — evidence: 0 passed the Bonferroni screen. The original bootstrap was actually evaluated for 20, not 12,012; none had a positive lower bound. The corrected top-20 checks also had zero passes.
- D — operational/sample rules: {"drawdownFailed":11564,"losingStreakFailed":8882,"minimumTotalTradesFailed":606,"minimumWindowTradesFailed":439,"minimumActiveDaysFailed":121}. These are risk/activity rejections, not proofs of negative expectancy.

For the original top-ranked configuration, the corrected 0.80 clustered ratio estimate is -0.078860 and its 99% moving three-day-block lower bound is -0.120883.

Bonferroni controls family-wise error regardless of dependence between configurations if each raw p-value is valid; here the weak point is the 30-cluster Student-t approximation, not the direction of the adjustment. A 99% tail estimate from only 30 days is intrinsically coarse. The neighboring-setting rule was implemented as normalized numeric distance within a hash-subsampled grid, not a predeclared one-coordinate adjacency graph, so it is supporting diagnostics rather than strong independent confirmation.
Net expectancy and profit factor were independently reconstructed from win/loss/tie counts. Maximum drawdown and longest losing streak use chronological delay-1 trades at the base +0.90 payout; a four-trade hand fixture verifies both. The fixed dataset spans 30 UTC days and requires 20 active days, but there is no separate first-trade-to-last-trade elapsed-duration rule. Fixed $1 stakes and minute-spaced decisions cap simulated concurrent exposure at one stake unit.

## What the 12,012 configurations covered

All rows used 1HZ100V Rise/Fall (`CALL`/`PUT`), tick durations, the same exposed 30 days, and three entry delays/payout assumptions. Trade counts below are minimum/median/maximum base-delay trades.

| Family | Hypothesis | Configs | Durations (ticks) | Actual parameter values | Trades min/median/max | Base-negative | Stress-failed | Sample-failure sum* |
|---|---|---:|---|---|---:|---:|---:|---:|
| channel_breakout | A move beyond the prior tick high/low continues. | 2000 | 1,2,3,5,7,10 | lookbackTicks=5,8,10,15,20,30,45,60,90,120,180,240; minimumVolatilityBps=0,0.25,0.5; thresholdBps=0,0.05,0.1,0.25,0.5,1,2,3; volatilityWindow=10,30,60 | 221/4432/20565 | 2000 | 2000 | 428 |
| momentum_reversion | A signed lookback price change reverses. | 2000 | 1,2,3,5,7,10 | lookbackTicks=1,2,3,5,8,13,21,34,55,89; minimumVolatilityBps=0,0.25,0.5; thresholdBps=0,0.05,0.1,0.25,0.5,1,2,3; volatilityWindow=10,30,60 | 3943/41031/43101 | 2000 | 2000 | 0 |
| momentum_trend | A signed lookback price change continues. | 2000 | 1,2,3,5,7,10 | lookbackTicks=1,2,3,5,8,13,21,34,55,89; minimumVolatilityBps=0,0.25,0.5; thresholdBps=0,0.05,0.1,0.25,0.5,1,2,3; volatilityWindow=10,30,60 | 3943/41031/43101 | 2000 | 2000 | 0 |
| sma_reversion | A positive/negative fast-versus-slow price-level separation reverses. | 2000 | 1,2,3,5,7,10 | fastWindow=3,5,8,10,15,20,30,45; minimumVolatilityBps=0,0.25,0.5; slowWindow=20,30,45,60,90,120,180,240; thresholdBps=0,0.1,0.25,0.5,1,2; volatilityWindow=10,30,60 | 3575/41357/43196 | 2000 | 2000 | 0 |
| sma_trend | A positive/negative fast-versus-slow price-level separation continues. | 2000 | 1,2,3,5,7,10 | fastWindow=3,5,8,10,15,20,30,45; minimumVolatilityBps=0,0.25,0.5; slowWindow=20,30,45,60,90,120,180,240; thresholdBps=0,0.1,0.25,0.5,1,2; volatilityWindow=10,30,60 | 3575/41315/43196 | 2000 | 2000 | 0 |
| unconditional_baseline | Persistent unconditional upward or downward tick bias. | 12 | 1,2,3,5,7,10 | direction=fall,rise | 43200/43200/43200 | 12 | 12 | 0 |
| zscore_reversion | A standardized price-level deviation reverts toward its rolling mean. | 2000 | 1,2,3,5,7,10 | lookbackTicks=5,8,10,15,20,30,45,60,90,120,180,240; minimumVolatilityBps=0,0.25,0.5; thresholdZ=0.5,0.75,1,1.25,1.5,1.75,2,2.25,2.5,3; volatilityWindow=10,30,60 | 0/9908/34286 | 1875 | 2000 | 738 |

*The sample-failure sum can count one configuration more than once across total-trade, per-window, and active-day rules.

The 12,012 parameter identities produced only 5,728 distinct nine-scenario outcome-count signatures. That is a proxy, not proof of identical signal paths, but it confirms substantial correlation/redundancy. There were seven directional families but only five transformations: unconditional direction, SMA separation, momentum, channel breakout, and z-score; unconditional, SMA, and momentum each include opposite-polarity pairs. Configurations are not independent observations—the same 43,200 minute decisions and 30 UTC-day clusters were reused throughout.

## Product facts and research decision

Deriv documents Volatility Indices as cryptographically generated and the 1s variants as one tick per second. Its current Synthetic Indices page says most such indices (except Range Break) may not suit technical indicators and that noticeable historical patterns are coincidental; its trading terms say option pricing includes a bias in Deriv's favour. That makes another larger SMA/momentum/reversion search on 1HZ100V difficult to justify without a new mechanism.

Bounded alternatives, none presumed profitable and none started by this audit:

1. **Stop the current direction (recommended).** The evidence against expanding the same 1HZ100V SMA/momentum/channel/z-score grid is the exhaustive frozen screen plus Deriv's description of most synthetic-index patterns as coincidental. The existing checkpointed 90-day collection can still support replication and null calibration after rate limits clear. Reconsider only if a prospectively specified effect survives actual quote, delay, and full-search controls. Incremental local replay cost is minutes; no additional parameter search is justified.
2. **Range Break feasibility study.** Why: Deriv describes this instrument using explicit upper/lower ranges, a different mechanism from applying a generic channel breakout to 1HZ100V. Evidence to investigate is that official mechanism, not the rejected v1 curve. First require a public product probe for Options availability/durations, immutable native-cadence ticks, and contemporaneous indicative proposals; account quotes would still be needed before executable-profit claims. Preregister at most 300 boundary-state rules. Falsify if a protected window is non-positive at observed proposal economics or if availability does not match the proposed contract. Local simulation should be under one hour after acquisition; request count and public-API delay are unknown.
3. **Drift/Volatility Switch clock-horizon feasibility study.** Why: Deriv documents regimes whose average duration is measured in minutes, unlike the searched 1–10-tick horizon. Evidence is the marketed regime construction; its proprietary realization and Options pricing remain unknown. Require a successful contract-capability probe, native-cadence history, a clock-duration simulator, and contemporaneous proposals. Falsify if a preregistered regime classifier does not beat quote-implied break-even on protected data. A single 30-day one-second symbol is up to 2.6 million ticks (about 2,592 maximum-size history pages); local evaluation should be under an hour, but acquisition may again be rate-limited.
4. **Skew Step analytical check before backtesting.** Why: documented asymmetric up/down probabilities could change unconditional direction frequency, unlike the symmetric-style transforms screened here. The payout may fully or adversely price that skew. Require empirical transition counts plus simultaneous public Rise/Fall proposals and verified supported durations; do not infer executable profit from ticks alone. Falsify immediately if the probability-weighted value is non-positive at quoted payouts, before any grid search. A bounded one-week descriptive sample is at most 604,800 one-second ticks; analysis is minutes, while proposal sampling/API availability is the constraint.

More history can narrow uncertainty and expose regime instability; it cannot by itself create a plausible mechanism or turn correlated parameter variations into independent hypotheses.

## Sources (accessed 2026-10-08)

- [Deriv trading terms](https://deriv.com/terms-and-conditions/trading-terms) — next-tick entry rule and pricing bias
- [Deriv Synthetic Indices](https://deriv.com/markets/derived-indices/synthetic-indices) — RNG, tick cadence, instrument mechanisms, and technical-analysis limitation
- [Deriv Price Proposal API](https://developers.deriv.com/docs/trading/proposal/) — tick versus clock duration units and public proposal semantics
- [Deriv contracts_for schema](https://raw.githubusercontent.com/deriv-com/deriv-api-schemas/master/schemas/contracts_for_response.schema.json) — contract type, expiry type, and duration capability fields
- [Deriv open-contract schema](https://raw.githubusercontent.com/deriv-com/deriv-api-schemas/master/schemas/proposal_open_contract_response.schema.json) — entry/exit, profit, payout, status, cancellation, and tick stream fields
- [How to Trade Synthetic Indices](https://docs.deriv.com/marketing/2025/ebook-synthetics-en-hq.pdf) — worked five-tick entry/exit and gross-versus-net payout example
- [White (2000), A Reality Check for Data Snooping](https://doi.org/10.1111/1468-0262.00152) — full-search data-snooping context
- [Politis and Romano (1994), The Stationary Bootstrap](https://doi.org/10.1080/01621459.1994.10476870) — dependence-aware resampling context
- [Hansen (2005), A Test for Superior Predictive Ability](https://doi.org/10.1198/073500105000000063) — multiple-strategy predictive-ability context
- [Bailey et al., The Probability of Backtest Overfitting](https://escholarship.org/uc/item/4w1110bb) — selection-overfitting and repeated-search context

## Reproduce

```powershell
node --test
node src/experiment-audit-cli.js
node src/strategy-search-cli.js status
Get-Content data/market/historical-backfill-status.json
```

The audit command is offline. It requires the local ignored v1 ledger and raw archive whose hashes are recorded above; it never authenticates or places an order.
