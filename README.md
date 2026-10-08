# Codex Trades

This project contains two independent learning branches plus guarded execution:

- the **API branch**: public research snapshots, a checksummed tick archive,
  leakage-controlled datasets, five-tick backtests, and guarded demo outcomes;
- the **Bot Builder branch**: saved Deriv Bot workspaces and recorded browser
  demo settlements; and
- a guarded **Deriv demo-only executor** for small virtual-funds experiments.

The demo client accepts only Deriv's `/ws/demo` endpoint. It rejects the
real-money endpoint, uses a fixed USD 1 stake, permits one open contract, caps
activity at four trades per UTC day, enforces a 15-minute cooldown, and keeps
martingale and automatic strategy mutation disabled.

UTC is also the documented timezone for the daily-loss counter. The risk gate
reserves the next contract's maximum loss plus pending/uncertain exposure.
Cooldown uses the latest relevant trade across dates. Purchase timeouts are
journaled as uncertain and are never blindly retried; read-only statement and
open-contract reconciliation must establish the outcome first.

The current strategy is an educational baseline, not a claim of profitability.
Its purpose is to verify the data pipeline and give us something measurable to
improve before connecting a Deriv demo account.

## Current execution and research decision

The [2026-10-08 v3 execution and strategy-path audit](research/audits/execution-and-strategy-path-audit-v3-2026-10-08.md)
verified and corrected the actual order lifecycle. `executionEnabled: true` is
no longer sufficient: `tradeDemoOnce` first requires the tracked deployment
decision and a checksum-bound evidence package that exactly matches the
candidate, strategy configuration, product terms, duration, stake, executor
source and execution assumptions. The current
[`active-demo-candidate.json`](research/deployment/active-demo-candidate.json)
contains `NO_QUALIFIED_CANDIDATE`, so the programmatic and CLI strategy path is
blocked before any broker connection or purchase. The low-level purchase method
re-verifies the same package immediately before submission, and the generic
request method rejects order-bearing payloads. There is no generic bypass.

Restart reconciliation now binds account and intended contract terms, exhausts
bounded statement pages, and validates the broker contract before assigning it
to an intent. Immediate and recovered settlements use the same strict validator.
The append-only journal rejects identity-less events, illegal state transitions
and backwards chronology; accepted numeric strings are normalized before risk
accounting.
Entry-day counts are separate from settlement-day UTC P&L, and an approved
collection specification—not the collector checkpoint—defines the 90-day
archive target. Focused tests exercise lost responses, wrong accounts and
contracts, malformed settlements, pagination failures, journal failures,
cross-midnight losses, stale quotes and concurrent attempts without credentials
or orders.

The current research decision remains
`NO_CURRENTLY_TESTABLE_EDGE_HYPOTHESIS`. Range Break boundary state is the
strongest mechanism worth resolving, but it is not yet a testable net-profit
hypothesis: product limits conflict and historical contract-specific close
values, commission semantics, processing delay and stop-out paths are missing.
No new strategy search or midpoint-only profitability backtest was run. The
single next evidence step is to resolve those terms and establish a legitimate
timestamped entry-and-close valuation source; if that cannot be done, stop this
direction rather than add indicators.

### Connectivity-loss incident and Range Break observation

A browser Bot session that loses connectivity is not a continuous experiment.
Do not reconstruct its counters from memory or restart it under the same session
identity. The read-only incident command retrieves covered demo statement buys,
checks every available broker contract, reports open or unresolved identities,
and saves the result only under ignored `data/demo/incidents/`. It cannot buy,
sell, cancel, or qualify a strategy:

```powershell
node src/demo-incident-reconcile-cli.js `
  --from 2026-10-08T21:45:00Z --to now `
  --output data/demo/incidents/connectivity-loss-2026-10-08.json
```

Broker records recovered by time are explicitly unbound to the browser
workspace's exact configuration unless that identity was durably recorded at
purchase time. They can reconcile cash outcomes, but cannot become strategy
validation evidence after the fact. The 2026-10-08 connectivity incident is
preserved in a sanitized
[`audit record`](research/audits/demo-connectivity-incident-2026-10-08.md): its
positive demo accounting total was rejected because the restarted browser
produced mixed stakes, mixed horizons, and overlapping exposure.

