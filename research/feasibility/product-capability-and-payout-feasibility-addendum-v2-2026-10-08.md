# Product capability and payout feasibility addendum v2

Issued: **2026-10-08**

Reviewed baseline commit: `8fd7446f537fd5edbb29a5ee677d6337348a9455`

Decision: **`NO_CURRENTLY_TESTABLE_EDGE_HYPOTHESIS`**

This is a versioned amendment to the original feasibility report. It does not
replace or edit that report, the independent audit, the 12,012-row ledger, raw
probe evidence, or dataset manifests. Its purpose is to separate demonstrated
failures from contradictory specifications and missing execution evidence.

There is no `VALIDATED_EDGE`. No positive result—exploratory or otherwise—was
produced. The decision does **not** mean that every Deriv strategy is
unprofitable. It means that none of the three bounded directions currently has
both a coherent specification and sufficient execution data for a credible
after-cost experiment.

## Evidence labels

| Label | Meaning in this addendum |
|---|---|
| `TESTED_AND_FAILED` | The exact stated hypothesis failed a reproducible test within its recorded product, period, data, and assumptions. |
| `SPECIFICATION_CONFLICT` | Current official documentation, public metadata, or observed API behavior disagree. |
| `INSUFFICIENT_EXECUTION_DATA` | Material entry, close, cost, or adverse-path evidence needed for net P/L is unavailable. |
| `FEASIBLE_FOR_BOUNDED_EXPERIMENT` | A frozen small test can be run with adequate public/offline data and an identified execution model. |
| `VALIDATED_EDGE` | A frozen candidate passed a genuinely independent qualifying evaluation. This is not established. |

The prior 1HZ100V search is `TESTED_AND_FAILED` only for its frozen scope:
1HZ100V CALL/PUT, fixed unit stakes, 1–10-tick durations, the seven declared
families/five underlying signal transformations, the exposed 30-day interval,
and assumed 0.70/0.80/0.90 net-win payouts. All 12,012 configurations failed at
least one predefined 0.80-payout window/delay rule. The simulator was adequate
for that narrow direction/payout-sensitivity conclusion, not for a claim of
historically executable account profit.

## Preservation and bounded method

The original ledger remains 12,012 rows with SHA-256
`23da90a773cdffb77c1f71187083985f4cf2916a38eb477875dfbdffe58dccd3`.
The prior audit Markdown/JSON hashes remain
`b9b007dd264833db9c4f6cc0f886f9e037af0934f461c6b94c2e43cd321bb10f`
and `3b66f7e3484f56d8d6a0178fe91ae14219b1b3bcd085dacf261901dc8853e9c1`.
The original feasibility Markdown/JSON hashes remain
`28141f5039014178da93e8a8b425aa5a81b3ad9a0030e335243eaa4ab6e8fbb3`
and `9565bdb4b61dbcf0cf935a6ea33ef34d044cf10106ba671518c67248c7cb861a`.

The v2 protocol was frozen before its API requests. The investigation made
exactly three unauthenticated WebSocket requests with no retry and no buy path:
RB100 `contracts_for`, then otherwise fixed USD 1 stake `MULTUP` proposals at
20x and 400x. Its sanitized evidence hash is
`27ed7b0a176ca7158f163f905fe5febd62541c0a2da07d0b92b2f0ab22031ba2`.
No history call, subscription, authentication, order, collector, large search,
or reserved holdout access occurred.

Protocol deviation: 15 official pages/schemas were consulted although the
documentary cap was 12. Three additional official schema/product pages were
opened while tracing multiplier fields and current product context. This
exceeded the documentary cap; it did not expand the hard three-request API
budget or inspect outcomes. It is disclosed here rather than hidden by
retroactively changing the protocol.

## Classification summary

| Direction | What was actually tested | Classification | Net experiment now? |
|---|---|---|---|
| Range Break boundary state | Current RB100 capability and two point proposals; an old 1,000-point path sample, but no strategy P/L | `SPECIFICATION_CONFLICT`; `INSUFFICIENT_EXECUTION_DATA` | No |
| Skew Step distribution/conditional state | Published Skew 5 unconditional arithmetic only; no conditional or P/L test | `TESTED_AND_FAILED` for the naive Skew 5 frequent-direction raw expectation; `SPECIFICATION_CONFLICT` for Skew 4; `INSUFFICIENT_EXECUTION_DATA` for conditional/after-cost work | No |
| Drift/Volatility Switch regimes | Product and cost/data capability only; no classifier or P/L test | `INSUFFICIENT_EXECUTION_DATA` | No |

None is `FEASIBLE_FOR_BOUNDED_EXPERIMENT` under the frozen gates. None is a
`VALIDATED_EDGE`.

## 1. Range Break capability and economics

### Same product and environment

The captured responses refer to RB100 on
`wss://api.derivws.com/trading/v1/options/ws/public`. `contracts_for` returned
RB100 `MULTUP` and `MULTDOWN`, `no_expiry`, duration zero, and
`multiplier_range: [20,40,60,80,100]`. The two proposal requests used the same
endpoint, RB100, `MULTUP`, USD, stake basis, and amount 1; only multiplier
changed:

