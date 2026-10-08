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

## Reproduce or resume the frozen development screen

Node.js 24 was used; Node.js 22 or newer is supported. The commands need no
package installation and no credentials.

    node --test
    node src/strategy-search-cli.js benchmark --count 200
    node src/strategy-search-cli.js run
    node src/strategy-search-cli.js status

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

Reproduce the offline audit with the ignored raw archive and v1 final ledger:

    node --test
    node src/experiment-audit-cli.js

The audit command makes no network request, authenticates no account, and cannot
place an order.

## Historical expansion

The first expansion target is the exact 90-day UTC interval
[1783483200, 1791259200), ending before the already studied October 6 boundary:

    node src/historical-backfill-cli.js --from 1783483200 --to 1791259200
    Get-Content data/market/historical-backfill-status.json

Run the same command to resume. Raw gzip JSONL chunks are immutable and outside
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
