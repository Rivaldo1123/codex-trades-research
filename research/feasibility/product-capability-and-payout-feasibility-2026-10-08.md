# Product capability and payout feasibility gate

Access date: **2026-10-08**

Reviewed repository commit: `ef03504b5f82bc73f0ce23669cab8072591b8f2d`

Decision: **NONE_JUSTIFY_FURTHER_RESEARCH**

## Direct conclusion

Do not launch another strategy search. None of the three genuinely different
directions clears the product, data, and execution-economics gates needed for a
credible net-return test:

1. **Range Break** has the strongest mechanism-based rationale, but the current
   public contract metadata contradicts the point-proposal validator and no
   historical close-price stream is available. It ranks first only for a tiny
   future capability reconciliation—not for strategy optimization.
2. **Skew Step 5** has zero expected raw increment under Deriv's own published
   distribution before costs. Deriv's Skew Step 4 table is internally
   inconsistent, and neither public Options capability nor execution-grade
   history was observed.
3. **Drift/Volatility Switch** has persistent regimes, but switch timing is
   documented as random, current public Options capability was absent, and a
   realistic CFD replay needs bid/ask, dynamic spread, close processing,
   margin, and stop-out information that the public tick feed does not supply.

This is not a finding that the products cannot be profitable. It is a finding
that the currently accessible evidence does not justify spending compute on a
strategy search. There is **no positive exploratory or independently validated
result** in this study.

## Baseline preservation and controls

The independent audit's narrow conclusion remains `NO_RELIABLE_EDGE_FOUND` for
the completed 1HZ100V CALL/PUT screen. This study does not alter its protocol,
ledger, results, or audit:

- original ledger: 12,012 rows, SHA-256
  `23da90a773cdffb77c1f71187083985f4cf2916a38eb477875dfbdffe58dccd3`;
- independent audit Markdown SHA-256
  `b9b007dd264833db9c4f6cc0f886f9e037af0934f461c6b94c2e43cd321bb10f`;
- independent audit JSON SHA-256
  `3b66f7e3484f56d8d6a0178fe91ae14219b1b3bcd085dacf261901dc8853e9c1`.

No collector or large search was started or resumed. No authentication, order,
purchase, paid data, or paid compute was used.

## Evidence method

The study combined current official Deriv documentation with one immutable,
bounded probe of Deriv's unauthenticated public Options endpoint. The probe made
nine requests with no retry: one `active_symbols`, two `contracts_for`, five
`proposal`, and one `ticks_history`. It retained no proposal ID and had no buy
path. Evidence:

- [`product-feasibility-public-probe-2026-10-08-v1.json`](../evidence/product-feasibility-public-probe-2026-10-08-v1.json),
  SHA-256
  `9a70b7e72fe006b6eb1ebbf644f121b86ab836985749fc0cfefeff82bdc9c51a`;
- machine-readable interpretation:
  [`product-capability-and-payout-feasibility-2026-10-08.json`](product-capability-and-payout-feasibility-2026-10-08.json).

The public Options catalogue is not a catalogue for MT5/cTrader CFDs, every
account, every jurisdiction, or historical availability. A point proposal is
indicative, not executable account evidence. Point history is not bid/ask,
close-quote, or settlement history. The probe retained the catalogue total and
matching records rather than all 89 raw catalogue rows; empty matches are
reproducible from the checked-in filter but are not a full raw-catalogue
snapshot.

## Comparison

