import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { auditArchiveSlice } from "./archive-slice-audit.js";
import {
  clusteredRatioTTest,
  movingDayBlockBootstrapLowerBound,
} from "./dependence-statistics.js";
import {
  numericSummary,
  separateQualificationQuestions,
  validateExperimentLedgerRecord,
} from "./experiment-ledger-audit.js";
import {
  auditRecordedBrowserRuns,
  readRecordedBrowserRuns,
} from "./recorded-observation-audit.js";
import {
  buildSearchFeatureCache,
  evaluateSearchConfiguration,
} from "./strategy-search-engine.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocolPath = path.join(projectRoot, "research", "protocols", "development-screen-v1.json");
const summaryPath = path.join(projectRoot, "research", "results", "development-screen-v1-summary.json");
const dataAvailabilityReportPath = path.join(
  projectRoot,
  "research",
  "data-availability-2026-10-08.md",
);
const ledgerPath = path.join(projectRoot, "data", "research", "development-screen-v1", "ledger.final.jsonl");
const outputJsonPath = path.join(projectRoot, "research", "audits", "development-screen-v1-independent-audit-v2.json");
const outputMarkdownPath = path.join(projectRoot, "research", "audits", "development-screen-v1-independent-audit-v2.md");
const historicalCollectionStatusPath = path.join(
  projectRoot,
  "data",
  "market",
  "historical-backfill-status.json",
);

const FAMILY_HYPOTHESES = Object.freeze({
  unconditional_baseline: "Persistent unconditional upward or downward tick bias.",
  sma_trend: "A positive/negative fast-versus-slow price-level separation continues.",
  sma_reversion: "A positive/negative fast-versus-slow price-level separation reverses.",
  momentum_trend: "A signed lookback price change continues.",
  momentum_reversion: "A signed lookback price change reverses.",
  channel_breakout: "A move beyond the prior tick high/low continues.",
  zscore_reversion: "A standardized price-level deviation reverts toward its rolling mean.",
});

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function codeState() {
  const options = { cwd: projectRoot, encoding: "utf8" };
  const commit = execFileSync("git", ["rev-parse", "HEAD"], options).trim();
  let trackedWorktreeDirty = false;
  try {
    execFileSync("git", ["diff", "--quiet"], options);
    execFileSync("git", ["diff", "--cached", "--quiet"], options);
  } catch {
    trackedWorktreeDirty = true;
  }
  return { commit, trackedWorktreeDirty };
}

async function historicalCollectionStatus() {
  let bytes;
  try {
    bytes = await readFile(historicalCollectionStatusPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "NOT_FOUND" };
    throw error;
  }
  const status = JSON.parse(bytes.toString("utf8"));
  let processAlive = false;
  if (Number.isSafeInteger(status.pid)) {
    try {
      process.kill(status.pid, 0);
      processAlive = true;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  return {
    archive: status.archive ? {
      coverageDaysAcrossAllIntervals: status.archive.coverageDays,
      firstEpoch: status.archive.firstEpoch,
      intervals: status.archive.intervals,
      lastEpoch: status.archive.lastEpoch,
      totalRows: status.archive.totalRows,
    } : null,
    cursorEpoch: status.cursorEpoch,
    endpoint: status.endpoint,
    fromEpoch: status.fromEpoch,
    lastError: status.lastError,
    pagesFetchedThisInvocation: status.pagesFetched,
    processAlive,
    remainingOlderSecondsBeforeTarget:
      Number.isSafeInteger(status.cursorEpoch) && Number.isSafeInteger(status.fromEpoch)
        ? Math.max(0, status.cursorEpoch + 1 - status.fromEpoch)
        : null,
    resumeCommand:
      `node src/historical-backfill-cli.js --from ${status.fromEpoch} --to ${status.toEpochExclusive}`,
    rowsStoredThisInvocation: status.rowsStored,
    state: status.state,
    statusFileSha256: digest(bytes),
    toEpochExclusive: status.toEpochExclusive,
    updatedAt: status.updatedAt,
  };
}

function increment(target, key) {
  target[key] = (target[key] ?? 0) + 1;
}

function newFamily(family) {
  return {
    activeDays: [],
    baseAt095NonNegative: 0,
    baseMeetsFrozenThreshold: 0,
    baseNegative: 0,
    configurations: 0,
    durationCounts: {},
    failureCounts: {},
    family,
    hypothesis: FAMILY_HYPOTHESES[family],
    outcomeSignatures: new Set(),
    parameterValues: new Map(),
    stressFailsFrozenThreshold: 0,
    tradeCounts: [],
  };
}

function addParameterValues(family, configuration) {
  for (const [name, value] of Object.entries(configuration)) {
    if (name === "family") continue;
    if (!family.parameterValues.has(name)) family.parameterValues.set(name, new Set());
    family.parameterValues.get(name).add(value);
  }
}

function sortedValues(values) {
  return [...values].sort((left, right) =>
    typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right)));
}

