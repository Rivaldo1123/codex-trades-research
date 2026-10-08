# Next research decision — v2

Decision date: **2026-10-08**

Result: **`NO_CURRENTLY_TESTABLE_EDGE_HYPOTHESIS`**

Do not restart the 1HZ100V short-tick indicator search, the stopped historical
collector, or another strategy grid. No strategy is ready for implementation or
Demo validation, and no result is a validated edge.

The decision has three different causes:

1. **Demonstrated narrow failures.** The frozen 12,012-configuration 1HZ100V
   screen failed its predefined rules. The published Skew Step 5 distribution
   also gives zero unconditional raw increment for the naive frequent-direction
   hypothesis. Neither result generalizes to all products or conditional rules.
2. **Specification conflicts.** RB100 capability metadata advertises 20–100x,
   while the same public environment rejects 20x and accepts 400x; the
   commission field's unit is unresolved. Skew Step 4 official narratives and
   tables disagree.
3. **Missing execution data.** Range Break and regime-switch after-cost tests
   require entry/close quotes, bid/ask or sell values, dynamic costs, delay,
   slippage, and adverse stop-out paths that public point history does not
   contain.

## Ranked evidence-acquisition gates

These are gates, not strategy recommendations:

1. **Range Break:** obtain an official multiplier/commission-unit
   reconciliation and a legitimate read-only record of proposal, entry,
   close/sell, commission, stop-out, and final status. Stop if either remains
   unavailable.
2. **Skew Step:** obtain a coherent exact-variant specification and a sanitized
   zero-order bid/ask tick export. Only then preregister one conditional
   statistic and simulated null; do not search patterns adaptively.
3. **Drift/Volatility Switch:** provide one exact product's synchronized
   bid/ask history, symbol specification, dynamic cost/financing, margin,
   stop-out, and timing evidence. Only then run one seven-day causal classifier
   falsifier against a persistence baseline, without a P/L grid.

The first two possible data sources are an official historical execution
interface or a user-provided sanitized demo-platform export. A future
authenticated read-only capture would require separate authorization. Orders
are not required and remain prohibited.

## Reopen rule

Reopen exactly one direction only when every required field for that direction
is present and hashed. Freeze the hypothesis, comparison count, rejection
rule, execution model, data interval, and stopping rule before inspecting
outcomes. Previously viewed data remains development evidence. A future date
range becomes a holdout only after candidate selection and before its data are
observed.
