# Execution and strategy-path audit v3

Date: 2026-10-08 (UTC)

Reviewed baseline: `e8263e3c684b5b7a60eccbb390ba31a22de2f39e`

Decision: **NO_CURRENTLY_TESTABLE_EDGE_HYPOTHESIS**

Trading/authentication performed: **none**

This is a versioned amendment. It does not alter the v1 ledger, the v2 audit, the feasibility reports, raw probes, or market archives. The conclusion remains narrow: no strategy qualified in the frozen 1HZ100V short-tick development screen. That is not evidence that every Deriv strategy is unprofitable.

## What exists and what is proven

| Layer | Connected behavior | Evidence in this task |
|---|---|---|
| Public data acquisition | Public WebSocket ticks are normalized into immutable gzip JSONL chunks; manifests retain source, request bounds, timestamps and SHA-256. Bounded historical paging and live collection are separate. | Code/tests inspected. No collector started. The 90-day checkpoint is `FAILED`, its process state was checked separately, and 4,934,000 target seconds remain outside manifest descriptor coverage. |
| Dataset construction | Exact slice audits reject checksum, row-count, ordering, duplicate and gap defects. Research splits are chronological and purge crossing labels. | The original evaluated slice was independently re-audited: 2,591,993 genuine seconds of 2,592,000, with the preserved seven-second gap and matching content hash. |
| Strategy generation | The frozen engine implements seven named families on one 1HZ100V slice with gap resets and delayed entry/settlement. | Software paths have offline tests. This task did not rerun all signals from raw ticks. |
| Historical evaluation | The ledger stores 12,012 unique configurations and 324,324 window/delay/payout runs. | The original 115,485,863-byte ledger hash matched. Every ledger accounting field, cardinality, family count, rejection count and provenance singleton was recomputed and matched. This is a ledger-summary reproduction, not a full raw-data strategy rerun. |
| Statistics/selection | Frozen rules include chronological windows, payout/delay stress, clustered bootstrap, Bonferroni evidence and neighbouring-parameter checks. | The ledger records zero qualifiers; 11,960 base-expectancy failures and all 12,012 stress and multiple-testing failures. The earlier audit remains the detailed statistical review. |
| Prospective validation | Candidate selection must precede a genuinely future evaluation window. | Not started. The old calendar range is `NOT_ASSIGNED`; a date range alone is not a holdout. |
| Deployment qualification | A tracked candidate evidence package must match product, strategy/configuration hash, executor-source hash and execution assumptions. | Newly enforced in `tradeDemoOnce`. The tracked decision has no candidate, so connection and purchase are blocked even if `executionEnabled` is manually set true. |
| Demo lifecycle | Intent journal, one-run lock, proposal, buy, statement/open-contract recovery, settlement and UTC risk accounting. | Exercised end-to-end with an injected offline broker and a checksum-bound test-only qualification fixture. No network or order was used. |
| Browser/XML branch | Old XML files contain purchase blocks and cannot enforce the account selector themselves. | They are now enumerated by hash in a disarmed archive registry. They remain historical artifacts, not a deployment route. |
| Status/CI | Offline evidence status separates reported findings, artifact integrity and partial reproduction. | Status rejects malformed/conflicting evidence, verifies the approved archive target, and never authorizes trading. CI status is reported separately from local results. |

## Confirmed defects and corrections

