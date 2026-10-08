# Deriv Bot Builder research: next testing gate

Created after the October 7, 2026, 8:00 pm New York pilot cutoff. This is a plan for future research, not an amendment to the frozen v3 pilot or its results.

## Evidence already inspected

- Thirty-day historical development window, `1HZ100V`, `[2026-09-06T04:00:00Z, 2026-10-06T04:00:00Z)`: 2,591,993 of 2,592,000 seconds. The seven missing source seconds remain missing. Its saved gap-aware replay tested four SMA rules across 36 payout/delay scenarios; none passed the predefined exploratory screen.
- Seven-hour prospective v3 pilot, `[2026-10-07T17:00:00Z, 2026-10-08T00:00:00Z)`: 24,980 of 25,200 live seconds, 220 missing across three gaps. The original audit and interrupted replay remain unchanged and inconclusive as a clean forward test.
- A separate public `ticks_history` request recovered all 220 missing quotes retrospectively, confirming the live boundary quotes and preserving the original manifest. See `data/reports/retrospective-pilot-recovery-1HZ100V-1791392400-1791417600.json`.
- The separate combined development replay has 25,200 seconds, of which 220 are historical. All 18 fixed Bollinger/RSI delay/payout scenarios have negative modeled average return. See `data/reports/retrospective-pilot-replay-1HZ100V-1791392400-1791417600.json`.

All of those results have been inspected. None of those dates may be described as an untouched final test. The current candidate decision is **NO TRADE**.

## Stage 1: define and verify candidate logic

1. The user expanded the discovery batch to 20 rules. Their definitions and timing assumptions were frozen in `data/market/method-screen-20-v1.json` before replay. Keep every rejected rule in the ledger. Do not search repeatedly until a positive result appears.
2. Confirm local Bollinger/RSI/SMA outputs and decision timing against Bot Builder using a saved set of at least 50 timestamped cases spanning flat, rising, falling, volatile, and threshold-adjacent ticks. Record the platform value, local value, incoming tick, signal, and any mismatch. A strategy using an unverified indicator remains blocked from Bot Builder Run.
3. Use only genuine archived rows. Preserve source labels. Reset lookback at every gap and chronological boundary. No hypothetical decision, delayed entry, or expiry may cross one. Use at most one open hypothetical contract. Count ties as losses.

## Stage 2: development screen

Run one complete, reproducible replay of the fixed batch on the already viewed archive, splitting by UTC into early 70%, middle 15%, and late 15%. The middle and late portions are development checks, not pristine holdouts. Record all candidate/delay/payout results, including zero-trade outcomes. Model 1, 2, and 3 tick processing delays and use actual observed demo payout quotes when available; until then, use +$0.70, +$0.80, and +$0.90 per $1 won with -$1 per loss/tie as sensitivity scenarios.

A candidate can advance only if it has at least 250 hypothetical settlements in each middle and late segment, positive average signed return in both at its pinned base payout for all three delays, and positive late-segment return after a 10-cent lower win payout stress. Otherwise report NO TRADE. Passing this screen only freezes a candidate for new data; it does not authorize Bot Builder Run or an order.

## Stage 3: genuinely new forward test

Before seeing any future validation ticks, save a new immutable protocol and candidate file with SHA-256 hashes, exact UTC start/end, symbol, one selected rule, timing assumptions, minimum coverage, sample size, and decision rule. Collect at least 14 days of new public live ticks after that freeze. Audit every second and chunk; require at least 99.9% genuine live-second coverage, no duplicate/conflicting rows, and no checksum failure. Retrospective history may be saved separately for development but never fills the forward validation archive.

Require at least 1,000 nonoverlapping hypothetical settlements overall and at least 200 in each chronological half. Calculate average signed return at the pinned payout and each delay. Use hourly block bootstrap including zero-trade hours and a 95% family-wise lower confidence bound across the predefined primary comparisons. The lower bound must exceed zero; each half and the lower-payout stress must also have positive point estimates. If any required check fails, the decision is NO TRADE or INCONCLUSIVE as appropriate. Preserve the complete scenario ledger.

## Stage 4: Bot Builder execution check

Only after the data and parity gates pass, prepare a saved, disarmed Bot Builder module. Verify its actual contract type, duration, stake, stop limits, tick timing, payout quotes, and one-open-contract behavior against the tested specification. A separately capped Demo observation batch must record actual settled contracts and compare them with predicted outcomes. No real-money step is implied by a Demo result.

The win-rate target is judged against actual payout and uncertainty. With a +$0.80 win and -$1.00 loss, the mathematical break-even win rate is 55.56% before any further friction. An 80% target is not a parameter to tune against the viewed archive.

## First expanded screen completed

The frozen 20-rule catalog was screened on the viewed 30-day archive, with 180 fixed method/delay/payout scenarios. All middle- and late-segment average modeled returns were negative at each of the three assumed payouts. The provisional top three are the least negative rules, not profitable rules or approved Bot Builder modules. The full ledger and ranking are saved under `data/reports/method-screen-20-1HZ100V-1788667200-1791259200.json`; the readable breakdown is `data/reports/method-screen-20-review.md`. Current decision remains **NO TRADE**. Any new family of methods requires a new named catalog and cannot retroactively turn these viewed dates into a pristine test.