| Rank* | Direction and mechanism | Product/duration evidence | Payout and break-even | Historical simulation | Difference from v1 | Cheapest falsifier |
|---:|---|---|---|---|---|---|
| 1 | **Range Break boundary state.** Deriv documents bouncing between boundaries and a reset after high/low breaks, averaging 100 or 200 boundary hits. | Public Options exposed RB100/RB200 only as `MULTUP`/`MULTDOWN`, `no_expiry`; no fixed-duration CALL/PUT. Advertised 20–100 multipliers conflicted with a proposal error accepting 400–4000. | Four USD 1, 400x point indications charged USD 0.02. Raw favourable movement must exceed `0.02/(1*400)` = 0.005% = **0.5 bp**, before close costs. | A 1,000-row RB100 point sample was available at one-second cadence, but no hidden boundary/hit counter, historical close quote, or complete-period proof exists. Credible net replay: **no**. | Instrument-specific boundary/reset state, not a generic indicator on 1HZ100V. | **Already fails readiness.** Resolve contract metadata and find exact read-only entry/close economics first; stop if either is unavailable. Only then consider one preregistered rule, ≤20,000 ticks, ≤12 quote snapshots, ≤20 public requests. |
| 2 | **Skew Step distribution.** Frequent small moves oppose rare larger moves. | Academy documents four MT5/cTrader variants, 24/7; none appeared in the current public Options catalogue. No fixed expiry was documented. | Published Skew 5 Up expectation is `-1(.10)+.1(.83)+.2(.05)+.3(.01)+.4(.01)=0`; Down is the mirror. Costs make a naive frequent-direction trade worse. No current bid/ask quote was available. | Academy says platform backtesting is supported, but the audit found no public bid/ask/spread history. Credible net replay: **no**. | Tests a published asymmetric increment law, not a fitted symmetric-market indicator pattern. | **Algebra already falsifies the unconditional frequent-direction idea.** Do nothing further unless consistent specifications and a zero-cost bid/ask export appear; then verify one week of transition counts before one preregistered path rule. |
| 3 | **Drift/Volatility Switch latent regimes.** Direction or variance persists for minutes; exact VSI switch timing is random. | Drift Switch is documented as a no-fixed-term CFD on MT5. No matching symbol appeared in the public Options catalogue, and no fixed-duration option was verified. | CFD break-even is favourable move × units greater than spread + commission + swap + execution costs. A DSI10 KID illustration uses a 1.97 bp spread and about 4.1 bp total 24-hour cost; it is not a current quote. | No public bid/ask, dynamic-spread, explicit regime-state, margin, or stop-out history was found. Point/mid prices cannot reproduce net CFD returns. | Clock-time latent-state classification over minutes, not 1–10-tick directional transforms. | **Capability gate first.** Require a free export with timestamped bid, ask, and spread for one exact product; stop if absent. Only if cleared, run one seven-day descriptive classifier check, no P/L grid. |

\*Ranks compare only hypothetical micro-experiments if their missing capability
appears. The actual recommendation is to stop; rank 1 is not a recommendation
to trade or launch a search.

## 1. Range Break boundary-state hypothesis

### Documented mechanics versus edge evidence

Deriv describes Range Break as a price that bounces between upper and lower
boundaries, then makes a high or low break to create a new range, on average
after 100 or 200 boundary hits. Deriv also says Range Break may be more suited
to channel analysis than other synthetic indices. This supplies a plausible
state variable. It does **not** show that a trader can infer the proprietary
boundary state early enough or earn more than contract costs.

### Product and payout feasibility

The live bounded public probe found RB100 and RB200. `contracts_for` returned
only no-expiry multipliers (`MULTUP` and `MULTDOWN`), with no Rise/Fall product
or tick/clock expiry. It advertised multipliers 20, 40, 60, 80, and 100, but a
public proposal at 20 was rejected and reported acceptable values 400, 1000,
2000, 3000, and 4000. That product-definition contradiction must be resolved
before an experiment can be frozen.

At 400x, all four point indications had USD 1 ask/stake, USD 0.02 commission,
and a zero `payout` field. This is not a binary contract. Using Deriv's
multiplier formula, the raw movement threshold is:

`commission / (stake × multiplier) = 0.02 / (1 × 400) = 0.00005 = 0.005% = 0.5 bp`.

That omits close-price effects and processing. The 999 one-tick changes in the
point history sample had a maximum absolute move of 0.185625 bp; zero exceeded
0.5 bp. This falsifies a one-tick raw-movement version at that quote, not a
multi-tick boundary strategy.

Deriv's terms define multiplier and Derived-Index CFD entry as the next tick
after server processing. Range Break CFD exit is also the next tick after close
processing. A point-price backtest without those entry/exit events can reward
an impossible fill.

### Bounded falsifier

No search should run now. The cheapest gate is documentary/data capability:
resolve the multiplier mismatch and identify a read-only record of exact entry
and close economics. If either is unavailable, stop. If both later become
available, cap a preregistered test at one symbol, one boundary-state rule,
20,000 consecutive native ticks, 12 point-quote snapshots, and 20 public
requests. Failure to causally reconstruct boundaries or non-positive protected
after-cost return ends the direction.

## 2. Skew Step distribution hypothesis

### Documented mechanics versus edge evidence

Deriv's Academy describes four probability-driven Skew Step variants. For Skew
Step 5 Up, its table gives a 10% move of -1 and positive moves of +0.1, +0.2,
+0.3, and +0.4 with probabilities 83%, 5%, 1%, and 1%. Their weighted mean is
exactly zero. Skew Step 5 Down is the mirror. A 90% positive-sign rate therefore
is not a positive raw-value mechanism; rare losses offset frequent wins before
spread or other costs.

The same official page is internally inconsistent for Skew Step 4: surrounding
text says 80/20 while one table repeats 10/83/5/1/1 with opposite signs, another
table uses a different set, and one line says “0%” where the surrounding
description implies 80%. Skew Step 4 economics cannot be safely derived from
that page.

### Product, payout, and data feasibility

The Academy places Skew Step on MT5 and cTrader and says platform backtesting is
supported. No matching instrument appeared in the current public Options
catalogue, and no public bid/ask or spread history was established. This is a
CFD-style problem, not a fixed-payout direction test: favourable price movement
must pay the round-trip spread and all other costs. Without the actual bid/ask
series, a mid-price backtest is not realistic.

