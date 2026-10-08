# Archived Deriv Bot files

Every XML file in this directory is a preserved, disarmed experimental artifact.
The machine-readable [`archive-registry.json`](archive-registry.json) records
its size, SHA-256 and `executionAuthorized: false`. None is a current deployment
candidate, and the current research decision does not authorize importing or
running any of them. A future candidate must be a new version whose exact hash
is bound to qualifying evidence and execution assumptions.

`Codex_DEMO_Guarded_SMA.xml` is a preserved Deriv Bot workspace for the
Volatility 100 (1s) Index. It uses a fixed USD 1 stake, five-tick Rise/Fall
contracts, 20/50 tick SMAs, no martingale, no restart-on-error, and stops after
at most four settled contracts in a run.

The XML cannot force Deriv's account selector to stay on Demo. That limitation
would require an explicit human check in any separately qualified future use;
it is not permission to import or press **Run** now.

`Codex_Browser_Learning_OneTick_Rise.xml` is a schema-validated conditional
one-tick Rise research experiment. It buys one fixed USD 1 Demo contract only when its 10-tick SMA is
above its 20-tick SMA; otherwise it displays `WAIT` and buys nothing. It has no
automatic repeat and both restart-on-error settings are disabled.

The current one-day local exact-flow test rejects the conditional Fall candidate
(49.56% wins versus a 52.63% payout break-even rate after modeling next-tick
entry). It has no matching Demo settlements. The run gate says `WAIT`.

The legacy browser-flow gate is now explicitly retired. It cannot return an
actionable state under the default policy, and the old captured rows are
ineligible because they lack account+contract identity, validated settlement
status, and the exact strategy/configuration hash. A future candidate must pass
the frozen shared gap-aware research path and collect new matching Demo
settlements; do not retrofit identities onto old rows.

The browser-visible workspace is separately saved as **Codex Browser Learning
- One-Shot Gate**. Its automatic `Trade again` block is disabled and both error
restart toggles are off. Because Chrome currently blocks programmatic XML file
upload, that live workspace still contains the original unconditional purchase
block and must remain stopped while `data/browser-bot/run-gate.json` says
`WAIT`. Do not confuse the saved one-shot workspace with the validated
conditional XML.

For the frozen 14-day forward research candidates, see
`FORWARD_V2_BUILDER_PARITY.md`. It records the exact intended BB(20,2) and
RSI(14) Bot Builder mapping and unresolved runtime differences. There is no
importable v2 strategy XML yet, and neither candidate is cleared to Run.

The later three-symbol historical shortlist check is saved at
`../data/reports/shortlist-historical-check-1791165600-1791338400.json`.
It includes 25,920 isolated one-minute offline replays across three entry-delay
assumptions. All three shortlisted five-tick rules failed their frozen
historical evidence gate. These are not Bot Builder XML strategies; the public
proposal payout snapshots are not executable account quotes, and Builder
signal/entry timing parity remains unverified. No new purchase flow is approved
for import or Run. Keep the existing browser workspace stopped and its separate
one-tick run gate at `WAIT`.
