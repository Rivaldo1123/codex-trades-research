# Strategy discovery programme

This directory contains compact, versioned research protocols, benchmarks, and
summaries. Large raw ticks and detailed experiment ledgers remain under
git-ignored data directories.

## Evidence classes

The project keeps five evidence classes separate:

1. Public market-data collection is unauthenticated and never places orders.
2. Historical simulations use public prices plus explicitly assumed payouts and
   delays; they are not observed contract profit.
3. Deriv Bot XML is a disarmed configuration artifact.
4. Authenticated demo execution is a separately guarded action and is not
   authorized by the research commands.
5. Actual settlements count only when account identity, contract identity,
   settlement status, numeric values, and the exact strategy hash are present.

Legacy browser rows missing those identities remain on disk but contribute zero
eligible observations. Reimporting an identical settlement cannot increase the
count, and conflicting duplicates invalidate that identity.

## Verify the frozen development screen

Node.js 24 was used; Node.js 22 or newer is supported. The commands need no
package installation and no credentials.

    node --test
    node src/strategy-search-cli.js status
    node src/research-status-cli.js --strict=public

The frozen protocol is
research/protocols/development-screen-v1.json. It declares 12,012 unique
configurations, three chronological windows, three entry delays, and three
payout assumptions. Payout and delay scenarios are not counted as additional
configurations. The local append-only checkpoint and complete ledgers are under
data/research/development-screen-v1/ and are excluded from Git; the compact
summary and its ledger checksum are under research/results/.

The main command refuses tracked uncommitted code, validates every selected raw
chunk checksum, verifies the exact known source gap, and rejects a checkpoint
from another code commit, protocol, or dataset manifest. Re-running the same
command resumes only missing configuration hashes.

Do not rerun the search merely to verify the published package. The
[`reproducibility guide`](REPRODUCIBILITY.md) defines public-checkout and local
reproduction levels, required hashes and sizes, strict exit codes, restoration
steps, and the known limit on a bit-for-bit strategy replay. The
[`artifact inventory`](reproducibility/development-screen-v1-artifact-inventory.json)
is machine-readable. A public clone normally lacks the ignored ledger and raw
archive; that is reported as limited reproducibility, not a reproduced run or
unexpected corruption.

## Independent v2 audit

The original v1 ledger and result files remain unchanged. The separate
[`development-screen-v1-independent-audit-v2.md`](audits/development-screen-v1-independent-audit-v2.md)
and machine-readable JSON audit reproduce all 12,012 ledger rows, independently
hash the fixed evaluated slice, reconstruct 99 recorded Bot Builder observations,
and replay the predefined top 20 with a trade-weighted clustered test and a
three-day moving-block sensitivity check.

The audit confirms zero qualified configurations, but narrows the conclusion:
the result applies to 1HZ100V Rise/Fall, 1–10-tick durations, fixed unit stakes,
the five signal transformations represented by seven directional families, and
the exposed 30-day development interval. It does not test other symbols,
clock-duration products, every strategy hypothesis, or historical executable
account quotes. No positive result survived independent validation.

Confirmed audit defects are versioned rather than backfilled into v1:

- the original dataset identity hashed a mutable whole archive manifest instead
  of retaining an immutable fixed-slice snapshot;
- the original t test/bootstrap averaged active-day ratios instead of directly
  targeting aggregate profit per unit staked, and resampled days independently;
- evaluated failures and non-shortlisting shared ambiguous reason labels; and
- 84 no-trade minima used negative infinity internally and serialized as JSON
  `null`.

None changes the deterministic result that all 12,012 configurations failed at
least one conservative 0.80-payout window/delay. The audit deliberately did not
launch a new large search.

Verify and recompute the saved ledger summary with the ignored raw archive and
v1 final ledger:

    node --test
    node src/research-status-cli.js --strict=reproduction

This command makes no network request, authenticates no account, and cannot
place an order. It independently checks all saved scenario accounting and the
fixed tick slice, but does not regenerate all strategy signals from prices.

## Product capability and payout feasibility gate

The original
[`product-capability-and-payout-feasibility-2026-10-08.md`](feasibility/product-capability-and-payout-feasibility-2026-10-08.md)
and machine record remain unchanged. The versioned
[`v2 addendum`](feasibility/product-capability-and-payout-feasibility-addendum-v2-2026-10-08.md)
and
[`evidence/blocker matrix`](feasibility/evidence-blocker-matrix-v2-2026-10-08.json)
amend its overly broad terminal label by separating valid negative tests,
specification conflicts, and missing execution evidence. The original audit,
result files, raw probes, manifests, and 12,012-row ledger remain unchanged.

