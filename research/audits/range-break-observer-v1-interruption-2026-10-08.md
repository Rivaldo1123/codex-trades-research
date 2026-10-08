# Range Break observer v1 engineering interruption

The first one-hour observation attempt is preserved as
`FAILED_OBSERVER_ENGINEERING_NOT_RESEARCH_RESULT`. It ran from
`2026-10-08T22:31:59.496Z` until it was deliberately stopped at
`2026-10-08T22:40:38.644Z` after a live defect was verified.

V1 captured 507 valid public RB100 ticks, one capability response, and the
first MULTUP/MULTDOWN proposal pair. Deriv then closed the proposal WebSocket
while it was idle. At the next five-minute snapshot, both quote attempts failed
locally with `Connect to Deriv before making a request.` No order was sent or
placed.

Continuing V1 would have collected useful ticks but mostly failed quote
snapshots, so its exact process was stopped after confirming its PID and command
line. The partial immutable local JSONL remains ignored at:

`data/range-break-observer/2026-10-08T22-31-59-496Z-0324bd1c-3d11-4771-9eb1-306ef9bb418d.jsonl`

- Bytes: `63,607`
- SHA-256: `bf76c1d218bbbd09c5888abc06765ba27dc42525f680659620f59fea7a62e507`
- Strategy evidence eligible: **no**

The versioned
[`v2 protocol`](../protocols/range-break-observation-v2.json) opens one fresh
public connection per two-proposal snapshot cycle. It permits six connections,
zero retries per cycle, and retains the same 18-message ceiling. V1 and its
partial evidence are not rewritten.