The frozen
[`range-break-observation-v2`](research/protocols/range-break-observation-v2.json)
protocol is the next bounded evidence step. It runs for at most one hour, records
at most 5,000 public RB100 ticks and 12 indicative MULTUP/MULTDOWN proposals,
uses at most 18 public requests including bounded reconnects, and stores an
immutable checksummed local session. It has no authentication or order path:

```powershell
node src/range-break-observer-cli.js run
node src/range-break-observer-cli.js status
```

This observer measures capability, cadence, interruptions, point-price paths,
and indicative proposal fields. It does not observe fills, early-close values,
settlements, or historical executable profitability. Its output therefore
cannot authorize Bot Builder or API execution.

The original v1 observation attempt is preserved in a separate
[`engineering-incident record`](research/audits/range-break-observer-v1-interruption-2026-10-08.md).
Its proposal connection went idle and closed before the second snapshot pair.
V2 uses one fresh bounded connection per pair, with no retries and no increase
to the public-message ceiling.

## Frozen substantial strategy screen

The current structured programme is documented in
[`research/README.md`](research/README.md). Its v1 protocol freezes 12,012
distinct configurations across seven families before the main run, with
324,324 separate chronological-window, entry-delay, and payout evaluations.
All currently archived history is development-exposed; the protected final
window is prospective, so no historical result alone can authorize Demo.

The older browser-flow gate is retired and always returns `WAIT` under its
default policy. Its legacy 99 rows lack account ID, contract ID, settlement
status, and an exact strategy hash, so they now count as zero eligible
settlements. This is deliberate evidence rejection, not data deletion.

The completed v1 screen evaluated all 12,012 configurations and 324,324
window/stress runs with zero failed trials. None passed the frozen development
rules; the recorded outcome is `NO_RELIABLE_EDGE_FOUND` for that narrow screen.
An independent v2 audit reproduced the scenario counts and found no qualifying
candidate, while also identifying provenance, inference, and reporting defects
that limit the broader interpretation. It does **not** establish that every
Deriv product or strategy is unprofitable. See the
[`independent audit`](research/audits/development-screen-v1-independent-audit-v2.md),
[`research/results/development-screen-v1-summary.md`](research/results/development-screen-v1-summary.md)
and the original engineering report in `research/results/`. The original v1
artifacts remain unchanged; the v2 audit is a separate versioned evaluation.

## Read-only product feasibility gate

The original
[`product capability and payout feasibility study`](research/feasibility/product-capability-and-payout-feasibility-2026-10-08.md)
is preserved. Its separate
[`v2 addendum`](research/feasibility/product-capability-and-payout-feasibility-addendum-v2-2026-10-08.md)
corrects the evidence labels without rewriting the original report. The
machine-readable
[`evidence/blocker matrix`](research/feasibility/evidence-blocker-matrix-v2-2026-10-08.json)
records exact scope, assumptions, hashes, sources, data requirements, and
blockers.

The current decision is `NO_CURRENTLY_TESTABLE_EDGE_HYPOTHESIS`, not a claim of
universal unprofitability. The completed 1HZ100V screen and the naive
unconditional Skew Step 5 frequent-direction idea are narrow
`TESTED_AND_FAILED` results. Current RB100 multiplier metadata/proposal behavior
and Skew Step 4 publications have `SPECIFICATION_CONFLICT`. Range Break,
conditional Skew, and regime-switch net simulations have
`INSUFFICIENT_EXECUTION_DATA`. No direction is presently
`FEASIBLE_FOR_BOUNDED_EXPERIMENT`, no edge has independent validation, and no
trading implementation is ready.