### Bounded falsifier

The unconditional “trade the frequent direction” version is already falsified
by algebra. No data collection is justified. Reopen only if Deriv publishes
consistent specifications and a free execution-grade export becomes available;
then compare one week of empirical transition counts with the frozen published
distribution before testing one preregistered path-dependent rule.

## 3. Drift/Volatility Switch latent-regime hypothesis

### Documented mechanics versus edge evidence

Drift Switch alternates among bullish, bearish, and sideways regimes with
average durations of 10, 20, or 30 minutes. Volatility Switch alternates among
low, medium, and high regimes. Deriv states that VSI transition timing is random
and spreads adjust dynamically with the regime. Persistent state could make a
clock-time classifier scientifically different from v1; it does not establish
tradable direction or volatility after costs.

### Product, payout, and data feasibility

The Drift Switch KID describes a no-fixed-term CFD on MT5. Neither Drift Switch
nor Volatility Switch appeared in the current public Options catalogue. For a
CFD, there is no win probability/payout shortcut: `(close - open) × units` in
the favourable direction must exceed spread, any swap/commission, and execution
costs. The DSI10 KID's illustrative one-lot scenario uses a 0.0197% (1.97 bp)
spread and USD 2.079 total cost over 24 hours on USD 5,130.50 notional (about
4.1 bp). Those are examples, not current quotes or universal costs.

The current public evidence has no historical bid/ask, dynamic spread, explicit
regime state, margin, or stop-out stream. Deriv's terms also distinguish CFD
processing: Derived-Index entry is the next tick after processing; for products
outside the named Range Break/Crash-Boom/Jump/DEX exceptions, exit is the latest
available tick when close processing occurs. A point-price replay cannot model
that contract credibly.

### Bounded falsifier

The first experiment is a capability gate, not a strategy test: obtain a
zero-cost export containing timestamps, bid, ask, and spread for one exact
product and unambiguous contract specifications. If unavailable, stop. If it
later exists, cap the next step at a seven-day descriptive, preregistered regime
classification check with no P/L grid or adaptive parameters.

## Ranked next decision

**Rank 0 — stop (recommended).** No direction currently supports a credible
net simulation, so the expected information value of another search is lower
than its selection-bias and implementation risks.

If new capability arrives without paid services or trading, the conditional
order is:

1. reconcile Range Break contract metadata and read-only close economics;
2. verify consistent Skew Step specifications and execution-grade history;
3. verify regime-switch bid/ask and dynamic-spread history.

Each gate is deliberately capable of ending its direction without a backtest.
More indicators, more configurations, or more point-price history do not repair
missing contract economics.

## Sources

All were accessed 2026-10-08.

- [Deriv Synthetic Indices](https://deriv.com/markets/derived-indices/synthetic-indices) — generator and instrument mechanisms; technical-analysis caveat.
- [Deriv API product updates](https://developers.deriv.com/product-updates/) — RB100/RB200 API announcement and product-capability warning.
- [Active Symbols](https://developers.deriv.com/docs/data/active-symbols/) and [Contracts For](https://developers.deriv.com/docs/data/contracts-for/) — current public capability semantics.
- [Price Proposal](https://developers.deriv.com/docs/trading/proposal/) and [Ticks History](https://developers.deriv.com/docs/data/ticks-history/) — unauthenticated point quote/history semantics.
- [Deriv Multipliers](https://deriv.com/options-types/multipliers) — multiplier P/L and commission formula.
- [Deriv trading terms R26|03](https://deriv.com/terms-and-conditions/trading-terms) — processing, pricing, spread, swap, margin, and stop-out mechanics.
- [KID: CFDs on Drift Switch Indices](https://docs.deriv.com/regulatory/kid/kid_deriv_cfds_drift_switch_indices.pdf) — CFD formula, illustrative costs, term, and platform.
- [Volatility Switch Index guide](https://traders-academy.deriv.com/trading-guides/volatility-switch-indices-guide) — random regime timing and dynamic spreads.
- [Skew Step Indices guide](https://traders-academy.deriv.com/trading-guides/skew-step-indices-guide-asymmetrical-trading) — distributions, platforms, and the documented inconsistencies noted above.

## Reproduce without network access

```powershell
node src/product-feasibility-probe-cli.js --verify
node --test test/product-feasibility-probe.test.js
node --test
Get-FileHash research/evidence/product-feasibility-public-probe-2026-10-08-v1.json -Algorithm SHA256
Get-FileHash data/research/development-screen-v1/ledger.final.jsonl -Algorithm SHA256
```

The first command verifies the saved evidence and its request-budget and
break-even invariants; it does not repeat the public probe. A new bounded probe
requires an explicit `--collect --output NEW_PATH` and is not part of the
recommended next action.
