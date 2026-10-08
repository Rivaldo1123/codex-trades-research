# Same-day public-data pilot: 8 pm New York cutoff

The active pilot protocol is `data/market/forward-protocol-2026-10-07-v3-pilot.json`, SHA-256 `3847b023023dbe5434fb23b71cad4a6d376f42fe26393e605348a1267722979e`. Its exact eligible window is `[2026-10-07T17:00:00Z, 2026-10-08T00:00:00Z)` for symbol `1HZ100V`. The end is **8:00 pm on October 7 in America/New_York**. Do not edit the frozen v3 protocol after eligible collection begins.

The earlier v2 14-day collector failed at 16:31:33 UTC on a transient Windows status-file rename (`EPERM`), before the user requested this shorter cutoff. Its protocol and partial archive remain as an incomplete record and are not relabeled as a successful study. The status writer now has bounded retries. The v3 collector PID at launch is `14860`; local watchdog PID is `1080`. Both are public-data-only. The collector uses only `wss://api.derivws.com/trading/v1/options/ws/public`, `--forward-only`, no authentication, no orders, and no legacy finalization. The watchdog makes no Deriv call and never restarts the collector.

While active, check only the v3 protocol checksum, `data/market/live-collector-status.json`, `data/market/live-watchdog-status.json`, `data/market/collector.lock`, exact PIDs/process health, public endpoint/mode/symbol, advancing ticks, periodic immutable chunk storage, and v3 error logs if a state changes. Do not inspect candidate performance before midnight UTC. If a process or safety lock fails, report the failure and pause monitoring; do not silently restart or fill missing prices.

After the collector reports `COMPLETED`, the lock is gone, and the cutoff has passed, run `node --test` and the exact row-level audit:

```powershell
node src/forward-window-audit-cli.js run --from 2026-10-07T17:00:00Z --to 2026-10-08T00:00:00Z --symbol 1HZ100V
```

The audit must verify genuine seconds, chunk SHA-256, row counts, bounds, and duplicates/conflicts. No interpolation. If coverage is below 99.9%, report `INCONCLUSIVE` for the clean pilot and follow the separately labelled fallback below; if integrity checks fail, stop. If the audit passes, run `node src/pilot-replay-cli.js` once and report every fixed candidate/delay/payout scenario as **development evidence only**. This seven-hour pilot cannot pass the prior 14-day gate or authorize trading. Known Deriv Bot BB/RSI calculation and tick-timing parity questions remain unresolved. A future Bot Builder file must be saved disarmed and separately checked; no Bot Builder Run, Demo order, real order, credential/token/account use, deposit, or transfer is authorized by this pilot.

## Interrupted-window research fallback

A Deriv tick `RateLimit` interruption began after 2026-10-07T19:03:52Z; the live feed later resumed. This interruption must remain visible in the exact-window audit. The 99.9% clean-pilot gate is unchanged. The audit command above writes `data/reports/forward-audit-1HZ100V-1791392400-1791417600.json` even when it exits with code 2 for `INCONCLUSIVE` coverage. A checksum error, duplicate/conflicting row, changed safety lock, or test failure is a hard stop.

If, after the cutoff, the collector has terminated, its lock is gone, tests pass, and the row-level audit reports genuine ticks with missing seconds but no integrity failure, the separate command `node src/interrupted-pilot-replay-cli.js` may run once. It is pinned to the frozen v3 protocol checksum, accepts only chunks labelled `Deriv public live tick subscription`, and reports all 18 fixed scenarios from observed contiguous ticks only. Missing seconds are never invented or patched; indicator lookback resets after each gap, and no hypothetical decision, entry, or settlement crosses a gap or the chronological midpoint. Its report is always `INCOMPLETE_DEVELOPMENT_ONLY`, with all trading permissions false. It does not convert the interrupted pilot into a valid forward result. If the original audit passes its frozen threshold and the collector cleanly completes, use the standard `pilot-replay-cli.js` instead.

Deriv Trader chart CSV or MT5 tick export may be investigated later as **separate, labelled development data** only after timestamp/quote parity checks. Never merge those exports into the frozen v3 archive or use them to change this pilot's audit result.