function finalizeFamily(family, protocol) {
  return {
    activeCalendarDays: numericSummary(family.activeDays),
    baseAt095NonNegative: family.baseAt095NonNegative,
    baseMeetsFrozenThreshold: family.baseMeetsFrozenThreshold,
    baseNegative: family.baseNegative,
    configurations: family.configurations,
    contractTypes: family.family === "unconditional_baseline"
      ? ["CALL", "PUT"]
      : ["CALL", "PUT"],
    durationConfigurationCounts: Object.fromEntries(
      Object.entries(family.durationCounts).sort(([left], [right]) => Number(left) - Number(right)),
    ),
    durationTicks: sortedValues(family.parameterValues.get("durationTicks") ?? []),
    failureCounts: Object.fromEntries(
      Object.entries(family.failureCounts).sort(([left], [right]) => left.localeCompare(right)),
    ),
    family: family.family,
    historicalWindows: protocol.evaluationWindows.map((window) => ({
      ...window,
      fromUtc: new Date(window.fromEpochInclusive * 1_000).toISOString(),
      toUtcExclusive: new Date(window.toEpochExclusive * 1_000).toISOString(),
    })),
    hypothesis: family.hypothesis,
    parameterValues: Object.fromEntries(
      [...family.parameterValues.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, values]) => [name, sortedValues(values)]),
    ),
    stressFailsFrozenThreshold: family.stressFailsFrozenThreshold,
    tradeCount: numericSummary(family.tradeCounts),
    uniqueOutcomeCountSignatures: family.outcomeSignatures.size,
  };
}

async function auditLedger(protocol, summary) {
  const expectedLedgerHash = summary.detailedLedger.finalSha256;
  const actualLedgerHash = await hashFile(ledgerPath);
  if (actualLedgerHash !== expectedLedgerHash) {
    throw new Error(`Baseline ledger checksum mismatch: ${actualLedgerHash}.`);
  }
  const families = new Map();
  const configurationsByHash = new Map();
  const targetHashes = new Set(summary.leaderboard.map((item) => item.configurationHash));
  const targetRecords = new Map();
  const seenConfigurations = new Set();
  const seenTrials = new Set();
  const provenance = {
    codeCommits: new Set(),
    datasetManifestSha256: new Set(),
    protocolSha256: new Set(),
  };
  const questions = {
    baseModelLost: 0,
    baseModelNonNegative: 0,
    baseModelMissedPracticalThreshold: 0,
    conservativeStressMissedPracticalThreshold: 0,
    conservativeStressNonPositiveInAnyWindowOrDelay: 0,
    multiplicityAdjustedEvidencePassed: 0,
    originalBootstrapEvaluated: 0,
    originalBootstrapLowerBoundPositive: 0,
    operationalOrSampleFailures: {},
  };
  const globalOutcomeSignatures = new Set();
  let records = 0;
  let baseAt095NonNegative = 0;
  let baseAt095Meets002 = 0;
  let severeMinimumEncodedAsNull = 0;
  let stressMinimumEncodedAsNull = 0;
  const input = createReadStream(ledgerPath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const record = JSON.parse(line);
    records += 1;
    if (seenConfigurations.has(record.configurationHash) || seenTrials.has(record.trialId)) {
      throw new Error(`Duplicate baseline ledger identity at row ${records}.`);
    }
    seenConfigurations.add(record.configurationHash);
    seenTrials.add(record.trialId);
    provenance.codeCommits.add(record.codeCommit);
    provenance.datasetManifestSha256.add(record.dataset?.manifestSha256);
    provenance.protocolSha256.add(record.protocolSha256);
    const checked = validateExperimentLedgerRecord(record, protocol);
    if (checked.severeMinimumEncodedAsNull) severeMinimumEncodedAsNull += 1;
    if (checked.stressMinimumEncodedAsNull) stressMinimumEncodedAsNull += 1;
    configurationsByHash.set(record.configurationHash, record.configuration);
    if (targetHashes.has(record.configurationHash)) targetRecords.set(record.configurationHash, record);
    globalOutcomeSignatures.add(checked.outcomeSignature);
    const family = families.get(record.family) ?? newFamily(record.family);
    families.set(record.family, family);
    family.configurations += 1;
    family.tradeCounts.push(record.evaluation.base.trades);
    family.activeDays.push(record.evaluation.activity.activeCalendarDays);
    increment(family.durationCounts, String(record.configuration.durationTicks));
    addParameterValues(family, record.configuration);
    family.outcomeSignatures.add(checked.outcomeSignature);
    if (record.evaluation.base.averageProfitPerDollarStaked < 0) family.baseNegative += 1;
    if (record.evaluation.base.averageProfitPerDollarStaked >=
        protocol.acceptanceRules.minimumBaseAverageProfitPerDollarStaked) {
      family.baseMeetsFrozenThreshold += 1;
    }
    if (checked.baseAt095.averageProfitPerDollarStaked >= 0) {
      family.baseAt095NonNegative += 1;
      baseAt095NonNegative += 1;
    }
    if (checked.baseAt095.averageProfitPerDollarStaked >= 0.02) baseAt095Meets002 += 1;
    if (record.evaluation.minimumStressAverageProfitPerDollarStaked <
        protocol.acceptanceRules.minimumStressAverageProfitPerDollarStaked) {
      family.stressFailsFrozenThreshold += 1;
    }
    for (const reason of record.evaluation.acceptanceFailures) {
      increment(family.failureCounts, reason);
    }
    const separated = separateQualificationQuestions(record.evaluation, protocol);
    if (separated.baseModel.lost) questions.baseModelLost += 1;
    else questions.baseModelNonNegative += 1;
    if (separated.baseModel.missedPracticalThreshold) {
      questions.baseModelMissedPracticalThreshold += 1;
    }
    if (separated.conservativeStress.missedPracticalThreshold) {
      questions.conservativeStressMissedPracticalThreshold += 1;
    }
    if (separated.conservativeStress.anyWindowOrDelayNonPositive) {
      questions.conservativeStressNonPositiveInAnyWindowOrDelay += 1;
    }
    if (separated.statisticalEvidence.multiplicityAdjustedEvidencePassed) {
      questions.multiplicityAdjustedEvidencePassed += 1;
    }
    if (separated.statisticalEvidence.bootstrapEvaluated) {
      questions.originalBootstrapEvaluated += 1;
      if (separated.statisticalEvidence.bootstrapLowerBoundPositive) {
        questions.originalBootstrapLowerBoundPositive += 1;
      }
    }
    for (const [name, failed] of Object.entries(separated.operationalOrSample)) {
      if (failed) increment(questions.operationalOrSampleFailures, name);
    }
  }
  if (records !== summary.counts.uniqueConfigurationsCompleted ||
      targetRecords.size !== targetHashes.size) {
    throw new Error("Baseline ledger cardinality or targeted records are incomplete.");
  }
  const singleton = (values, label) => {
    if (values.size !== 1) throw new Error(`Baseline ledger has inconsistent ${label}.`);
    return [...values][0];
  };
  const result = {
    accountingChecksPassed: records,
    baseAt095Meets002,
    baseAt095NonNegative,
    configurationHashesUnique: seenConfigurations.size,
    familyCoverage: [...families.values()]
      .map((family) => finalizeFamily(family, protocol))
      .sort((left, right) => left.family.localeCompare(right.family)),
    ledgerSha256: actualLedgerHash,
    provenance: {
      codeCommit: singleton(provenance.codeCommits, "code commits"),
      datasetManifestSha256: singleton(
        provenance.datasetManifestSha256,
        "dataset manifest hashes",
      ),
      protocolSha256: singleton(provenance.protocolSha256, "protocol hashes"),
    },
    qualificationQuestions: questions,
    records,
    severeMinimumEncodedAsNull,
    stressMinimumEncodedAsNull,
    trialIdsUnique: seenTrials.size,
    uniqueOutcomeCountSignatures: globalOutcomeSignatures.size,
  };
  return { configurationsByHash, result, targetRecords };
}

