# Frozen v2 candidates: Bot Builder implementation gate

Status: **NOT IMPORTABLE / NOT RUNNABLE**. This is a saved construction and
parity checklist, not a trading bot XML or a claim that either method works.
The v2 forward protocol and its prospective data window are already frozen;
this document does not change either. Keep `data/browser-bot/run-gate.json` at
`WAIT`. Do not press Deriv Bot **Run**, place an order, or use a real account.

## Contract and candidate mapping

Both eventual workspaces must use symbol `1HZ100V`, fixed USD 1 stake,
Rise/Fall, five ticks, no martingale, no automatic `trade_again`, no
restart-on-error, and no restart-buy/sell. A saved XML cannot select or lock
the Deriv account; any later supervised experiment must separately verify
Demo. No purchase block is provided here because runtime parity is unresolved.

| Frozen candidate | Decision on the current tick | Hypothetical contract |
| --- | --- | --- |
| `bb20-2-reversal-5t` | Last quote strictly below the lower BB(20, 2, 2) band, computed from the most recent 20 ticks including that quote | Rise (`CALL`) |
| `bb20-2-reversal-5t` | Last quote strictly above the upper band | Fall (`PUT`) |
| `rsi14-reversal-5t` | Wilder RSI(14) strictly below 30, after the first 14 differences | Rise (`CALL`) |
| `rsi14-reversal-5t` | Wilder RSI(14) strictly above 70 | Fall (`PUT`) |
| Either | No listed condition, unavailable indicator, a data gap, or a prior open contract | `NO TRADE` |

Offline evaluation still models 1-, 2-, and 3-tick processing/entry delay and
win profits of $0.70, $0.80, and $0.90 per $1 stake (loss or tie: -$1).
These are sensitivity assumptions, not a live Deriv payout quote.

## Verified Blockly pieces, but not signal parity

Deriv's [pinned trading-bot-template source](https://github.com/deriv-com/trading-bot-template/tree/598999d9aeafaff770ab15197ad905e03b8dc1e9)
defines `bb_statement` with `BBRESULT_LIST` (`1` upper, `2` lower), child
`input_list` → `ticks`, `period` → `20`, and both standard-deviation
multipliers → `2`. It defines `rsi_statement` with `input_list` → `ticks` and
`period` → `14`. A numerical last-tick comparison uses `tick`, `logic_compare`
with strict `LT`/`GT`, and `purchase` with `CALL`/`PUT`. These IDs are in the
[BB block](https://github.com/deriv-com/trading-bot-template/blob/598999d9aeafaff770ab15197ad905e03b8dc1e9/src/external/bot-skeleton/scratch/blocks/Binary/Indicators/bb_statement.js),
[RSI block](https://github.com/deriv-com/trading-bot-template/blob/598999d9aeafaff770ab15197ad905e03b8dc1e9/src/external/bot-skeleton/scratch/blocks/Binary/Indicators/rsi_statement.js),
[field config](https://github.com/deriv-com/trading-bot-template/blob/598999d9aeafaff770ab15197ad905e03b8dc1e9/src/external/bot-skeleton/constants/config.ts),
[tick blocks](https://github.com/deriv-com/trading-bot-template/blob/598999d9aeafaff770ab15197ad905e03b8dc1e9/src/external/bot-skeleton/scratch/blocks/Binary/Tick%20Analysis/ticks.js),
and the existing local `dbot/Codex_Browser_Learning_OneTick_Fall_Signal.xml`.

However, the frozen offline replay is **not yet equivalent** to Deriv Bot:

1. Deriv's [Bollinger implementation](https://github.com/deriv-com/trading-bot-template/blob/598999d9aeafaff770ab15197ad905e03b8dc1e9/src/external/indicators/indicators/bollinger-bands.js)
   rounds each band to symbol pip size. The frozen `src/forward-replay.js`
   compares against unrounded bands. Near a boundary, trade/no-trade can
   differ. Deriv's [math helper](https://github.com/deriv-com/trading-bot-template/blob/598999d9aeafaff770ab15197ad905e03b8dc1e9/src/external/indicators/utils/math.js)
   confirms population standard deviation, so rounding is the known BB
   difference, not the divisor.
2. Deriv's [RSI implementation](https://github.com/deriv-com/trading-bot-template/blob/598999d9aeafaff770ab15197ad905e03b8dc1e9/src/external/indicators/indicators/relative-strength-index.js)
   returns 0 when both average gain and average loss are zero; the frozen
   replay returns 50. A flat segment can therefore cause Deriv Bot to signal
   Rise while the frozen replay says no trade. This is a material mismatch.
3. Deriv's [tick interface](https://github.com/deriv-com/trading-bot-template/blob/598999d9aeafaff770ab15197ad905e03b8dc1e9/src/external/bot-skeleton/services/tradeEngine/trade/Ticks.js)
   requests the tick list and last tick asynchronously. The tick-list block
   describes the latest 1,000 ticks; the frozen replay carries Wilder RSI
   through the entire contiguous segment. Verify both the live list window
   and whether successive asynchronous reads use the same decision tick.
4. A Deriv Bot purchase can have a processing delay and variable actual
   payout. The replay's fixed delay and payout grid does not establish exact
   execution equivalence or profitability.

## Required steps before creating or importing XML

1. Preserve the frozen v2 protocol and report its result as **offline
   research only**. Do not alter its method after seeing forward results.
2. Build independent, fixed test vectors for the Deriv BB/RSI calculations,
   including pip-size boundary cases, flat quotes, warm-up, exactly 1,000 and
   1,001 ticks, and a missing second. Compare against the frozen replay and
   count every divergent decision.
3. Verify in a non-running Bot Builder workspace that both indicator blocks
   serialize with the expected field/child names and that `ticks` and `tick`
   refer to the same completed observation at purchase-condition time. Save
   and reload XML without pressing **Run**. If the displayed workspace differs
   from the saved XML, stop.
4. If parity requires different indicator rules, preregister a **new** future
   protocol and collect an untouched future interval. Do not relabel the
   already frozen v2 data as its holdout or tune until a favorable result.
5. Only after parity and an independently positive, adequately powered
   forward result: create a separate **disarmed** XML with a constant-false
   purchase guard, disabled purchase blocks, no `trade_again`, fixed $1, and
   a one-contract session cap. Static-test the XML and inspect it after import.
   A later Demo-only Run is a separate explicit gate, not granted by this file.

The current saved conditional SMA XML is a different strategy and does not
implement either frozen v2 candidate.