The study compares exactly three mechanisms:

1. Range Break boundary state and resets;
2. Skew Step's published asymmetric increment distribution; and
3. Drift/Volatility Switch persistent clock-time regimes.

Existing files under `dbot/` are archived experimental XML, not implementations
of a qualified candidate. They remain outside this feasibility decision and
must not be Run. A future qualified implementation would require a new version
bound to a frozen specification and its own parity/evidence record.

The current decision is `NO_CURRENTLY_TESTABLE_EDGE_HYPOTHESIS`. The prior
1HZ100V result and naive unconditional Skew Step 5 direction are narrowly
`TESTED_AND_FAILED`. RB100 capability/commission evidence and Skew Step 4
sources contain `SPECIFICATION_CONFLICT`. All proposed after-cost alternatives
have `INSUFFICIENT_EXECUTION_DATA`. This is not evidence that all Deriv
strategies are unprofitable, and uncertainty is not evidence that an edge
exists. No direction is currently `FEASIBLE_FOR_BOUNDED_EXPERIMENT`; no result
is positive or independently validated, and no candidate is ready for Demo.

The original immutable probe made nine unauthenticated public requests. The v2
reconciliation made exactly three more, without retry or a buy path, and
confirmed that the same RB100 environment advertised 20–100x, rejected 20x,
and accepted 400x. This remains a conflict, not a capability workaround. Verify
the saved evidence and current decision locally without making a network
request:

    node src/product-feasibility-probe-cli.js --verify
    node src/range-break-reconciliation-cli.js --verify
    node src/feasibility-calculations-cli.js
    node src/research-status-cli.js
    node src/research-status-cli.js --strict=public
    node --test test/product-feasibility-probe.test.js test/feasibility-addendum.test.js test/research-status.test.js

A new public probe is deliberately opt-in and is not the recommended next
action. The ranked next-decision document lists evidence-acquisition gates,
not recommendations to trade or optimize. The status command is offline and
cannot authenticate, start a collector/search, or place an order.

## Historical expansion

The first expansion target is the exact 90-day UTC interval
[1783483200, 1791259200), ending before the already studied October 6 boundary:

    node src/historical-backfill-cli.js --from 1783483200 --to 1791259200
    Get-Content data/market/historical-backfill-status.json

For a future explicitly authorized recovery, run the same command to resume.
It is not an instruction to restart it now. Raw gzip JSONL chunks are immutable and outside
Git. Each new chunk records the public source, requested boundaries, retrieval
time, row bounds, row count, and SHA-256. The collector has one outstanding
request, a three-second inter-request delay, exponential backoff, and eight
bounded retries. It preserves source gaps and audits exact cadence after
collection.

The public API probe found point history at 90, 180, and 365 days for the three
small-universe symbols, but that is not a guarantee of complete coverage. On
this machine, the observed service limit was 1,000 ticks per request. Extending
the existing 30-day 1HZ100V archive to 90 days is approximately 5,184 requests,
8.8 hours, and about 24 MB of additional compressed ticks plus a small
manifest. Expansion to 6–12 months should begin only after the 90-day archive
passes its row-level audit.

As of the v2 audit on 2026-10-08, no collector process is active. The bounded
90-day invocation stopped after 250 pages/250,000 stored rows when Deriv's
public `ticks_history` endpoint exhausted all eight rate-limit retries. Its
cursor is checkpointed at `1788417199`, with about 4,934,000 older target
seconds still to request. Resume with the same command only after the rate limit
clears; do not treat the present archive as complete 90-day evidence.

## Fresh-checkout safety

Copy config.demo.template.json to config.demo.json only for local setup. The
template is secret-free and has executionEnabled set to false. Tokens belong
only in ignored secrets.local.json. Daily counters use UTC; cooldown uses the
latest relevant trade even across UTC midnight. Pending or uncertain purchases
and known open contracts block another execution until read-only broker
statement/open-contract reconciliation establishes the outcome.

Missing browser evidence or a missing local demo configuration is a WAIT state.
No fixture, synthetic settlement, or copied legacy row may be used to make an
evidence gate pass.
