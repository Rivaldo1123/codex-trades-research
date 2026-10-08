# Research reproducibility

This guide covers the frozen `development-screen-v1` result and the later
feasibility evidence. It does not authorize trading, collection, or a new
search.

The reported development finding is narrowly scoped: no configuration
qualified among 12,012 frozen 1HZ100V Rise/Fall configurations on the exposed
30-day development slice under the declared payout and delay assumptions. The
alternative-product work records specification and execution-data blockers.
Neither finding establishes that every Deriv strategy is unprofitable, and no
deployment-ready bot or validated profitable strategy exists.

## Prerequisites

- Git.
- Node.js 22 or newer. The original search and current verification were run
  with Node.js 24.
- About 250 MiB of free space when restoring the ledger and evaluated raw
  archive, plus temporary space for a separate worktree if attempting a code
  replay.
- No package installation, credentials, Deriv authentication, or network call
  is needed for the offline checks.

The machine-readable inventory is
[`development-screen-v1-artifact-inventory.json`](reproducibility/development-screen-v1-artifact-inventory.json).
It is the canonical list of paths, byte sizes, SHA-256 values, availability,
and strict-verification requirements used by the status command.

## Verification levels

The status interface deliberately separates four things:

1. **Published finding:** what the tracked summary reports.
2. **Artifact availability and integrity:** whether expected bytes exist and
   match their recorded size and SHA-256.
3. **Ledger-summary recomputation:** whether every saved scenario's accounting,
   cardinality, rejection totals, and provenance can be recalculated from the
   original ledger.
4. **Strategy replay:** regenerating the ledger's decisions and outcomes from
   raw ticks and the original search code.

A matching checksum proves file identity only. It does not by itself prove that
the calculations inside the file are correct.

### Normal status

```powershell
node src/research-status-cli.js
```

Normal mode is read-only, offline, and exits `0` after producing a status even
when evidence is missing or mismatched. Consumers must inspect the top-level
`evidenceHealth` object. Normal mode verifies file hashes but deliberately does
not perform the slower ledger/accounting recomputation or fixed-slice row
audit; those fields say `NOT_RUN` and `NOT_CHECKED`.

The command never starts a collector or search, authenticates, places an order,
or grants execution readiness. `implementationReadiness` remains blocked.

### Strict public-package verification

```powershell
node src/research-status-cli.js --strict=public
```

This is suitable for ordinary public-checkout CI. It requires the tracked
protocol, summary, audits, feasibility reports, decision matrix, and sanitized
public probes listed as `public-package` artifacts in the inventory. The large
ignored ledger and raw tick archive are not required, so their absence in a
normal clone is expected rather than corruption.

### Strict local reproduction verification

```powershell
node src/research-status-cli.js --strict=reproduction
```

This additionally requires the exact ledger and evaluated raw archive. It:

- verifies every required artifact size and SHA-256;
- parses all 12,012 ledger rows;
- independently recomputes every scenario payout/accounting field;
- verifies configuration/trial uniqueness, family counts, qualified count,
  rejection totals, and protocol/dataset/code provenance;
- verifies every selected archive chunk hash, row count, bounds, ordering, and
  duplicate exclusion;
- reconstructs the exact chronological slice, preserving the seven genuine
  missing seconds; and
- compares the fixed-slice descriptor and content hashes with the independent
  audit.

This is a **partial reproduction**. It recomputes published summaries from the
ledger and verifies the market-data input, but it does not rerun all strategy
signals from tick prices.

### Exit codes

| Mode | Exit | Meaning |
|---|---:|---|
| Normal | 0 | Status was emitted; evidence limitations may still be present. |
| Strict | 0 | Every artifact and calculation required by that strict mode passed. |
| Strict | 2 | Required evidence is missing, malformed, unavailable, or a required recomputation was not possible. |
| Strict | 3 | A size/hash mismatch or other integrity failure was detected. |
| Any | 1 | Invalid command usage or an unexpected program failure. |

`--strict` is an alias for `--strict=public`. Existing no-argument callers keep
their read-only, status-reporting behavior.

### Status schema compatibility

The command now emits `schemaVersion: 2`. The no-argument command and the
existing top-level decision, readiness, classifications, blocker, holdout,
`dataCompleteness`, `evidenceVerification`, process, and safety fields remain.
Callers should account for these intentional refinements:

- development-screen `status` no longer says complete when the ledger is
  missing, malformed, unverifiable, or mismatched;
- evidence entries use stable inventory `id` values and the explicit states
  `VERIFIED`, `MISSING`, `HASH_MISMATCH`, `MALFORMED`, or `UNVERIFIABLE`;
- historical checkpoint details are separated into `snapshot`, `paging`,
  `verification`, and `processObservation`, and completion has the explicit
  states documented below;
- `evidenceHealth` is the automation-oriented top-level summary; and
- `safety.executionAuthorized` is always `false` and the preserved
  `NOT_READY_NO_VALIDATED_EDGE` readiness remains blocked.

The strict flags are additive. They do not change the no-argument exit code of
`0`; automation that needs an evidence gate must opt into a strict mode.

## Frozen identities

- Batch: `development-screen-v1`.
- Search-code commit recorded by the summary and ledger:
  `0512ed7823e33264a27cd34b7376986b57a04fd6`.
- Protocol:
  `research/protocols/development-screen-v1.json`, SHA-256
  `c7cd08b94f8d6155f16fb3f6af4b7276c3a343f972b123c647d0ffdd47ccb6e2`.