| Finding | Severity | Reproduction | Correction | Prior result affected |
|---|---:|---|---|---|
| Qualification disconnected from executor | Critical | An enabled unqualified config could reach `buyProposal`; the exported low-level request method could also carry a buy payload. | The orchestrator verifies a separately stored, checksummed candidate package before broker connection, and the low-level purchase method independently re-verifies it immediately before submission. Generic order-bearing requests are rejected. Candidate ID, strategy hash, product/contract/duration/stake, executor version/source hash, frozen protocol/result, quote age and minimum payout economics are bound. Current state fails closed. | No v1 research row changes. Earlier demo template was unsafe to enable and is not qualified. |
| Wrong purchase could reconcile by price/time | Critical | A 1HZ100V CALL intent accepted a same-price R_50 PUT row. | Journal account fingerprints and immutable intended terms are required. Assignment requires exactly one candidate statement row, whose contract ID is checked for instrument, type, currency, stake, time and tick/clock duration evidence. Any additional or incomplete candidate remains ambiguous. | Any legacy account-less journal is ineligible; it was not rewritten. |
| One statement page treated as exhaustive | Critical | A full 999-row page could release an intent. | Offset pagination is bounded and records coverage. Duplicate/overlapping pages, failures, missing fields and page-limit exhaustion are incomplete. `not_purchased` requires two separated, complete no-match observations after the grace period. | No research result. Recovery behavior changed from unsafe release to block. |
| Settlement validation permissive | Critical | `null` became zero; immediate settlement could use another contract ID. | Immediate and restart paths share one validator. Numeric strings are allowed; null/blank/boolean/non-finite values, missing/mismatched identity, inconsistent won/lost status and unsupported cancellation/refund semantics remain unresolved. Early sales are accounted but excluded from ordinary expiry performance. | Unvalidated local demo records cannot qualify or train a candidate. |
| Journal identity/state validation incomplete | High | An identity-less settlement could be counted without a durable intent or reconciled broker contract. | Every event now carries account, strategy and event-time identity; the first record fixes exact contract terms; transitions and chronology are validated; a settlement requires a prior reconciled contract; documented numeric strings are normalized before risk accounting. | Legacy identity-less demo journals fail closed and were not rewritten. The frozen v1 research ledger is unaffected. |
| Daily loss used opening day | High | A loss opened at 23:59:59 UTC and settled after midnight disappeared from that morning's loss. | Entry-day counts and settlement-day realized P&L are separate. Unique corrections apply on correction day; duplicate corrections do not double count. Pending loss reservation and cross-date cooldown remain. | Risk state only. |
| Checkpoint defined its own archive target | High | A complete three-second fixture could be called the 90-day expansion. | Verification reads the tracked approved specification and compares exact symbol and interval before inspecting the archive. Terminal collector state, verified coverage and source-gap evidence are separate fields. | Prior “complete” status for a mismatched checkpoint is superseded. The real expansion remains incomplete. |
| Rejected summary retained VERIFIED | High | An inventory/summary outcome conflict left a stale verified published object. | Rejected intermediates are cleared; outcome/count/completion become null/unverifiable while any secondary narrative is labelled separately. | Status presentation only; preserved reports are unchanged. |
| Still-forming/gapped candle and stale proposal risk | High | The newest incomplete candle could drive a signal, gaps could cross indicator state, and response latency was omitted from proposal age. | Decisions require a recent contiguous suffix of completed candles. Exact proposal terms, finite gross payout, frozen win-net threshold and quote age measured when the response is checked are enforced before a durable intent and purchase. | No v1 simulation change; this affects future executor parity. |

The lifecycle suite additionally checks wrong account, wrong symbol/type, missing identity, malformed values, pagination truncation/failure, a lost buy response, restart with an open contract, duplicate/conflicting settlements, journal failure after purchase, cross-midnight settlement, stale quotes, concurrent attempts and mismatched qualification. Purchase intent is durably appended before `buy`; a failure after purchase leaves that intent for reconciliation and never retries within the run.

The official statement interface documents `limit`/`offset` traversal, but the reviewed public documentation does not promise an immutable multi-page snapshot or a permanent retention horizon. The two separated, complete no-match observations are therefore a conservative operational release rule, not mathematical proof that a delayed broker correction can never appear. Any incomplete, changing, ambiguous or conflicting observation remains blocked; a future live-readiness review must confirm account-applicable retention and consistency semantics before this rule can support demo execution.

## Why the frozen search found no qualifier

The evidence supports several statements, not one universal claim:

- **Predictive mechanism:** the seven family labels reduce to a small set of correlated transformations (unconditional direction, moving-average relation, momentum, channel and z-score). All configurations reused the same 30-day 1HZ100V path and three UTC clusters. The prior independent audit found only 5,728 distinct outcome-count signatures. Twelve thousand configurations are not twelve thousand independent hypotheses or samples.
- **Base economics:** 11,960 configurations missed the frozen minimum base expectancy. This is direct negative development evidence under the assumed +0.90/-1 contract accounting.
- **Stress economics:** all 12,012 failed the +0.80 payout/delay stress. That is a conservative stress failure, not proof that every one loses under every executable quote.
- **Statistical evidence:** all failed the frozen multiple-testing evidence rule. “Insufficient to distinguish from zero after selection” is distinct from “negative base estimate.”
- **Operational/sample rules:** some also failed minimum trades/days, drawdown or losing-streak constraints. Those are separate failures.
- **Execution limitation:** public point prices are not account-specific proposals, fills or settlements. The result shows directional-price sensitivity under declared payout assumptions, not historical executable account profit.