function sameScenarioCounts(left, right) {
  return JSON.stringify(left.map((item) => ({
    counts: item.counts,
    delayTicks: item.delayTicks,
    windowId: item.windowId,
  }))) === JSON.stringify(right.map((item) => ({
    counts: item.counts,
    delayTicks: item.delayTicks,
    windowId: item.windowId,
  })));
}

function runTargetedStatisticalAudit({ cache, protocol, summary, targetRecords }) {
  const checks = [];
  for (const [rank, item] of summary.leaderboard.entries()) {
    const original = targetRecords.get(item.configurationHash);
    const reevaluated = evaluateSearchConfiguration({
      cache,
      captureDayBlocks: true,
      config: original.configuration,
      protocol,
    });
    const scenarioCountsMatchOriginal = sameScenarioCounts(
      original.evaluation.scenarios,
      reevaluated.scenarios,
    );
    const activityMatchesOriginal = JSON.stringify(original.evaluation.activity) ===
      JSON.stringify(reevaluated.activity);
    const drawdownMatchesOriginal = JSON.stringify(original.evaluation.drawdown) ===
      JSON.stringify(reevaluated.drawdown);
    if (!scenarioCountsMatchOriginal || !activityMatchesOriginal ||
        !drawdownMatchesOriginal) {
      throw new Error(`Targeted replay changed deterministic fields for ${item.strategyId}.`);
    }
    const blocks = reevaluated.uncertainty.utcDayOutcomeBlocks;
    const ratioTest = clusteredRatioTTest(blocks, {
      comparisons: protocol.searchBudget.plannedUniqueConfigurations,
      netProfitOnWin: protocol.acceptanceRules.stressPayoutOnWin,
    });
    const movingBootstrap = movingDayBlockBootstrapLowerBound(blocks, {
      blockLengthDays: 3,
      confidence: protocol.acceptanceRules.bootstrapConfidence,
      netProfitOnWin: protocol.acceptanceRules.stressPayoutOnWin,
      repetitions: protocol.acceptanceRules.bootstrapRepetitions,
      seed: protocol.acceptanceRules.bootstrapSeed + rank,
    });
    checks.push({
      configurationHash: item.configurationHash,
      correctedClusteredRatioTest: ratioTest,
      correctedMovingThreeDayBlockBootstrap: movingBootstrap,
      originalBonferroniAdjustedPValue:
        original.evaluation.uncertainty.adjustedPValueBonferroni,
      originalIndependentDayBootstrap: original.evaluation.dayBlockBootstrap,
      activityMatchesOriginal,
      drawdownMatchesOriginal,
      scenarioCountsMatchOriginal,
      strategyId: item.strategyId,
      worstStressAverageProfitPerUnit:
        original.evaluation.minimumStressAverageProfitPerDollarStaked,
    });
  }
  return {
    correctedBootstrapLowerBoundPositive: checks.filter((item) =>
      (item.correctedMovingThreeDayBlockBootstrap.lowerBound ?? -Infinity) > 0).length,
    correctedCombinedEvidencePassed: checks.filter((item) =>
      item.correctedClusteredRatioTest.adjustedPValueBonferroni <=
        protocol.acceptanceRules.familyWiseAlpha &&
      (item.correctedMovingThreeDayBlockBootstrap.lowerBound ?? -Infinity) > 0).length,
    correctedMultiplicityAdjustedEvidencePassed: checks.filter((item) =>
      item.correctedClusteredRatioTest.adjustedPValueBonferroni <=
        protocol.acceptanceRules.familyWiseAlpha).length,
    scope: "The predefined v1 top 20 only; this is a post-hoc sensitivity audit, not a new qualification gate.",
    strategies: checks,
    targetedConfigurations: checks.length,
  };
}

