# Deriv Demo connectivity-loss incident — 2026-10-08

## Decision

The browser run is `ABORTED_CONNECTIVITY_LOSS` and is not strategy-validation
evidence. The final read-only broker check found 12 terminal demo purchases, no
open contract, and aggregate demo P/L of **+$8.51**. That number is retained for
cash reconciliation only; it is not a profitable-strategy result.

## What the broker record established

The read-only interval was `[2026-10-08T21:45:00Z,
2026-10-08T22:36:12Z]`.

| Observed group | Contracts | Stakes | Observed holding time | Demo P/L |
|---|---:|---|---:|---:|
| Five-minute group | 8 | USD 1 each | 300 seconds | +USD 3.30 |
| Reconnect-period group | 4 | USD 2, 4, 2, 2 | 6 seconds | +USD 5.21 |
| Total incident accounting | 12 | Mixed | Mixed | +USD 8.51 |

The four six-second CALL contracts began while a five-minute contract was still
open. They therefore violated both the intended fixed USD 1 stake and the
one-open-contract model. The statement and contract records can establish the
cash outcomes, but the restarted browser workspace did not durably bind every
purchase to the exact intended strategy/configuration identity.

The positive aggregate is consequently rejected as qualification evidence
regardless of its sign. This is an evidence-integrity decision, not a claim that
the observed contracts would have lost under another classification.

## Stop and reconciliation status

- The user reported pressing **Stop** in Deriv Bot.
- Browser UI verification was unavailable because Chrome automation repeatedly
  failed while loading its request-header policy.
- A subsequent authenticated, read-only broker snapshot found all 12 purchases
  terminal and the portfolio empty.
- A second check at `2026-10-08T22:37:45.425Z` still found exactly 12
  purchases, all terminal, and no open contract; no post-stop purchase appeared.
- The ignored local evidence file is
  `data/demo/incidents/connectivity-loss-2026-10-08-closed.json`, 8,137 bytes,
  SHA-256
  `c648cdabd3ffcac08abff044190fb9f52839f998cfbf8e843dbee2a89a1c5ebd`.
  It contains broker identities and is intentionally excluded from Git.
- The local API demo configuration was reset to `executionEnabled: false`; the
  tracked deployment decision independently remains
  `BLOCKED_NO_QUALIFIED_CANDIDATE`.

## Transition

The replacement activity is not another trading bot. It is the frozen,
unauthenticated, public-only
[`range-break-boundary-observation-v1`](../protocols/range-break-observation-v1.json)
session. It records RB100 ticks and a small number of sanitized indicative
MULTUP/MULTDOWN proposals under a strict 18-request ceiling. It cannot buy,
sell, cancel, authenticate, or authorize deployment. Public proposals remain
quotes—not fills, early-close values, or settlements.