- Published summary:
  `research/results/development-screen-v1-summary.json`, 428,134 bytes,
  SHA-256
  `fe94ebbe52a9ed7947e7e34e90136d05c28d9afee0a2a1fdcf5dd8401f9db2cd`.
- Final ledger:
  `data/research/development-screen-v1/ledger.final.jsonl`, 115,485,863
  bytes, SHA-256
  `23da90a773cdffb77c1f71187083985f4cf2916a38eb477875dfbdffe58dccd3`.
- Evaluated instrument and interval: `1HZ100V`,
  `[1788667200,1791259200)`.
- Fixed-slice content SHA-256:
  `8e3196f7d9faba44791fea5e0da1db797dd779355b656419e39667c7752a6d69`.
- Fixed-slice descriptor SHA-256:
  `a1e3d1834337c127013a2d24d5952a3cc3516bce96ae2991e154a692ffe78383`.
- Expected slice: 2,591,993 genuine observations of 2,592,000 seconds,
  with `[1789085201,1789085208)` explicitly missing.

The full artifact list and sizes are in the inventory rather than duplicated
here.

## What a public checkout can verify

From a clean checkout:

```powershell
node --version
node src/research-status-cli.js --strict=public
node src/product-feasibility-probe-cli.js --verify
node src/range-break-reconciliation-cli.js --verify
node --test
```

This verifies the tracked evidence package, frozen protocol/summary
consistency, saved sanitized probe structure, and software regression suite. It
does not independently reproduce the original ledger or market-data slice.

## Restoring the non-public artifacts

The ledger and raw archive were available in the reviewed local environment but
are intentionally ignored by Git. No public download URL is claimed.

1. Recover the files from the original research workspace or a byte-preserving
   backup. Do not substitute newly generated evidence.
2. Restore the ledger at:
   `data/research/development-screen-v1/ledger.final.jsonl`.
3. Restore the archive manifest and immutable chunks at:
   `data/market/1HZ100V/manifest.json` and
   `data/market/1HZ100V/raw/*.jsonl.gz`.
4. Run:

   ```powershell
   Get-FileHash data/research/development-screen-v1/ledger.final.jsonl -Algorithm SHA256
   node src/research-status-cli.js --strict=reproduction
   ```

If the ledger is missing, status reports the historical outcome as a reported
finding and marks local reproduction `MISSING`; it does not call the experiment
verified. If bytes differ, status reports `HASH_MISMATCH` and a top-level
`INTEGRITY_FAILURE`.

Re-downloading ticks from Deriv does not prove that the result used the same
historical snapshot. The original timestamps, quotes, immutable chunk bytes,
and provenance must match the fixed-slice hashes. Do not interpolate the seven
missing seconds.

## Recomputed result versus full strategy replay

The strict reproduction command is the smallest sufficient offline check of the
saved result package. It independently reproduced:

- 12,012 valid, unique ledger rows and trial identities;
- zero development-qualified configurations;
- every scenario's win/loss/tie accounting and payout score;
- family counts and all published rejection-reason totals; and
- singleton protocol, code-commit, and dataset-manifest provenance.

It did **not** regenerate signals for all 12,012 configurations. A bit-for-bit
replay with the original search command is not currently guaranteed because the
original search keyed a mutable whole-archive manifest and that exact original
manifest snapshot was not retained. The later independent audit verified the
fixed evaluated slice, but silently reconstructing a supposed original
manifest would not be legitimate evidence.

An independent reviewer attempting a new engine replay should use a separate
worktree at the recorded search commit, preserve the original ledger, freeze a
new manifest identity for the verified fixed slice, and publish the replay as a
new versioned experiment. It must not overwrite or be represented as the
original run.

## Historical-expansion status

`data/market/historical-backfill-status.json` is an ignored local checkpoint,
not part of the frozen 30-day result. Status validates its instrument, interval,
cursor, terminal state, manifest, and—whenever completion is claimed—every
relevant chunk and row. `complete: true` is emitted only when:

- the checkpoint says `COMPLETED`;
- paging reached the requested start;
- its saved completion audit agrees with a new row-level audit;
- all relevant chunks pass checksum and structural checks; and
- the requested interval has zero missing seconds.

A stale PID in a checkpoint is never interpreted as a live or stopped process.
Current process state remains `NOT_CHECKED` unless a separate process inspection
is performed.

## Public packaging proposal

No large artifact is uploaded by this repository change. If distribution is
later approved:

1. **Ledger package:** the exact 115,485,863-byte JSONL ledger plus a checksum
   manifest and the frozen protocol/summary. It should contain no account or
   settlement records. Run a secret/account-identifier scan before release.
2. **Evaluated tick-slice package:** the 2,594 relevant immutable gzip chunks
   (11,504,188 compressed bytes in the reviewed local snapshot) plus a
   slice-only descriptor. Do not publish the mutable whole-archive manifest as
   the experiment identity.
3. **Rights review:** confirm Deriv API terms and redistribution rights for raw
   tick observations before publishing the tick package. This review has not
   been completed.
4. **Redaction:** exclude credentials, account identifiers, proposal IDs,
   authenticated statements, browser transaction records, and any unrelated
   ticks outside the frozen interval.
5. **Release:** publish immutable archives with SHA-256 values and a versioned
   release URL only after the rights and redaction checks. Until then, no
   download link should be invented or implied.