async function auditBrowserObservations() {
  const runs = await readRecordedBrowserRuns(projectRoot);
  const observations = runs.flatMap((run) => run.transactions.map((transaction) => ({
    durationTicks: run.durationTicks,
    epoch: Date.parse(transaction.timestamp) / 1_000,
  })));
  const fromEpoch = Math.min(...observations.map(({ epoch }) => epoch)) - 2;
  const toEpochExclusive = Math.max(...observations.map(({ durationTicks, epoch }) =>
    epoch + durationTicks + 3)) + 1;
  const archive = await auditArchiveSlice({
    fromEpoch,
    projectRoot,
    symbol: "1HZ100V",
    toEpochExclusive,
  });
  const quotesByEpoch = new Map();
  for (let index = 0; index < archive.present.length; index += 1) {
    if (archive.present[index]) quotesByEpoch.set(fromEpoch + index, archive.quotes[index]);
  }
  const browser = auditRecordedBrowserRuns(runs, quotesByEpoch);
  const apiEventsPath = path.join(projectRoot, "data", "demo", "trade-events.jsonl");
  const apiBytes = await readFile(apiEventsPath);
  const apiEvents = apiBytes.toString("utf8").trim().split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const bought = apiEvents.find((event) => event.stage === "bought");
  const settled = apiEvents.find((event) => event.stage === "settled");
  return {
    browserArchiveSlice: archive.audit,
    browserObservations: {
      ...browser,
      evidenceClass:
        "Recorded Bot Builder UI observations corroborated by public ticks; missing account/contract identity prevents settlement-evidence eligibility.",
    },
    guardedApiObservation: {
      accountingMatches:
        bought?.buyPrice === 1 && settled?.status === "won" && settled?.profit === 0.9,
      accountIdentityPresent: apiEvents.some((event) =>
        typeof event.accountId === "string" || Number.isSafeInteger(event.accountId)),
      contractIdentityPresent: Number.isSafeInteger(bought?.contractId),
      evidenceFileSha256: digest(apiBytes),
      evidenceGateEligible: false,
      sameJournalTrade:
        typeof bought?.tradeId === "string" && bought.tradeId === settled?.tradeId,
      settledRecords: settled ? 1 : 0,
      strategyHashPresent: apiEvents.some((event) =>
        /^[a-f0-9]{64}$/.test(event.strategyHash ?? "")),
      timingReconstructionPossible: false,
    },
  };
}

function formatValues(values) {
  if (!Array.isArray(values)) return "";
  return values.join(",");
}

function coverageTable(families) {
  return families.map((family) => {
    const parameters = Object.entries(family.parameterValues)
      .filter(([name]) => name !== "durationTicks")
      .map(([name, values]) => `${name}=${formatValues(values)}`)
      .join("; ");
    const sampleFailures =
      (family.failureCounts.too_few_total_trades ?? 0) +
      (family.failureCounts.too_few_trades_in_window ?? 0) +
      (family.failureCounts.too_few_active_days ?? 0);
    return `| ${family.family} | ${family.hypothesis} | ${family.configurations} | ${formatValues(family.durationTicks)} | ${parameters} | ${family.tradeCount.minimum}/${family.tradeCount.median}/${family.tradeCount.maximum} | ${family.baseNegative} | ${family.stressFailsFrozenThreshold} | ${sampleFailures} |`;
  });
}

