# Public forward capture handoff (research only)

The active, frozen protocol is `data/market/forward-protocol-2026-10-07-v2.json`, SHA-256 `5e5fbcc219f1071895e259ade4e6f603b43170087fcbea98d60545f6665ccc56`. Its eligible UTC window is `[2026-10-07T15:56:00Z, 2026-10-21T15:47:00Z)` for `1HZ100V`. The initial v1 process failed before subscribing; do not analyze the v1 interval as forward evidence. Never edit the v2 protocol after the window opens.

Collector PID at launch: `10436`. Watchdog PID at launch: `20892`. The collector uses only `wss://api.derivws.com/trading/v1/options/ws/public` in `--forward-only` mode, without historical catch-up or legacy finalization. It does not use a token, account, or order endpoint. The watchdog reads local files only, writes `data/market/live-watchdog-status.json` and an alert JSON on failure, and never restarts the collector. It does not send chat notifications. If either process exits early, do not silently restart or relabel the prospective interval; report the missing span and decide on a newly frozen window.

During collection, read only `data/market/live-collector-status.json`, `data/market/live-watchdog-status.json`, `data/market/collector.lock`, the frozen protocol hash, and the two `data/logs/forward-*-2026-10-07-v2.err.log` files if an error appears. Check matching PIDs, process liveness, `RUNNING`/`WATCHING`, increasing `ticksReceived`/`lastTickEpoch`, timely `updatedAt`, exact public endpoint/mode/symbol, `collectionMode=forward-only`, and `finalization.requested=false`. Check stored-row progress after each 300-tick or five-minute flush. Do not inspect candidate performance while the window remains open.

After the collector reaches `COMPLETED` and the lock is gone, run `node --test`. Then run the exact-window row audit:

```powershell
node src/forward-window-audit-cli.js run --from 2026-10-07T15:56:00Z --to 2026-10-21T15:47:00Z --symbol 1HZ100V
```

An audit must verify genuine rows at the second level, not just manifest chunk ranges. It may explicitly report gaps, but below 99.9% coverage, any checksum failure, or duplicate/conflicting seconds makes the forward result inconclusive. Do not interpolate. Only after this audit may the frozen BB/RSI replay be run once; use the v2 protocol hash and its fixed candidates, delays, payouts, and gate. Preserve the full scenario ledger. Platform indicator/tick-timing parity is a separate prerequisite to a Bot Builder claim. A passing offline gate permits only separate Demo review, never Bot Builder Run or an API order. Otherwise retain `NO_TRADE`/`INCONCLUSIVE`.

No real-money or Demo execution is authorized by this runbook. No account or token use, login, trading, deposit, transfer, bot import, or Bot Builder Run. Do not change the public endpoint or `data/browser-bot/run-gate.json` from `WAIT`.

## In-chat Scheduled monitor (active)

The existing in-chat heartbeat `deriv-history-completion-monitor` was updated and reactivated at a 20-minute cadence as **Deriv forward research monitor**. It returns concise status to this chat at each check, does not call Deriv, and pauses itself after a terminal completion/failure report. It follows this runbook and the frozen protocol; if Bot Builder parity remains unverified, its final result is inconclusive rather than trading approval.
