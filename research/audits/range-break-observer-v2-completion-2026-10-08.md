# Range Break public-observation completion assessment

Date: 2026-10-08<br>
Protocol: `range-break-boundary-observation-v2`<br>
Session: `2026-10-08T22-44-56-825Z-fbde1edd-dc72-48ff-b69d-747cc52d7f57`<br>
Decision: **NO_GO_FOR_STRATEGY_OR_PROFIT_EXPERIMENT**

## Scope and integrity

This is a completed, unauthenticated public observation. It is not a strategy
backtest, a fill record, or a demo settlement trial. A second tick accumulator
independent of the collector reproduced the raw JSONL summary, and both
artifact hashes matched. This did not regenerate any strategy result. The
observer placed **zero orders** and does not authorize execution.

The raw session remains under the ignored local `data/range-break-observer/`
directory. A public checkout can inspect this compact assessment and its hashes,
but cannot independently recompute it without the exact raw file identified
below. Re-downloading ticks would create a different observation, not restore
the original evidence.

- elapsed: 3600.416 seconds
- ticks: 3598 (3598 unique epochs)
- proposal snapshots: 12
- public API requests: 14 of at most 18
- proposal failures: 0
- tick-source discontinuities: 0
- raw SHA-256: `7066d4e0c1bd2fe8c994745e760aecb4dc3a862c630018165d8db0ed6c1e6eb9`
- raw bytes: 439221
- protocol SHA-256: `7f20c58f71f34619cf94a2653109f3b69bd7ad52dfb2d0b09c0501d3786ef381`
- manifest SHA-256: `9053ecd5b7b912a30928c9e4f4c5a498437f28f8c3a78f44f572754e9dc987ab`

## What the observation established

Deriv documents Range Break as oscillating between upper and lower boundaries,
with a new range after a high or low break and average break frequencies tied
to 100 or 200 boundary hits. That is a product description, not evidence that
a public-data rule predicts the next move or earns more than its costs. The
observed API records expose neither boundary levels nor a live boundary-hit or
reset-state variable.

The public capability response advertised MULTUP: 20, 40, 60, 80, 100x (no_expiry); MULTDOWN: 20, 40, 60, 80, 100x (no_expiry). The same RB100
public endpoint accepted 400x
MULTUP and MULTDOWN proposal requests. Because
the accepted multiplier is absent from the advertised ranges, the product
metadata remains a **SPECIFICATION_CONFLICT**.

All captured proposals had indicative ask prices
1 and commission fields
0.02. Because the
field's units remain unresolved, the two conditional calculations are:
0.02 -> 0.5 bp if account currency, or 2 bp if it denotes a percentage of notional.
For the observed spots, the account-currency interpretation requires a raw
favourable move of 2.5527 to
2.5593
index points merely to offset the opening commission. Neither interpretation
is an all-in break-even or a profitability claim. The proposal payout field was
0: this no-expiry
multiplier is valued as an open position, not as a fixed-return five-minute
Rise/Fall contract.

The observed point path ranged from 51049
to 51189, a
140-point span. It ended
-69 points from its start. These are
price-path facts only; the largest or net move does not establish a tradeable
return. The largest adjacent-tick movement was
-109 points
(-21.3065 bp) at
2026-10-08T22:58:07.000Z; observing a
break after it occurs does not make its direction predictable beforehand.

## Why the strategy experiment stops here

The public data does not contain:

- observable upper/lower boundary, boundary-hit count, and reset state at decision time
- authoritative commission units and complete charging formula
- timestamped executable account entry quote and actual fill
- timestamped early-close/sell valuation across the holding path
- quote validity, rejection, and server processing-delay observations
- slippage and any spread or close-price adjustment
- actual stop-out, cancellation, correction, and settlement events

The official Price Proposal endpoint provides an indicative proposal without
authentication. By contrast, Proposal Open Contract—the interface that reports
an open contract's bid/current value—requires authentication and an existing
contract identity. Deriv's trading terms define next-tick closing for Range
Break CFDs, but do not establish that the observed Options API multiplier has
identical close mechanics. Public midpoint ticks cannot reconstruct either
product's execution events.

Consequently the applicable labels are
**SPECIFICATION_CONFLICT + INSUFFICIENT_EXECUTION_DATA**. No point-path rule, offline
profit calculation, Bot XML, or new demo run is justified from this evidence.

Downstream stages therefore stop deterministically:

- public-capability-observation: `COMPLETED_AND_LOCALLY_VERIFIED`
- cost-complete-shadow-profit-experiment: `NOT_RUN_STOP_CONDITION_INSUFFICIENT_EXECUTION_DATA`
- range-break-strategy-implementation: `NOT_CREATED_NO_QUALIFIED_CANDIDATE`
- operational-demo-check: `NOT_RUN_NOT_AUTHORIZED_AND_NO_CANDIDATE`
- prospective-strategy-validation: `NOT_STARTED_NO_DEVELOPMENT_CANDIDATE`

## Finite next decision

Stop the Range Break strategy branch unless a legitimate source supplies a
timestamped executable entry, complete early-close valuation path, exact
commission units, and terminal contract accounting. The smallest legitimate
future step would be a separately authorized, fixed-term **demo
execution-economics calibration**, not strategy validation. Its sole purpose would be to
record proposal, purchase, open-contract valuation, close/settlement, delays,
and charges for a very small predefined set of contracts. Until that evidence
exists, implementation readiness remains blocked. The repository's
[non-authorizing draft](../protocols/range-break-execution-economics-calibration-draft-v1.json)
sets a two-contract maximum and cannot authorize or execute an order.

## Official sources checked 2026-10-08

- [Contracts For Symbol](https://developers.deriv.com/docs/data/contracts-for/): public capability metadata.
- [Synthetic Indices](https://deriv.com/markets/derived-indices/synthetic-indices): documented Range Break boundary mechanism and qualified indicator discussion.
- [Price Proposal](https://developers.deriv.com/docs/trading/proposal/): unauthenticated indicative contract proposal.
- [Proposal Open Contract](https://developers.deriv.com/comparison/proposal-open-contract/): authenticated contract-specific valuation fields.
- [Complete trading workflow](https://developers.deriv.com/docs/workflows/): purchase precedes open-contract monitoring.
- [Trading terms](https://docs.deriv.com/tnc/trading-terms.pdf): separately documented multiplier commission and Range Break CFD server-processing/next-tick treatment; product equivalence remains unverified.