| Evidence layer | Current verified status |
|---|---|
| Software correctness | Offline regression coverage passes locally; this validates code invariants, not profitability. Hosted CI status must be checked separately. |
| Development research | The tracked summary reports that the frozen 12,012-configuration 1HZ100V screen found no qualifying candidate within its narrow scope. Local status separately reports whether its ignored ledger and raw archive were actually verified or reproduced. |
| Historical execution validation | Absent: public point prices are not historical account-specific executable quotes or settlements. |
| Prospective validation | Not started for a qualified candidate; the earlier calendar range is `NOT_ASSIGNED`, not an untouched holdout by date alone. |
| Demo implementation | No qualified implementation exists. Existing XML is archived experimental material and the browser gate is `WAIT`. |

The v2 reconciliation added exactly three unauthenticated public requests with
no retry or buy path. It confirmed that the same RB100 public environment
advertised 20–100x in `contracts_for`, rejected an otherwise fixed 20x proposal,
and accepted 400x. It did not resolve commission units or historical close
economics. The Skew and cost calculations are offline. Verify all current
status without making a network request:

```powershell
node src/product-feasibility-probe-cli.js --verify
node src/range-break-reconciliation-cli.js --verify
node src/feasibility-calculations-cli.js
node src/research-status-cli.js
node src/research-status-cli.js --strict=public
node --test test/product-feasibility-probe.test.js test/feasibility-addendum.test.js test/research-status.test.js
```

Normal status reports limitations and exits successfully. `--strict=public`
fails on required tracked-evidence problems while allowing the large ignored
ledger/archive to be absent. `--strict=reproduction` requires those local
artifacts, independently recomputes ledger accounting and published totals, and
verifies the fixed market-data slice. It still does not claim a full strategy
signal rerun. See the
[`research reproducibility guide`](research/REPRODUCIBILITY.md) and
[`machine-readable artifact inventory`](research/reproducibility/development-screen-v1-artifact-inventory.json).

The authorized 90-day expansion is checkpointed but incomplete. On 2026-10-08
the public backfill stopped itself after all eight bounded `ticks_history`
rate-limit retries: this invocation stored 250,000 rows across 250 pages, the
cursor is `1788417199`, and process inspection during the v2 addendum found no
collector process active. Approximately 4,934,000 older target seconds remain.
It is deliberately stopped. The existing recovery command below is documented
for a future explicitly authorized resume only; do not run it automatically or
change the frozen boundaries:

```powershell
node src/historical-backfill-cli.js --from 1783483200 --to 1791259200
```

The present archive is not represented as a completed 90-day evaluation.

## Run

Node.js 22 or newer is required. No third-party packages are needed.

```powershell
node --test
node src/cli.js symbols
node src/cli.js snapshot
node src/strategy-search-cli.js status
node src/research-status-cli.js
node src/research-status-cli.js --strict=public
```

`node src/cli.js snapshot` downloads recent one-minute candles, calculates a 20/50
simple-moving-average crossover, performs a chronological 70/30 train/test
split, and writes a JSON report under `data/reports/`.

If Deriv temporarily rate-limits candle history, the snapshot command retries
at 5, 15, and 30 seconds, then fails visibly instead of looping indefinitely.

The configured Volatility 100 (1s) symbol is only a connectivity and research
default. It has not been selected as a suitable instrument for live trading.

## Tick archive and training data

The data collector calls only Deriv's public `ticks_history` API. Each run gets
the newest page first, repairs any internal archive gap, and then backfills older
ticks toward a 365-day target. Raw observations are kept as immutable gzip JSONL
chunks under `data/market/1HZ100V/raw/`; `manifest.json` records each chunk's
range and SHA-256 checksum. The older bounded command has a 60-page per-run
budget, spaced one second apart; it is not scheduled.

```powershell
npm run data:collect
npm run data:status
npm run data:dataset
npm run data:backtest
```

For uninterrupted public-data capture, the scheduler-free live collector uses
Deriv's unauthenticated tick subscription and periodically writes immutable
chunks. Its legacy mode uses public history at startup, after reconnect, and at
shutdown; `--forward-only` makes no catch-up history requests, because the
new prospective window is checked later with a separate row-level audit.
Endpoint-lock, archive, and checksum failures remain fatal.

```powershell
node src/live-data-cli.js status
```

