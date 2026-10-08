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

The current strategy is an educational baseline, not a claim of profitability.
Its purpose is to verify the data pipeline and give us something measurable to
improve before connecting a Deriv demo account.

## Run

Node.js 22 or newer is required. No third-party packages are needed.

```powershell
node --test
node src/cli.js symbols
node src/cli.js snapshot
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
its frozen v2 protocol remains an incomplete record. A new `--forward-only`
public collector is running for the user's same-day pilot window
`[2026-10-07T17:00:00Z, 2026-10-08T00:00:00Z)` (8 pm New York cutoff).
Its local watchdog checks process health without Codex usage. The exact safety
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

[`dbot/Codex_DEMO_Guarded_SMA.xml`](dbot/Codex_DEMO_Guarded_SMA.xml) can be
imported into Deriv Bot from **Dashboard > My computer**. It uses Volatility 100
(1s), a fixed USD 1 stake, five-tick Rise/Fall contracts, a 20/50 tick SMA rule,
no martingale, no restart-on-error, and at most four settled contracts per Run.
The XML cannot control Deriv's account selector, so the visible account must say
**Demo account** before Run is pressed.

The live browser workspace is saved in Deriv Bot as **Codex Browser Learning -
One-Shot Gate**. Automatic `Trade again` is disabled and both restart-on-error
settings are off, so one click can produce at most one Demo contract. Its
purchase block remains the original one-tick Rise baseline; it must not be Run
unless the external evidence gate is eligible.

[`dbot/Codex_Browser_Learning_OneTick_Rise.xml`](dbot/Codex_Browser_Learning_OneTick_Rise.xml)
is the schema-validated conditional candidate. It adds a 10/20-tick SMA Rise condition:
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

Before touching Run, rebuild the evidence decision:

```powershell
node src/browser-run-gate.js
```

This single decision command first rebuilds the browser learning summary from
every captured run, then reruns the exact conditional-flow backtest against the
checksummed tick archive, and only then writes the gate decision. It therefore
cannot arm the bot from a stale aggregate report.

`data/browser-bot/run-gate.json` returns `WAIT` unless all requirements pass:
at least 200 browser settlements, the browser's 95% lower win-rate bound above
payout break-even, profit factor of at least 1.10, at least 5,000 untouched API
test observations for the exact conditional flow, a one-tick rate at least one
percentage point above break-even with positive payout-adjusted return, and a
tick archive no older than six hours.
Passing changes the state only to `READY_FOR_SIGNAL`; the conditional bot still
has to see its live SMA condition, the account must visibly say Demo, and the
run remains one contract maximum.

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