- 20x returned `ContractBuyValidationError` and said it accepts
  `400,1000,2000,3000,4000`;
- 400x succeeded with ask price 1, commission field 0.02, payout 0, spot 50857,
  and stop-out value 50732.4.

`contracts_for` is necessarily a symbol-level request while proposal also
requires product and economic parameters, so the requests are related rather
than identical. That does not explain why capability metadata for the same
RB100 MULTUP product advertises a value that its validator rejects. The
[Contracts For documentation](https://developers.deriv.com/docs/data/contracts-for/),
[proposal documentation](https://developers.deriv.com/docs/trading/proposal/),
and current official schemas do not reconcile the different ranges or their
context. Deriv's current [Multiplier product page](https://deriv.com/options-types/multipliers)
advertises multipliers up to 4000x, which agrees with the accepted proposal but
does not explain the metadata. The correct label is
`SPECIFICATION_CONFLICT`, not a strategy failure.

### Conditional break-even calculation

The documented multiplier price-return component is:

`P/L before other effects = price return × stake × multiplier − commission`.

If the captured `commission: 0.02` is **USD 0.02**, then:

`notional = USD 1 × 400 = USD 400`

`raw return threshold = USD 0.02 / USD 400 = 0.00005`

`0.00005 × 100 = 0.005% = 0.5 basis point`.

This arithmetic is correct only under the monetary-field interpretation. A
current proposal response schema describes `commission` as a percentage, while
the official [Volatility multiplier KID](https://docs.deriv.com/regulatory/kid/kid_deriv_multipliers_volatility_indices.pdf)
uses account-currency commission examples. If 0.02 instead means 0.02% of USD
400 notional, commission is USD 0.08 and the price threshold is 2 bp. The KID
is not RB100-specific, so it cannot resolve the unit conflict.

Neither result is an all-in break-even. Both exclude close/sell valuation,
bid/ask effect, quote expiry/rejection, processing delay, slippage, automatic
stop-out path, optional cancellation charge, and any product/account-specific
limits. Several of those are path- or quote-dependent and cannot safely be
collapsed into a constant movement threshold. The [trading terms R26|03](https://deriv.com/terms-and-conditions/trading-terms)
and multiplier page document next-tick processing, early close, stop-out, and
possible slippage, but do not supply a historical execution series.

The prior report's observation that no sampled one-tick point move exceeded
0.5 bp is only a one-tick price-path diagnostic under one conditional cost
interpretation. It does not reject a multi-tick holding hypothesis.

### Missing data and stopping decision

A realistic replay requires historical or prospectively recorded proposal
time/price, actual entry price and tick, close/sell valuation, commission with
units, stop-out threshold and valuation path, quote expiry/rejection, optional
cancellation price, and processing/slippage. Public point history supplies
none of the close economics. Legitimate future sources would be an official
historical execution interface or an authenticated read-only demo record of
proposal/open-contract/statement events. The latter requires separate user
authorization and was not used.

Classification: **`SPECIFICATION_CONFLICT` + `INSUFFICIENT_EXECUTION_DATA`**.
No net-return experiment is justified now. A point-path analysis could be a
limited diagnostic only, never a profitability backtest.

## 2. Skew Step expectation and conditional predictability

The [official Skew Step guide](https://traders-academy.deriv.com/trading-guides/skew-step-indices-guide-asymmetrical-trading)
had no visible publication/update date when accessed on 2026-10-08. Its Skew 5
Up section gives moves and probabilities:

`[-1, +0.1, +0.2, +0.3, +0.4]` and `[0.10, 0.83, 0.05, 0.01, 0.01]`.

The probabilities sum to one, and:

`-1(0.10)+0.1(0.83)+0.2(0.05)+0.3(0.01)+0.4(0.01)=0`.

Skew 5 Down is the sign mirror and also has mean zero. Both have variance
0.1128 in squared published step units. Thus, the naive hypothesis “trade the
frequent sign because its unconditional raw increment is positive” is
**`TESTED_AND_FAILED`** before costs. This says nothing about conditional
expectation after a particular observed state.

Skew Step 4 cannot be analyzed as one coherent published mechanism. The same
page's Skew 4 Up narrative describes 80% small upward/20% sharp downward moves,
while its section table assigns 90% total probability to negative values. Its
later comparison table is incomplete and gives different values. The Skew 4
Down narrative includes “0% chance of small downward moves” while its complete
section table assigns 80% to negative values. The internally complete tables
sum to one and happen to have zero means, but that arithmetic does not choose
which conflicting specification is authoritative. Classification:
**`SPECIFICATION_CONFLICT`**.

The guide says ticks are randomly generated using predefined probabilities and
describes two probability decisions, but it does not explicitly specify
inter-tick independence, transition dependence, or another state process.
Zero unconditional mean therefore does not prove every causal rule has zero
conditional mean. Conversely, an unspecified mechanism is not evidence that
dependence exists.

The preregistered conditional diagnostic was stopped before inspecting any
patterns: Skew 4 failed specification clarity, and no readily available
unauthenticated immutable MT5/cTrader tick/bid/ask export was established.
There was no adaptive pattern search. Classification for conditional and
after-cost hypotheses: **`INSUFFICIENT_EXECUTION_DATA`**. Even future evidence
of dependence would need costs and independent evaluation before it could be
called a trading edge.

## 3. Drift/Volatility Switch minimum viable data

Official material describes persistent bullish/bearish/sideways Drift Switch
behavior and low/medium/high Volatility Switch behavior, while exact switching
is random. The [Volatility Switch guide](https://traders-academy.deriv.com/trading-guides/volatility-switch-indices-guide)
also says spread changes dynamically with regimes. This is a genuinely
different clock-time state hypothesis from the rejected 1–10-tick indicator
families, but a documented regime mechanism is not evidence of a causal,
after-cost classifier.

| Required field | Current evidence | Minimum acceptable record |
|---|---|---|
| Exact instrument/product | Product-family pages and a Drift KID; no frozen exact symbol | Symbol, platform, account/jurisdiction availability, long/short rules |
| Bid/ask history and spread | No free unauthenticated synchronized history established | Ordered server-timestamped bid and ask ticks, spread changes, gaps |
| Cadence | Descriptions only | Native timestamps, ordering, missing intervals, platform timezone |
| Contract size/point value | Illustrative KID example | Exact symbol specification and currency conversion effective at trade time |
| Commission/financing | General terms and illustrative KID values | Commission schedule plus time-varying swap/rollover rules |
| Margin/stop-out | General mechanics | Leverage, margin, stop-out threshold, and valuation path |
| Delay/slippage | General processing language | Receipt, processing, and fill/close timestamps and prices, or a frozen defensible model |
| Regime information | Behavioral descriptions; no public state-label history | A causal published state field, or no label and only preregistered inference from past observations |

The [Drift Switch CFD KID](https://docs.deriv.com/regulatory/kid/kid_deriv_cfds_drift_switch_indices.pdf)
defines an open-ended CFD with price-change P/L, spread, possible financing,
margin, and stop-out. Its example spread of 1.97 bp and approximately 4.1 bp
24-hour total cost are illustrative, not a current quote or universal cost.
Public midpoint/point history cannot reproduce net CFD returns or adverse
stop-out paths.

The missing data were not established without authentication or platform
access. The minimum future user action is to provide a sanitized, zero-order
demo MT5/cTrader export with synchronized bid/ask ticks and the exact symbol
and account product specification, or separately authorize future
authenticated **read-only** demo capture. No order is required. Until then,
classification is **`INSUFFICIENT_EXECUTION_DATA`**, and no regime search should
begin.

## Holdout and collector status

No reserved holdout was opened. The earlier protocol named
`[2026-10-09, 2026-11-08)` as a possible prospective window, but no finalist or
one of these exact hypotheses was frozen before qualification. A date range by
itself is not prospective validation. Its current status is `NOT_ASSIGNED`; it
could only become qualifying future data for a candidate fixed beforehand and
paired with adequate execution evidence.

The 90-day 1HZ100V backfill is not running. Its checkpoint is `FAILED` after
250 pages and 250,000 newly stored rows, cursor `1788417199`, because eight
bounded `ticks_history` rate-limit retries were exhausted. The recorded target
is `[1783483200,1791259200)`. It was not resumed. For a future explicitly
authorized recovery only, the existing command is:

```powershell
node src/historical-backfill-cli.js --from 1783483200 --to 1791259200
```

## Decision

**`NO_CURRENTLY_TESTABLE_EDGE_HYPOTHESIS`** is the direct result.

- Negative evidence applies to the exact frozen 1HZ100V screen and the naive
  unconditional Skew 5 frequent-direction idea.
- Range Break multiplier/commission evidence and Skew Step 4 specifications
  conflict.
- Every proposed after-cost alternative lacks execution-grade data.

More compute does not resolve those blockers. The next useful evidence is an
official specification reconciliation or a legitimate execution-grade record,
not a larger parameter search. If one named blocker is later resolved, the
cheapest next step remains a single preregistered descriptive/falsification
experiment, not optimization. No bot implementation is justified.

## Offline reproduction

These commands do not authenticate, start collectors, or place orders:

```powershell
node src/range-break-reconciliation-cli.js --verify
node src/feasibility-calculations-cli.js
node src/research-status-cli.js
node --test test/feasibility-addendum.test.js test/research-status.test.js
node --test
Get-FileHash research/evidence/range-break-reconciliation-public-probe-2026-10-08-v2.json -Algorithm SHA256
Get-FileHash data/research/development-screen-v1/ledger.final.jsonl -Algorithm SHA256
```

The source inventory, per-direction blockers, minimum-data table, protocol
deviation, and exact evidence hashes are also recorded in
`evidence-blocker-matrix-v2-2026-10-08.json`.