function writeAuditMarkdown(audit) {
  const q = audit.ledgerAudit.qualificationQuestions;
  const top = audit.targetedStatisticalAudit.strategies[0];
  const content = [
    "# Independent audit of development screen v1",
    "",
    `Generated from audit tooling commit \`${audit.auditCode.commit}\`. Reviewed search commit \`${audit.reviewedBaseline.searchCodeCommit}\` and result commit \`${audit.reviewedBaseline.resultCommit}\`.`,
    "",
    "## Direct conclusion",
    "",
    "The simulator was sufficiently accurate for the narrow claim that none of the tested 1HZ100V, 1–10-tick, fixed-stake indicator configurations passed the frozen rules. It was not accurate enough to claim observed historical contract profitability, and the search cannot support a claim about other symbols, products, clock durations, or strategy classes.",
    "",
    "No verified correction creates a qualifying strategy. The appropriate decision is to stop expanding the same short-tick technical-indicator search. Completing the 90-day archive remains useful for replication and null calibration, not as an automatic reason to search more variants.",
    "",
    "## Baseline preservation and reproducibility",
    "",
    `- Original ledger: ${audit.ledgerAudit.records.toLocaleString()} rows, SHA-256 \`${audit.ledgerAudit.ledgerSha256}\`; every configuration/trial ID was unique and every scenario/accounting field was independently recomputed.`,
    `- The original mutable whole-manifest identifier was \`${audit.reviewedBaseline.originalMutableManifestSha256}\`. The independently verified fixed slice is now identified by content SHA-256 \`${audit.datasetSliceAudit.contentSha256}\` and relevant-slice manifest SHA-256 \`${audit.datasetSliceAudit.sliceManifestSha256}\`.`,
    `- Exact slice: ${audit.datasetSliceAudit.observedGenuineSeconds.toLocaleString()} of ${audit.datasetSliceAudit.expectedSeconds.toLocaleString()} seconds, with the original seven-second gap preserved.`,
    "- v1 artifacts were not edited or overwritten. This audit is versioned separately as v2.",
    "",
    "## Historical collection status during the audit",
    "",
    `The authorized 90-day public backfill is ${audit.historicalCollection.state}, and its recorded PID is ${audit.historicalCollection.processAlive ? "still active" : "not active"}. It checkpointed ${audit.historicalCollection.rowsStoredThisInvocation?.toLocaleString() ?? "unknown"} rows across ${audit.historicalCollection.pagesFetchedThisInvocation?.toLocaleString() ?? "unknown"} pages in this invocation before the public API exhausted bounded retries${audit.historicalCollection.lastError ? `: ${audit.historicalCollection.lastError}` : "."}`,
    `Approximately ${audit.historicalCollection.remainingOlderSecondsBeforeTarget?.toLocaleString() ?? "an unknown number of"} older target seconds remain before the requested start. The audit did not restart or duplicate the stopped collector. Resume only after the rate limit clears with \`${audit.historicalCollection.resumeCommand}\`; the immutable chunks and checkpoint remain in place.`,
    "",
    "## Confirmed defects",
    "",
    "1. **High — mutable-manifest provenance.** The checkpoint keyed the entire append-only manifest rather than the fixed evaluated slice, and the original manifest snapshot was not retained. An unrelated older backfill therefore makes v1 non-resumable. The new independent slice auditor hashes exact chronological content and only the relevant chunk descriptor. The present slice has the same row count and gap as v1, but the missing original manifest snapshot prevents a cryptographic proof that its old whole-manifest hash described exactly this chunk list.",
    "2. **Medium — inferential estimand/dependence mismatch.** The v1 t test and bootstrap averaged active-day return ratios equally, while the reported target was profit per unit staked. Its bootstrap resampled individual days independently, so it handled within-day clustering but not adjacent-day dependence. A ratio-of-sums clustered check and circular three-day moving-block sensitivity were run on the predefined top 20. Zero passed either corrected evidence check.",
    "3. **Medium — rejection-label ambiguity.** Only 20 configurations received the original bootstrap and only 100 received neighboring-setting calculations, yet every other row was labelled `failed_or_not_shortlisted`. Non-evaluation is now reported separately from an evaluated failure.",
    `4. **Low — non-finite ledger serialization.** ${audit.ledgerAudit.stressMinimumEncodedAsNull} rows with at least one no-trade stress scenario computed an internal negative-infinity sentinel that JSON encoded as null. The pre-serialization rule rejected them correctly, but the persisted field is ambiguous. The independent ledger validator reconstructs the fail-closed value from scenario counts.`,
    "",
    "These defects affect provenance and strength of inference. They do not change the frozen economic screen: every configuration still has at least one non-positive 0.80 stress window/delay, and targeted replay reproduced the original trade counts exactly.",
    "",
    "## Contract and simulator verification",
    "",
    `- All ${audit.recordedObservationAudit.browserObservations.records} recorded Bot Builder observations (${audit.recordedObservationAudit.browserObservations.durationCounts["1"] ?? 0} one-tick and ${audit.recordedObservationAudit.browserObservations.durationCounts["5"] ?? 0} five-tick) matched archive entry at purchase+1 tick and exit at entry+duration; ${audit.recordedObservationAudit.browserObservations.accountingMatches} reproduced +0.90/-1 accounting, including ${audit.recordedObservationAudit.browserObservations.ties} strict-comparison ties as losses. Zero have the account, contract, settlement-status, and exact-strategy identity required to count as broker-settlement evidence.`,
    `- The separate guarded API journal contains ${audit.recordedObservationAudit.guardedApiObservation.settledRecords} bought/settled Demo chain with a purchase contract ID and +0.90 accounting. It lacks account identity, exact strategy hash, entry spot, and reconstructable entry timing, so it is an observed journal settlement but not eligible strategy evidence or simulator-parity proof.`,
    "- The saved unauthenticated `contracts_for` probe on 2026-10-08 reported 1HZ100V CALL/PUT tick contracts spanning 1–10 ticks. This is a point-in-time product observation, not proof of historical availability or prices. Tick and clock durations remain distinct API units.",
    "- Official terms define Digital Options entry as the next tick after server processing. Deriv's worked 5-tick example shows start, entry one second later, and exit five ticks after entry. The manual fixture and shared-engine parity tests reproduce this convention.",
    "- The search used raw ticks, not candles. Indicators include the known decision tick, never a future tick; outcomes require complete signal-to-settlement presence and stay inside one chronological window.",
    "- At one decision per 60 seconds and a maximum 3-tick delay plus 10-tick duration, modeled positions cannot overlap on the audited one-second symbol. Vectorized outcomes matched the separate sequential reference engine.",
    "- Gross payout and net profit are distinct: the v1 values +0.90/+0.80/+0.70 are net win profits per $1 stake; a loss or strict tie is -$1.",
    "",
    "Unverified by available evidence: account-specific historical quotes, proposal expiry/requotes, processing delays beyond three ticks, rejected/unavailable purchases, cancellations/refunds, server corrections, and whether public history always equals the settlement tick stream. Those limitations prevent interpreting simulated P/L as observed contract profit.",
    "",
    "## Statistical findings kept separate",
    "",
    `- A — base 0.90 model: ${q.baseModelLost.toLocaleString()} lost; ${q.baseModelNonNegative.toLocaleString()} were non-negative; ${q.baseModelMissedPracticalThreshold.toLocaleString()} missed the frozen +0.02 threshold.`,
    `- B — conservative 0.80 stress: ${q.conservativeStressMissedPracticalThreshold.toLocaleString()} missed +0.01 and ${q.conservativeStressNonPositiveInAnyWindowOrDelay.toLocaleString()} had a non-positive window/delay.`,
    `- C — evidence: ${q.multiplicityAdjustedEvidencePassed} passed the Bonferroni screen. The original bootstrap was actually evaluated for ${q.originalBootstrapEvaluated}, not 12,012; none had a positive lower bound. The corrected top-20 checks also had zero passes.`,
    `- D — operational/sample rules: ${JSON.stringify(q.operationalOrSampleFailures)}. These are risk/activity rejections, not proofs of negative expectancy.`,
    "",
    `For the original top-ranked configuration, the corrected 0.80 clustered ratio estimate is ${top.correctedClusteredRatioTest.averageNetProfitPerUnitStaked.toFixed(6)} and its 99% moving three-day-block lower bound is ${top.correctedMovingThreeDayBlockBootstrap.lowerBound.toFixed(6)}.`,
    "",
    "Bonferroni controls family-wise error regardless of dependence between configurations if each raw p-value is valid; here the weak point is the 30-cluster Student-t approximation, not the direction of the adjustment. A 99% tail estimate from only 30 days is intrinsically coarse. The neighboring-setting rule was implemented as normalized numeric distance within a hash-subsampled grid, not a predeclared one-coordinate adjacency graph, so it is supporting diagnostics rather than strong independent confirmation.",
    "Net expectancy and profit factor were independently reconstructed from win/loss/tie counts. Maximum drawdown and longest losing streak use chronological delay-1 trades at the base +0.90 payout; a four-trade hand fixture verifies both. The fixed dataset spans 30 UTC days and requires 20 active days, but there is no separate first-trade-to-last-trade elapsed-duration rule. Fixed $1 stakes and minute-spaced decisions cap simulated concurrent exposure at one stake unit.",
    "",
    "## What the 12,012 configurations covered",
    "",
    "All rows used 1HZ100V Rise/Fall (`CALL`/`PUT`), tick durations, the same exposed 30 days, and three entry delays/payout assumptions. Trade counts below are minimum/median/maximum base-delay trades.",
    "",
    "| Family | Hypothesis | Configs | Durations (ticks) | Actual parameter values | Trades min/median/max | Base-negative | Stress-failed | Sample-failure sum* |",
    "|---|---|---:|---|---|---:|---:|---:|---:|",
    ...coverageTable(audit.ledgerAudit.familyCoverage),
    "",
    "*The sample-failure sum can count one configuration more than once across total-trade, per-window, and active-day rules.",
    "",
    `The 12,012 parameter identities produced only ${audit.ledgerAudit.uniqueOutcomeCountSignatures.toLocaleString()} distinct nine-scenario outcome-count signatures. That is a proxy, not proof of identical signal paths, but it confirms substantial correlation/redundancy. There were seven directional families but only five transformations: unconditional direction, SMA separation, momentum, channel breakout, and z-score; unconditional, SMA, and momentum each include opposite-polarity pairs. Configurations are not independent observations—the same 43,200 minute decisions and 30 UTC-day clusters were reused throughout.`,
    "",
    "## Product facts and research decision",
    "",
    "Deriv documents Volatility Indices as cryptographically generated and the 1s variants as one tick per second. Its current Synthetic Indices page says most such indices (except Range Break) may not suit technical indicators and that noticeable historical patterns are coincidental; its trading terms say option pricing includes a bias in Deriv's favour. That makes another larger SMA/momentum/reversion search on 1HZ100V difficult to justify without a new mechanism.",
    "",
    "Bounded alternatives, none presumed profitable and none started by this audit:",
    "",
    "1. **Stop the current direction (recommended).** The evidence against expanding the same 1HZ100V SMA/momentum/channel/z-score grid is the exhaustive frozen screen plus Deriv's description of most synthetic-index patterns as coincidental. The existing checkpointed 90-day collection can still support replication and null calibration after rate limits clear. Reconsider only if a prospectively specified effect survives actual quote, delay, and full-search controls. Incremental local replay cost is minutes; no additional parameter search is justified.",
    "2. **Range Break feasibility study.** Why: Deriv describes this instrument using explicit upper/lower ranges, a different mechanism from applying a generic channel breakout to 1HZ100V. Evidence to investigate is that official mechanism, not the rejected v1 curve. First require a public product probe for Options availability/durations, immutable native-cadence ticks, and contemporaneous indicative proposals; account quotes would still be needed before executable-profit claims. Preregister at most 300 boundary-state rules. Falsify if a protected window is non-positive at observed proposal economics or if availability does not match the proposed contract. Local simulation should be under one hour after acquisition; request count and public-API delay are unknown.",
    "3. **Drift/Volatility Switch clock-horizon feasibility study.** Why: Deriv documents regimes whose average duration is measured in minutes, unlike the searched 1–10-tick horizon. Evidence is the marketed regime construction; its proprietary realization and Options pricing remain unknown. Require a successful contract-capability probe, native-cadence history, a clock-duration simulator, and contemporaneous proposals. Falsify if a preregistered regime classifier does not beat quote-implied break-even on protected data. A single 30-day one-second symbol is up to 2.6 million ticks (about 2,592 maximum-size history pages); local evaluation should be under an hour, but acquisition may again be rate-limited.",
    "4. **Skew Step analytical check before backtesting.** Why: documented asymmetric up/down probabilities could change unconditional direction frequency, unlike the symmetric-style transforms screened here. The payout may fully or adversely price that skew. Require empirical transition counts plus simultaneous public Rise/Fall proposals and verified supported durations; do not infer executable profit from ticks alone. Falsify immediately if the probability-weighted value is non-positive at quoted payouts, before any grid search. A bounded one-week descriptive sample is at most 604,800 one-second ticks; analysis is minutes, while proposal sampling/API availability is the constraint.",
    "",
    "More history can narrow uncertainty and expose regime instability; it cannot by itself create a plausible mechanism or turn correlated parameter variations into independent hypotheses.",
    "",
    "## Sources (accessed 2026-10-08)",
    "",
    ...audit.sources.map((source) => `- [${source.title}](${source.url}) — ${source.use}`),
    "",
    "## Reproduce",
    "",
    "```powershell",
    "node --test",
    "node src/experiment-audit-cli.js",
    "node src/strategy-search-cli.js status",
    "Get-Content data/market/historical-backfill-status.json",
    "```",
    "",
    "The audit command is offline. It requires the local ignored v1 ledger and raw archive whose hashes are recorded above; it never authenticates or places an order.",
    "",
  ].join("\n");
  return writeFile(outputMarkdownPath, content, "utf8");
}