More 1HZ100V history could narrow sampling uncertainty and reveal time instability. It cannot create an information mechanism, resolve historical payouts/fills, or turn correlated indicator variations into independent ideas. The rejected short-tick indicator search should remain stopped.

## At most three distinct directions

### 1. Range Break boundary-state hazard — highest priority for evidence acquisition, not yet testable for net profit

- **Product/horizon:** RB100 or RB200 `MULTUP`/`MULTDOWN`, held across multiple ticks around a causally inferred range boundary.
- **Observable feature:** distance to an inferred support/resistance boundary, direction and count of boundary contacts, calculated only from prior public ticks.
- **Mechanism:** Deriv documents Range Break as oscillating between boundaries before a break and describes an average 100 or 200 boundary-hit frequency. It is also the historical exception in Deriv's warning that synthetic-index indicator patterns may be coincidental.
- **Why it differs:** it tests a product-defined state/hazard, not another 1HZ100V SMA/momentum variation.
- **Economics:** captured `contracts_for` advertised 20–100x while otherwise equivalent public proposals rejected 20x and accepted 400x. The captured 400x quote reported USD 1 stake and USD 0.02 commission, but commission units, contract-specific sell values, stop-out valuation and processing are not available historically. A raw 0.5-basis-point arithmetic threshold excludes exit cost and is not a complete break-even model.
- **Falsifier:** after terms and close valuation are available, freeze one boundary estimator and compare predeclared boundary states with forward returns and executable contract P/L. Failure to predict raw movement already falsifies the mechanism; raw success still must clear costs.
- **Present classification:** `SPECIFICATION_CONFLICT` plus `INSUFFICIENT_EXECUTION_DATA`.

### 2. Drift/Volatility Switch causal regime persistence — mechanism distinct, data absent

- **Product/horizon:** Drift Switch 10/20/30 or Volatility Switch CFD, minutes rather than ticks, with holding shorter than the documented average regime duration.
- **Observable feature:** a single frozen rolling trend/volatility state computed from data available at decision time; hidden product state is forbidden.
- **Mechanism:** Deriv describes persistent bullish/bearish/sideways phases and low/medium/high-volatility cycles. Persistent latent state could make causal classification useful.
- **Why it differs:** the target is regime persistence and cost-aware CFD return, not next-tick binary direction.
- **Economics/data blocker:** the local archive has no exact product dataset, synchronized bid/ask, dynamic-spread history, financing, point value, margin/stop-out path, fills or slippage. Public midpoint movement is insufficient.
- **Falsifier:** on synchronized bid/ask data, one preregistered state proxy must predict the next fixed horizon out of sample and remain positive after full costs. A hindsight regime label is disallowed.
- **Present classification:** `INSUFFICIENT_EXECUTION_DATA`.

### 3. Skew Step conditional transition — lowest priority

- **Product/horizon:** Skew Step 5 Up/Down over one to several ticks; Skew Step 4 is deferred while its published narrative and table conflict.
- **Observable feature:** only prior step sizes/directions.
- **Mechanism:** published marginal distributions create asymmetric frequent small moves and rare opposing moves. A conditional rule would require transition dependence beyond those unconditional marginals; Deriv does not document such dependence.
- **Why it differs:** it tests one preregistered transition statistic rather than price indicators. The naive frequent-direction expectation is already tested and failed: the published Skew Step 5 table has zero raw unconditional mean before costs.
- **Falsifier:** after exact symbols/specification/data exist, run one conditional-dependence test with independent simulations, a predeclared comparison count and an unseen chronological segment. Dependence alone is not profit.
- **Present classification:** narrow `TESTED_AND_FAILED` for the unconditional idea, `SPECIFICATION_CONFLICT` for Skew 4, and `INSUFFICIENT_EXECUTION_DATA` for net trading.