`--until` may be at most 14 days ahead. Legacy `--finalize-research` rebuilds
the old dataset/backtest/browser gate; it must **not** be used for the current
forward test. This is an ordinary background process, not a Windows or Codex
schedule, so a reboot would interrupt it.

The earlier 14-day forward collector failed on a Windows status-file rename;
its frozen v2 protocol remains an incomplete record. The later `--forward-only`
public collector ran for the user's same-day pilot window
`[2026-10-07T17:00:00Z, 2026-10-08T00:00:00Z)` (8 pm New York cutoff).
That pilot is complete; its saved local watchdog evidence required no Codex
usage. The exact safety
boundaries and post-capture instructions are in
[`data/market/forward-runbook-2026-10-07-v3-pilot.md`](data/market/forward-runbook-2026-10-07-v3-pilot.md).
The 19:03 UTC rate-limit interruption will remain in its audit. If the clean
coverage gate fails, `node src/interrupted-pilot-replay-cli.js` is a separate
post-cutoff, gap-aware development-only fallback; it does not repair the pilot.
This is exploratory research, not account/API trading or Bot Builder Run.

For this historical study, use the separate resumable, public-only backfill.
The exact 14 completed New York days are September 22 through October 5, 2026,
represented by the half-open UTC interval `[1790049600, 1791259200)`. The
historical request always supplies both boundaries: Deriv defaults an omitted
tick-history `start` to one day ago, which can silently defeat older paging.
Responses outside the requested range are rejected. The job stores immutable
chunks, updates `data/market/historical-backfill-status.json` after every page,
and retries temporary rate limits with a cool-down. It does not subscribe to
live ticks, use an account token, or place any order.

```powershell
npm run data:history -- --from 1790049600 --to 1791259200
Get-Content data/market/historical-backfill-status.json
```

The process is a finite download, not a schedule: it exits when the range is
fetched and audited, or when it detects a fatal archive/API error. It can be
restarted with the same command after an interruption and resumes before the
oldest archived tick after a graceful stop. It does not survive a PC restart
automatically; after an abrupt stop, confirm that no collector is active before
removing a stale `data/market/collector.lock`. The
older `data:collect`, `data:dataset`, and `data:backtest` commands are not the
two-week Bot Builder study: their newest-one-million-tick cap may omit the
earliest days and include today.

An ordinary local Node watcher waits for backfill `COMPLETED` and then runs the
offline Bot Builder study once. It records its own state in
`data/market/historical-study-status.json`. If the backfill fails or finishes
with missing seconds, the watcher stops without publishing a study. It makes no
Deriv or Codex API call. The study can also be rerun manually after completion:

```powershell
npm run data:historical-study -- --from 1790049600 --to 1791259200 --symbol 1HZ100V
```

It verifies chunk checksums and every second in the exact window before
writing a report under `data/reports/`. Missing ticks produce `INCOMPLETE`
instead of a misleading result. It compares fixed conditional one-tick
Rise/Fall candidates with a next-tick entry and assumed +$0.90/-$1.00 payout,
uses chronological training/validation/test periods, and scores the selected
candidate once on the untouched test period. The result is research, not
permission to run Bot Builder; actual Demo settlements must be evaluated
separately.

`data:dataset` uses up to the newest one million archived ticks. It writes
compressed CSV train, validation, and test files with chronological 70/15/15
splits. Features use only the current or earlier tick, and 60 ticks are purged
at split boundaries so no configured future label crosses into the next split.

`data:backtest` evaluates multiple SMA windows and horizons. Parameters are
selected on validation data, then measured once on the untouched test segment.
The five-tick row is the one aligned to the current demo contract duration.
These are directional-price tests only; they omit contract payout and execution
effects and therefore do not establish profitability.

## Browser Deriv Bot

All XML files currently under `dbot/` are archived experimental artifacts, not
qualified implementations. They are preserved for reproducibility and must not
be imported or Run as part of the current research decision. The external gate
is `WAIT`, the tracked API demo template has `executionEnabled: false`,
and any future qualified implementation must be a new version tied to its own
frozen strategy/configuration hash and evidence record. Their exact hashes and
explicit `executionAuthorized: false` state are in
[`dbot/archive-registry.json`](dbot/archive-registry.json).