const protocolBytes = await readFile(protocolPath);
const summaryBytes = await readFile(summaryPath);
const dataAvailabilityReportBytes = await readFile(dataAvailabilityReportPath);
const protocol = JSON.parse(protocolBytes);
const summary = JSON.parse(summaryBytes);
const ledger = await auditLedger(protocol, summary);
const dataset = await auditArchiveSlice({
  fromEpoch: protocol.dataset.fromEpochInclusive,
  projectRoot,
  symbol: protocol.dataset.symbol,
  toEpochExclusive: protocol.dataset.toEpochExclusive,
});
const sameMissingRanges = dataset.audit.missingRanges.length ===
    summary.dataset.missingRanges.length &&
  dataset.audit.missingRanges.every((range, index) => {
    const baseline = summary.dataset.missingRanges[index];
    return range.fromEpoch === baseline.fromEpoch &&
      range.toEpochExclusive === baseline.toEpochExclusive &&
      range.missingSeconds === baseline.missingSeconds;
  });
if (dataset.audit.observedGenuineSeconds !== summary.dataset.observedGenuineSeconds ||
    !sameMissingRanges) {
  throw new Error("Current immutable slice no longer matches v1 row coverage and gaps.");
}
const cache = buildSearchFeatureCache({
  present: dataset.present,
  protocol,
  quotes: dataset.quotes,
});
const targetedStatisticalAudit = runTargetedStatisticalAudit({
  cache,
  protocol,
  summary,
  targetRecords: ledger.targetRecords,
});
const recordedObservationAudit = await auditBrowserObservations();
const historicalCollection = await historicalCollectionStatus();
const audit = {
  auditCode: codeState(),
  contractModelConclusion: {
    supportedSearchProduct: {
      contractTypes: ["CALL", "PUT"],
      durationUnit: "ticks",
      durations: protocol.parameterRanges.durationsTicks,
      productProbeEvidence: {
        path: path.relative(projectRoot, dataAvailabilityReportPath).replaceAll("\\", "/"),
        sha256: digest(dataAvailabilityReportBytes),
        type: "Unauthenticated point-in-time contracts_for observation",
      },
      symbol: protocol.dataset.symbol,
    },
    sufficientlyAccurateForNarrowScreen: true,
    sufficientlyAccurateForHistoricalExecutableProfit: false,
    unresolvedAssumptions: [
      "Historical account-specific proposal prices and executable payouts were not recorded.",
      "Proposal expiry, requotes, rejected purchases, cancellations, refunds, and broker corrections are not simulated.",
      "Processing delays beyond the frozen one-to-three-tick grid are not tested.",
      "Public history is assumed to match settlement ticks; this is corroborated by 99 UI observations but not guaranteed for every anomaly.",
    ],
    verified: [
      "Signals use raw ticks and only information available at the decision epoch.",
      "Entry is the delayed future tick and expiry is duration ticks after entry.",
      "Strict CALL/PUT ties lose the stake in simulation and recorded UI observations.",
      "Gross payout is kept distinct from net win profit per unit staked.",
      "No decision, entry, or settlement crosses a source gap or chronological window.",
      "Minute-spaced decisions cannot overlap at the searched delays and durations; a separate sequential engine matches vectorized counts.",
    ],
  },
  datasetSliceAudit: dataset.audit,
  defects: [
    {
      affectedFiles: ["src/forward-replay.js", "src/strategy-search-cli.js"],
      affectedResults: "v1 checkpoint resumability and exact manifest provenance; not the independently reverified fixed-slice counts.",
      correction: "Added independent content- and relevant-slice hashing without rewriting v1.",
      id: "AUDIT-001",
      reproducibleExample: "Append a non-overlapping older chunk: whole-manifest hash changes while fixed-slice content hash does not.",
      severity: "high",
      title: "Mutable whole-manifest hash used as dataset identity",
    },
    {
      affectedFiles: ["src/strategy-search-engine.js"],
      affectedResults: "v1 p-values/bootstrap interpretation; base and payout-stress arithmetic are unaffected.",
      correction: "Added ratio-of-sums day-cluster inference and three-day moving-block sensitivity for the v1 top 20.",
      id: "AUDIT-002",
      reproducibleExample: "A one-trade day and a 100-trade day receive equal weight in v1 despite targeting return per stake.",
      severity: "medium",
      title: "Inference did not target trade-weighted profit per stake",
    },
    {
      affectedFiles: ["src/strategy-search-engine.js", "research/results/development-screen-v1-summary.json"],
      affectedResults: "Rejection-reason wording only.",
      correction: "Audit reports evaluated bootstrap/neighbor counts separately from non-shortlisting.",
      id: "AUDIT-003",
      reproducibleExample: "12,012 rows carry a bootstrap failed-or-not-shortlisted label, but only 20 contain a bootstrap result.",
      severity: "medium",
      title: "Non-evaluation and evaluated failure shared one label",
    },
    {
      affectedFiles: ["src/strategy-search-engine.js", "data/research/development-screen-v1/ledger.final.jsonl"],
      affectedResults: "Persisted worst-stress field for no-trade scenarios; qualification remained fail-closed.",
      correction: "Independent validation reconstructs the non-finite sentinel from scenario counts and records the affected row count without rewriting v1.",
      id: "AUDIT-004",
      reproducibleExample: "JSON.stringify({ minimum: -Infinity }) produces {\"minimum\":null}.",
      severity: "low",
      title: "JSON encoded negative-infinity no-trade minima as null",
    },
  ],
  generatedAtUtc: new Date().toISOString(),
  historicalCollection,
  kind: "development-screen-v1-independent-audit-v2",
  ledgerAudit: ledger.result,
  noTradingActions: true,
  originalVsCorrected: {
    correctedTop20EvidencePasses:
      targetedStatisticalAudit.correctedCombinedEvidencePassed,
    fullFrozenBatchRerunJustified: false,
    materialOutcomeChange: false,
    originalDevelopmentQualified: summary.counts.developmentQualified,
    reason: "All 12,012 fail deterministic 0.80 stress consistency; scenario counts and top-20 replays match, while corrected inference also yields zero passes.",
  },
  recommendation: {
    decision: "STOP_EXPANDING_THE_SAME_1HZ100V_SHORT_TICK_TECHNICAL_INDICATOR_APPROACH",
    nextUseOfMoreData: "Replication and null calibration only, not automatic parameter expansion.",
  },
  recordedObservationAudit,
  reviewedBaseline: {
    originalMutableManifestSha256: summary.dataset.manifestSha256,
    productAvailabilityReportSha256: digest(dataAvailabilityReportBytes),
    protocolPath: path.relative(projectRoot, protocolPath).replaceAll("\\", "/"),
    protocolSha256: digest(protocolBytes),
    resultCommit: "5d93aaf097e45edd74853d41245d446322c397ea",
    searchCodeCommit: summary.code.commit,
    summaryPath: path.relative(projectRoot, summaryPath).replaceAll("\\", "/"),
    summarySha256: digest(summaryBytes),
  },
  schemaVersion: 2,
  searchCoverageConclusion: {
    configurations: summary.counts.uniqueConfigurationsCompleted,
    genuinelyDifferentDirectionalFamilies: 7,
    independentObservations: "Unknown; at most 30 calendar-day clusters were used for inference.",
    signalTransformations: 5,
    uniqueOutcomeCountSignatures: ledger.result.uniqueOutcomeCountSignatures,
  },
  sources: [
    {
      title: "Deriv trading terms",
      url: "https://deriv.com/terms-and-conditions/trading-terms",
      use: "next-tick entry rule and pricing bias",
    },
    {
      title: "Deriv Synthetic Indices",
      url: "https://deriv.com/markets/derived-indices/synthetic-indices",
      use: "RNG, tick cadence, instrument mechanisms, and technical-analysis limitation",
    },
    {
      title: "Deriv Price Proposal API",
      url: "https://developers.deriv.com/docs/trading/proposal/",
      use: "tick versus clock duration units and public proposal semantics",
    },
    {
      title: "Deriv contracts_for schema",
      url: "https://raw.githubusercontent.com/deriv-com/deriv-api-schemas/master/schemas/contracts_for_response.schema.json",
      use: "contract type, expiry type, and duration capability fields",
    },
    {
      title: "Deriv open-contract schema",
      url: "https://raw.githubusercontent.com/deriv-com/deriv-api-schemas/master/schemas/proposal_open_contract_response.schema.json",
      use: "entry/exit, profit, payout, status, cancellation, and tick stream fields",
    },
    {
      title: "How to Trade Synthetic Indices",
      url: "https://docs.deriv.com/marketing/2025/ebook-synthetics-en-hq.pdf",
      use: "worked five-tick entry/exit and gross-versus-net payout example",
    },
    {
      title: "White (2000), A Reality Check for Data Snooping",
      url: "https://doi.org/10.1111/1468-0262.00152",
      use: "full-search data-snooping context",
    },
    {
      title: "Politis and Romano (1994), The Stationary Bootstrap",
      url: "https://doi.org/10.1080/01621459.1994.10476870",
      use: "dependence-aware resampling context",
    },
    {
      title: "Hansen (2005), A Test for Superior Predictive Ability",
      url: "https://doi.org/10.1198/073500105000000063",
      use: "multiple-strategy predictive-ability context",
    },
    {
      title: "Bailey et al., The Probability of Backtest Overfitting",
      url: "https://escholarship.org/uc/item/4w1110bb",
      use: "selection-overfitting and repeated-search context",
    },
  ],
  sourceAccessDate: "2026-10-08",
  statisticalConclusion: {
    deterministicRulesCorrectlyImplementedAsWritten: true,
    fullyJustifiedByThirtyDays: false,
    inferentialRulesFullyAlignedWithReportedEstimand: false,
    notes: [
      "Economic, stress, sample, and operational thresholds match the frozen protocol.",
      "Bonferroni direction is correct and conservative if raw p-values are valid.",
      "The 30-day independence/tail assumptions and original equal-day estimand are not established.",
      "Calendar coverage is fixed at 30 UTC days with a 20-active-day minimum; no separate first-to-last-trade elapsed-duration rule exists.",
      "Nearby robustness uses normalized parameter distance within sampled grids, not a predeclared one-coordinate neighborhood.",
    ],
  },
  targetedStatisticalAudit,
};

await mkdir(path.dirname(outputJsonPath), { recursive: true });
await writeFile(outputJsonPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
await writeAuditMarkdown(audit);
console.log(JSON.stringify({
  datasetContentSha256: audit.datasetSliceAudit.contentSha256,
  ledgerSha256: audit.ledgerAudit.ledgerSha256,
  materialOutcomeChange: audit.originalVsCorrected.materialOutcomeChange,
  outputJsonPath,
  outputMarkdownPath,
  targetedConfigurations: audit.targetedStatisticalAudit.targetedConfigurations,
}, null, 2));