No bounded strategy experiment was run because none of these datasets contains its required executable economics. A midpoint-only result would be a misleading backtest. This task used the preserved public probes and made zero new Deriv API requests.

## Finite path and stop rules

| Milestone | Status | Required evidence | Next action | Completion / stop condition |
|---|---|---|---|---|
| Engineering complete | **PASS locally** | Lifecycle invariants through the real orchestration path; full offline suite; current no-candidate gate blocks. | Keep CI and source-hash gate green. | Complete when remote CI executes and passes this commit; reopen on any lifecycle regression. |
| Research feasible | **BLOCKED** | Coherent product limits/fees plus timestamped executable entry and close valuation, delay and stop-out behavior. | Resolve RB100 account-applicable specifications and identify a legitimate close-valuation source. | Continue only if all fields exist and agree. Stop this Deriv direction if they remain unavailable/contradictory. |
| Development candidate found | **NOT STARTED** | Frozen <=60-configuration Range Break protocol, chronological data and positive cost-inclusive development evidence with selection adjustment. | Only after feasibility passes. | Stop on nonpositive net result, instability, or failed adjusted uncertainty; do not enlarge the search afterward. |
| Prospective candidate validated | **NOT STARTED** | Candidate frozen before a new future window; predefined pass/fail checkpoint; no tuning on that window. | Collect only after selection. | One failure returns to a genuinely new hypothesis, not retuning. |
| Demo implementation ready | **BLOCKED** | Exact parity plus hash-bound qualification, current quotes within assumptions and reconciled settlements. | Create a new versioned implementation only after prospective pass. | Any parity, identity, accounting or execution-assumption mismatch blocks. |

The single best next action is therefore **not another strategy search**. First resolve RB100's account-applicable multiplier/commission specification and establish a legitimate timestamped entry-and-close valuation source. A consistent specification plus complete close-price/delay/stop-out evidence justifies a small frozen experiment. If that evidence cannot be obtained, stop this approach rather than substitute midpoint data or more indicators.

## Official sources (accessed 2026-10-08)

- [Deriv Synthetic Indices](https://deriv.com/eu/markets/derived-indices/synthetic-indices): random-generation context, Range Break mechanics, regime products and the indicator/order-book warning.
- [Deriv API best practices](https://developers.deriv.com/docs/best-practices/): fresh proposals, maximum buy price, reconciliation before retry, contract tracking, pagination and secret hygiene.
- [Trading operations](https://developers.deriv.com/docs/trading/), [proposal](https://developers.deriv.com/docs/trading/proposal/), [buy](https://developers.deriv.com/docs/trading/buy/), [open contract](https://developers.deriv.com/docs/trading/proposal-open-contract/), and [statement](https://developers.deriv.com/docs/account/statement/): public versus authenticated evidence and the contract lifecycle.
- [API limits](https://developers.deriv.com/docs/limits/): current shared request budgets.
- [Official API schemas](https://github.com/deriv-com/deriv-api-schemas): statement `limit`/`offset` and buy/open-contract response fields used by the validators.
- [Deriv trading terms](https://signup.deriv.com/tnc/trading-terms.pdf): spread/commission, server processing and next-tick exit provisions for specified CFD products.
- [Volatility Switch product note](https://experts.deriv.com/insights/trade-volatility-phases-with-vsi): phases and dynamic spreads. This is a product description, not evidence of an exploitable edge.
- [Skew Step guide](https://deriv.com/academy/trading-guides/skew-step-indices-guide-asymmetrical-trading): published marginal tables; its Skew Step 4 conflicts are preserved rather than repaired by assumption.

## Reproduce

```powershell
node --test
node src/research-status-cli.js --strict=public
node src/research-status-cli.js --strict=reproduction
node src/product-feasibility-probe-cli.js --verify
node src/range-break-reconciliation-cli.js --verify
node src/feasibility-calculations-cli.js
```

`--strict=reproduction` recomputes preserved ledger summaries and audits the fixed data slice; it does not rerun all 12,012 strategies. No command above authenticates, starts a collector/search, or places an order.