[`dbot/Codex_DEMO_Guarded_SMA.xml`](dbot/Codex_DEMO_Guarded_SMA.xml) is preserved
in Deriv Bot's importable workspace format, but it must not be imported or Run
under the current decision. It historically used Volatility 100 (1s), a fixed
USD 1 stake, five-tick Rise/Fall contracts, a 20/50 tick SMA rule, no martingale,
no restart-on-error, and at most four settled contracts per Run. The XML also
cannot enforce Deriv's account selector, which is an unresolved parity and
safety limitation rather than a current operating instruction.

The live browser workspace is saved in Deriv Bot as **Codex Browser Learning -
One-Shot Gate**. Automatic `Trade again` is disabled and both restart-on-error
settings are off, so one click can produce at most one Demo contract. Its
purchase block remains the rejected one-tick Rise baseline. The external gate
is not eligible, so the saved workspace must not be Run.

[`dbot/Codex_Browser_Learning_OneTick_Rise.xml`](dbot/Codex_Browser_Learning_OneTick_Rise.xml)
is an archived schema-validated conditional experiment. It adds a 10/20-tick SMA Rise condition:
if the fast SMA is not above the slow SMA, it displays `WAIT` and buys nothing.
It uses a fixed USD 1 stake, disables restart-on-error, and contains no
`Trade again` block. Browser upload remains blocked unless the user enables the
Chrome extension's file-URL permission, so the local XML and the saved live
one-shot workspace are documented separately rather than treated as identical.

Captured Bot Builder transactions live under `data/browser-bot/runs/`. Rebuild
their aggregate report with:

```powershell
node src/browser-learning.js
```

The report at `data/browser-bot/learning-report.json` tracks observations,
wins, losses, net virtual profit, profit factor, streaks, and a 95% Wilson
interval. Bot Builder one-tick results and API five-tick results remain separate;
their raw win rates are not pooled because they measure different contracts.

The retired external evidence decision can be rebuilt offline; it cannot grant
current Run permission:

```powershell
node src/browser-run-gate.js
```

This single decision command first rebuilds the browser learning summary from
every captured run, then reruns the exact conditional-flow backtest against the
checksummed tick archive, and only then writes the gate decision. It therefore
cannot arm the bot from a stale aggregate report.

`data/browser-bot/run-gate.json` now returns `WAIT` because the legacy path is
retired. Its former sample, confidence, profit-factor, API-edge, and freshness
checks remain visible for forensic reproducibility, but cannot arm a bot. New
evidence must also be deduplicated by account+contract identity, have validated
numeric settlement fields/status, and match the exact strategy hash.

This is the provisional gate for the earlier one-tick Fall candidate. Its
six-hour archive freshness rule does not substitute for the requested study of
the preceding two completed weeks. A new Bot Builder strategy needs its own
historical and matching Demo evaluation before this gate can authorize it.

The current one-day exact-flow test rejects this candidate after modeling the
contract's next-tick entry: 3,644 wins and 3,709 losses across 7,353 qualifying
test observations (49.56%), with -$0.0584 simulated profit per $1 contract
under the observed +$0.90/-$1.00 payout. This still omits variable processing
delay and real quote changes. The conditional candidate has no matching Demo
settlements; prior unconditional Fall batches cannot be used as its forward
evidence. The gate is `WAIT`. The generated `data/browser-bot/run-gate.json`
is the authoritative, refreshable result.

## Public research safety lock

The public client rejects every WebSocket address except Deriv's public,
unauthenticated market-data endpoint. Public collection remains separate from
authenticated demo trading and never places an order. No recurring Codex or
Windows schedule is required.

## Demo connectivity scaffold

`config.demo.json` controls an authenticated Deriv demo account. Its adapter
validates the returned OTP URL and refuses every endpoint except
`/trading/v1/options/ws/demo`. There is no deposit, withdrawal, transfer, or
real-account execution path.

