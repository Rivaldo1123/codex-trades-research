# Engineering and research audit — 2026-10-08

## Outcome

NO_RELIABLE_EDGE_FOUND

No configuration passed the frozen development rules. No protected final
holdout was evaluated, no candidate was implemented for Demo, and no order was
authorized or placed.

## Repository and evidence boundary

- Starting commit: da456e10922cee969474174b5cb113f773c8f56d
- Search code commit: 0512ed7823e33264a27cd34b7376986b57a04fd6
- Preserved pre-existing worktree item: untracked zero-byte file named 4
- Public collection, historical simulation, Bot Builder XML, authenticated
  Demo execution, and validated broker settlements remain separate evidence
  classes.
- This task used only unauthenticated public-data reads and offline simulation.

## Verified defect disposition

1. Browser evidence now requires account+contract identity, finite numeric
   fields, won/lost settlement status consistent with profit, and an exact
   64-hex strategy hash. Identical reimports deduplicate; conflicting identities
   are excluded and invalidate integrity. All 99 legacy rows are preserved but
   rejected, leaving zero eligible settlements and a WAIT gate.
2. Demo journals now use pending, uncertain, reconciled, and settled states.
   Purchase or settlement timeouts become uncertain. Restart reconciliation
   reads broker statement/open-contract records; ambiguous or unavailable
   outcomes block and are never blindly retried.
3. Cooldown uses the latest relevant trade across dates. Calendar-day counters
   remain separate and use UTC.
4. Risk reserves pending/uncertain exposure and the next proposal's maximum
   loss. The exact daily-loss boundary is allowed; exceeding it is blocked.
5. The browser replay uses the shared gap-aware sequential execution model.
   Warm-up resets at gaps and split boundaries; decision, delayed entry, and
   settlement cannot cross either; one-open-contract sequencing is enforced.
   The older browser gate is explicitly retired.
6. A secret-free, disarmed config.demo.template.json, useful missing-evidence
   WAIT states, initialization documentation, and offline GitHub Actions CI are
   present.

Final local test result: 151 passed, 0 failed. Tests include repeated-import
deduplication, conflicting duplicates, cross-midnight cooldown, exact loss
boundaries, mocked disconnect/restart reconciliation, gaps, sequential
execution, safe initialization, and deterministic search cardinality. Tests
need no credentials and cannot place orders.

## Data audit and availability

The development dataset is the previously viewed 1HZ100V interval
[1788667200, 1791259200). Its manifest SHA-256 is
da4b901cde363a48d92e2d2ecafabb12a20fdae69c07300fcb070da6ea22599c.
It contains 2,591,993 genuine seconds of 2,592,000 expected (99.9997299%).
The seven absent source seconds [1789085201, 1789085208) remain absent; no
quote was interpolated.

Read-only public probes returned point history near 90, 180, and 365 days for
1HZ100V, 1HZ50V, and R_100. This proves point availability, not complete
coverage. contracts_for reported CALL/PUT tick durations from 1 through 10
ticks for those symbols. The initial universe remains 1HZ100V because the host
has 4 GB RAM and only this symbol has the existing audited 30-day base.

## Compute benchmark

- Host: 2 cores / 4 logical processors, 4 GB RAM, about 94 GB free storage
- Runtime: Node.js v24.19.0; no third-party packages
- Representative batch: 200 configurations
- Measured evaluation: 0.01570 seconds per configuration
- Preparation: 21.33 seconds for checksum audit and cached features
- Projected total: 209.96 seconds
- Actual main invocation: 280.04 seconds plus 13.86 seconds preparation
- Cached features: 74,131,220 bytes
- Benchmark RSS: 236,244,992 bytes; completion RSS: 486,428,672 bytes
- Bounded worker count: one

The public history service returned 1,000 rows to a bounded request for 5,000.
At the conservative collector pacing, extending 30 to 90 days is estimated at
about 5,184 requests, 8.8 hours, and 24 MB additional compressed ticks.

## Executed search

- Strategy families: 7
- Unique valid configurations: 12,012 planned / 12,012 completed
- Duplicate configurations: 0
- Invalid grid combinations rejected before quota: 3,888
- Failed trials: 0
- Chronological windows: 3
- Entry delays per window: 3
- Payout assumptions per delay: 3
- Completed backtest runs: 324,324
- Development-qualified: 0
- Frozen finalists: 0

Every configuration failed the 0.80-payout stress-expectancy rule and the
Bonferroni-adjusted evidence rule. The highest robustness-ranked configuration
was zscore_reversion:d2629ff69aac6402:

- duration 10 ticks; lookback 8; z threshold 2.0
- minimum volatility 0.25 bps; volatility window 30
- 2,597 trades across 30 active days
- base average net profit per unit staked: -0.0218329
- profit factor: 0.955
- worst window/delay average at +0.80/-1.00: -0.0894614
- worst severe stress at +0.70/-1.00: -0.140047
- maximum drawdown: 80.5 stake units
- longest losing streak: 9
- Bonferroni-adjusted p-value: 1
- 99% UTC-day block-bootstrap lower bound: -0.124071
- positive fraction among ten nearest settings: 0

Some sparse settings showed positive base-period averages, but they had as few
as 45 trades and failed payout/delay stress, window consistency, multiplicity,
and bootstrap rules. They are not candidates.

The append-only local final ledger is
data/research/development-screen-v1/ledger.final.jsonl: 115,485,863 bytes,
12,012 rows, 12,012 unique configuration hashes, SHA-256
23da90a773cdffb77c1f71187083985f4cf2916a38eb477875dfbdffe58dccd3.
It remains outside Git; the compact JSON summary records the same checksum.

## Reproduce and resume

    node --test
    node src/strategy-search-cli.js benchmark --count 200
    node src/strategy-search-cli.js run
    node src/strategy-search-cli.js status

The exact 90-day collection command is:

    node src/historical-backfill-cli.js --from 1783483200 --to 1791259200

Re-running it resumes from the oldest archived tick. Status is written after
every page to data/market/historical-backfill-status.json.

## Bounded next research batch

Do not retune these 12,012 configurations against the viewed window. First
finish and audit the 90-day backfill and preserve the prospective
[2026-10-09, 2026-11-08) final window without performance inspection.

A genuinely different next development batch should be preregistered and
limited to at most 2,400 configurations: calibrated linear/logistic direction
models using lagged returns, realized volatility, and time-of-week features,
fit separately inside rolling walk-forward training folds. It should retain
fixed unit stakes, 1–10 tick supported durations, the same payout/delay stress
grid, purging, day-block uncertainty, and full multiplicity accounting. It
must not inspect the prospective final window unless at most three frozen
finalists first pass all development rules.
