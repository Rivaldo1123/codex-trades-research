# Feasibility addendum v2: bounded investigation protocol

Frozen: 2026-10-08 before any v2 public API request.

## Questions

1. Does the same unauthenticated Deriv Options endpoint report an RB100
   `MULTUP` multiplier range of 20–100 in `contracts_for` while rejecting an
   otherwise equivalent multiplier-20 proposal and accepting multiplier 400?
   If so, does current official documentation explain the different units or
   contexts?
2. Do the published Skew Step distributions define a valid unconditional
   expectation, and are the Skew Step 4 specifications coherent enough to
   preregister one conditional-dependence diagnostic?
3. Can Drift Switch or Volatility Switch CFD profitability be simulated from a
   legitimate free, unauthenticated public interface with decision-time bid,
   ask, spread, contract value, financing, margin, and execution information?

## Sources and limits

- Reuse the immutable v1 feasibility report and nine-request probe before any
  new request.
- Read at most 12 current official Deriv documentation, schema, terms, KID, or
  Academy pages. Do not use promotional claims as evidence of an edge.
- Make at most **three** WebSocket requests, all to
  `wss://api.derivws.com/trading/v1/options/ws/public`, with no retry:
  one `contracts_for: RB100`, one RB100 `MULTUP` proposal at multiplier 20, and
  one otherwise identical proposal at multiplier 400. Stake/basis/currency are
  fixed to USD 1 / `stake` / USD. No history request, subscription, or buy.
- Store sanitized request/response evidence without proposal IDs, account data,
  or credentials. Maximum stored response volume: 100 KiB.
- No collector, strategy grid, authentication, order, paid source, browser
  trading, CFD platform login, or reserved holdout access.

Expected wall time is under 15 minutes; offline calculations and tests should
take under one minute and negligible memory.

## Decision and stopping rules

- **Range Break resolved:** only if the same-environment observations agree or
  an official source explicitly reconciles their units/context. Otherwise label
  `SPECIFICATION_CONFLICT`. Independently validate the point-quote commission
  threshold, but label net profitability `INSUFFICIENT_EXECUTION_DATA` unless a
  legitimate public source supplies historical entry and close economics,
  stop-out paths, and quote-validity rules.
- **Skew Step diagnostic allowed:** only if the target variant has probabilities
  summing to one, coherent step units, an official statement sufficient to
  define the mechanism, and readily available immutable tick data. If the
  specification is contradictory or data are unavailable, stop before looking
  for conditional patterns and label the applicable conflict/data blocker.
- **Regime experiment allowed:** only if one exact product has decision-time
  bid/ask history and all material CFD economics available without login or
  payment. Midpoint-only data fail this gate.
- Any API rate limit, timeout, unsupported request, or changed product ends that
  branch without retry or parameter expansion.
- `VALIDATED_EDGE` requires a later independently frozen candidate and genuinely
  prospective qualifying window. It cannot be produced by this protocol.

The terminal decision is `BOUNDED_EXPERIMENT_JUSTIFIED` only if one direction
clears every prerequisite for a small public/offline test. Otherwise it is
`NO_CURRENTLY_TESTABLE_EDGE_HYPOTHESIS`, with negative evidence,
specification conflict, and missing execution data reported separately.