A fresh checkout intentionally has no local demo configuration or settlement
evidence. Copy `config.demo.template.json` to the ignored
`config.demo.json` only when needed; the template is secret-free and disarmed.
Missing local evidence/configuration produces a useful `WAIT`/blocked state
and must never be filled with manufactured observations.

After creating a trade-scoped PAT in Deriv, run `node src/setup-server.js` and
open the printed `127.0.0.1` URL to save it locally. The resulting
`secrets.local.json` is excluded from Git.

```powershell
npm run demo:status
npm run demo:plan
npm run demo:trade-once
npm run demo:learn
```

`demo:plan` authenticates and prints the latest signal without buying.
`demo:trade-once` requires an explicit demo confirmation flag (included in the
npm script), re-checks the portfolio and daily risk limits, buys one USD 1
five-tick Rise/Fall contract, waits for settlement, and updates the journal and
learning report under `data/demo/`.

## Learning loops

The initial strategy is a 20/50 simple-moving-average direction baseline. Its
historical evidence is currently inconclusive, so every demo outcome is treated
as a forward experiment. The learning report measures settled trades, win rate,
average virtual profit, and results by direction. It never changes strategy
parameters automatically.

The Bot Builder branch independently records actual Demo contract settlements.
An 80% win rate is a research target, not a promise or a parameter to optimize
against repeatedly; any candidate must still succeed on untouched forward data.

## Thirty-day Bot Builder research checkpoint

The requested 30-day public-data window for `1HZ100V` is
`[2026-09-06T04:00:00Z, 2026-10-06T04:00:00Z)`. The archive contains
2,591,993 genuine ticks against the 2,592,000 one-second target. The seven
seconds from `2026-09-11T00:06:41Z` through `00:06:47Z` are absent even in a
bounded repeat request to Deriv's public history endpoint. The one-shot repair
command refused to invent quotes or append partial data, so
`historical-backfill-status.json` remains `INCOMPLETE`.

`node src/offline-replay-cli.js` is the strict full-window replay and refuses
this archive. `node src/offline-replay-gap-cli.js` is a separate exploratory
diagnostic: it verifies chunk hashes and the exact known gap, resets SMA
lookback after the gap, and excludes decisions, entries, or settlements that
could cross it. It evaluates four predeclared SMA/direction/duration rules
under one-open-contract sequencing, three entry-delay assumptions, and three
win-payout assumptions. All 36 scenarios are logged in the saved report.
No segment is an untouched holdout, and historical ticks are not executable
contract quotes.

The October 7 gap-aware report under `data/reports/offline-gap-replay-*.json`
returned `NO_TRADE`: every candidate had negative payout-adjusted average
returns in the middle and late chronological segments under the base
`+$0.90/-$1.00` assumption, and none passed the delay/payout stress screen.
This report does not arm the Bot Builder workspace or authorize pressing Run.
The next research step is genuinely new forward data and separately observed
Demo execution/quotes, not tuning these viewed 30 days until a positive rule
appears.

## October 7 short-pilot recovery and next gate

The 8 pm New York v3 pilot finished with 24,980 of 25,200 genuine live seconds;
its original audit and interrupted replay remain unchanged. Running
`node src/retrospective-pilot-recovery-cli.js` once fetched the 220 absent
seconds from public `ticks_history` into a separate report after checking live
boundary quotes. `node src/retrospective-pilot-replay-cli.js` then combined those
quotes in memory for a separately labelled development replay. All 18 fixed
scenarios had negative modeled average returns. The current decision is
`NO_TRADE`; the evidence and next gates are recorded in
`data/reports/research-decision-2026-10-07-v4.json` and
`data/market/research-protocol-v4.md`. Neither command modifies the live archive.

The next requested research batch defines 20 indicator rules in
`data/market/method-screen-20-v1.json` and runs them with
`node src/method-screen-20-cli.js`. Its 180-scenario ledger and
`data/reports/method-screen-20-review.md` show that none passed the development
screen. The three highest-ranked rules are all modeled losers; the current
decision is `NO_TRADE` in `data/reports/research-decision-2026-10-07-v5.json`.

No demo result should be used to justify real-money trading. The project has no
real-money promotion command.
