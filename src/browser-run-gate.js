import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runFallOnlySmaFlowBacktest } from "./browser-flow-backtest.js";
import {
  createBrowserLearningReport,
  hashBrowserStrategyConfig,
} from "./browser-learning.js";
import { loadArchivedTicks } from "./data-store.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_BROWSER_GATE_POLICY = Object.freeze({
  enabled: false,
  maximumArchiveAgeHours: 6,
  minimumApiEdge: 0.01,
  minimumApiTestObservations: 5_000,
  minimumBrowserObservations: 200,
  minimumProfitFactor: 1.1,
});

export const RETIRED_BROWSER_STRATEGY = Object.freeze({
  contract: "Fall",
  durationTicks: 1,
  entryDelayTicks: 1,
  fastSmaTicks: 10,
  slowSmaTicks: 20,
  stakeDemoUsd: 1,
  symbol: "1HZ100V",
  variantId: "one-tick-fall-signal",
});

export const RETIRED_BROWSER_STRATEGY_HASH = hashBrowserStrategyConfig(
  RETIRED_BROWSER_STRATEGY,
);

function requirement(code, pass, actual, required, explanation) {
  return { actual, code, explanation, pass, required };
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

export function evaluateBrowserRunGate({
  browserReport,
  browserVariantId = null,
  flowBacktestReport,
  now = new Date(),
  policy = DEFAULT_BROWSER_GATE_POLICY,
  expectedStrategyHash = RETIRED_BROWSER_STRATEGY_HASH,
}) {
  const totals = browserReport?.byStrategyHash?.[expectedStrategyHash] ?? {};
  const averageWin =
    totals.wins > 0 ? finiteOrNull(totals.grossWins / totals.wins) : null;
  const averageLoss =
    totals.losses > 0 ? finiteOrNull(totals.grossLosses / totals.losses) : null;
  const breakEvenWinRate =
    averageWin !== null && averageLoss !== null
      ? averageLoss / (averageWin + averageLoss)
      : null;
  const apiTest = flowBacktestReport?.test ?? {};
  const direction = flowBacktestReport?.parameters?.direction ?? "rise";
  const directionLabel = direction === "fall" ? "Fall" : "Rise";
  const lastArchiveEpoch = flowBacktestReport?.input?.lastEpoch;
  const archiveAgeHours = Number.isInteger(lastArchiveEpoch)
    ? (now.getTime() - lastArchiveEpoch * 1000) / 3_600_000
    : null;
  const requiredApiPositiveRate =
    breakEvenWinRate === null ? null : breakEvenWinRate + policy.minimumApiEdge;

  const requirements = [
    requirement(
      "legacy_gate_retired",
      policy.enabled === true,
      policy.enabled === true,
      true,
      "The old browser-flow gate is retired. A new frozen candidate must use the shared gap-aware research qualification path.",
    ),
    requirement(
      "browser_evidence_integrity",
      browserReport?.evidenceAudit?.valid === true &&
        browserReport?.evidenceAudit?.conflictingIdentities === 0,
      browserReport?.evidenceAudit?.status ?? null,
      "VALID",
      "Only non-conflicting account+contract identities bound to an exact strategy hash may count.",
    ),
    requirement(
      "browser_sample_size",
      Number.isInteger(totals.observations) &&
        totals.observations >= policy.minimumBrowserObservations,
      totals.observations ?? null,
      policy.minimumBrowserObservations,
      "Require a meaningful number of settled Demo contracts before trusting the observed rate.",
    ),
    requirement(
      "browser_confidence_above_break_even",
      breakEvenWinRate !== null &&
        Number.isFinite(totals.winRateWilson95?.lower) &&
        totals.winRateWilson95.lower > breakEvenWinRate,
      totals.winRateWilson95?.lower ?? null,
      breakEvenWinRate,
      "The conservative 95% lower win-rate bound must exceed the payout-implied break-even rate.",
    ),
    requirement(
      "browser_profit_factor",
      Number.isFinite(totals.profitFactor) &&
        totals.profitFactor >= policy.minimumProfitFactor,
      totals.profitFactor ?? null,
      policy.minimumProfitFactor,
      "Require a buffer above break-even instead of reacting to a marginally positive sample.",
    ),
    requirement(
      "api_test_sample_size",
      Number.isInteger(apiTest.observations) &&
        apiTest.observations >= policy.minimumApiTestObservations,
      apiTest.observations ?? null,
      policy.minimumApiTestObservations,
      "The independent untouched API test must contain enough one-tick observations.",
    ),
    requirement(
      "api_test_edge",
      requiredApiPositiveRate !== null &&
        Number.isFinite(apiTest.winRate) &&
        apiTest.winRate >= requiredApiPositiveRate &&
        Number.isFinite(apiTest.averageProfitPerDollarStake) &&
        apiTest.averageProfitPerDollarStake > 0,
      apiTest.winRate ?? null,
      requiredApiPositiveRate,
      `The exact ${directionLabel}-only 10/20 SMA flow must clear payout break-even by the safety margin and have positive simulated profit on the untouched test segment.`,
    ),
    requirement(
      "api_archive_freshness",
      archiveAgeHours !== null &&
        archiveAgeHours >= 0 &&
        archiveAgeHours <= policy.maximumArchiveAgeHours,
      archiveAgeHours,
      policy.maximumArchiveAgeHours,
      "Do not arm the browser bot from a stale tick archive.",
    ),
  ];
  const failed = requirements.filter((item) => !item.pass);
  const eligibleForSignalCheck = failed.length === 0;

  return {
    generatedAt: now.toISOString(),
    modules: {
      liveSavedWorkspace: "Codex Browser Learning - One-Shot Gate",
      validatedConditionalXml:
        direction === "fall"
          ? "dbot/Codex_Browser_Learning_OneTick_Fall_Signal.xml"
          : "dbot/Codex_Browser_Learning_OneTick_Rise.xml",
      browserVariantId,
      expectedStrategyHash,
    },
    mode: "Deriv Demo only",
    decision: eligibleForSignalCheck ? "READY_FOR_SIGNAL" : "WAIT",
    action: eligibleForSignalCheck
      ? `Use the validated conditional XML on the visible Demo account and let its internal 10/20 SMA gate decide whether to place one ${directionLabel} contract. Never bypass the Demo-account check.`
      : "Do not press Run. Obtain adequate historical data for this Bot Builder flow, then evaluate an explicit capped Demo forward batch.",
    eligibleForSignalCheck,
    evidence: {
      apiOneTickDirectionalGateTest: {
        averageProfitPerDollarStake:
          apiTest.averageProfitPerDollarStake ?? null,
        losses: apiTest.losses ?? null,
        netProfitPerDollarStake: apiTest.netProfitPerDollarStake ?? null,
        observations: apiTest.observations ?? null,
        parameters: flowBacktestReport?.parameters ?? null,
        winRate: apiTest.winRate ?? null,
        wins: apiTest.wins ?? null,
      },
      archiveAgeHours,
      browser: {
        averageLoss,
        averageWin,
        breakEvenWinRate,
        observations: totals.observations ?? null,
        profitFactor: totals.profitFactor ?? null,
        winRate: totals.winRate ?? null,
        winRateWilson95: totals.winRateWilson95 ?? null,
      },
    },
    failedRequirementCodes: failed.map((item) => item.code),
    requirements,
    safeguards: {
      automaticRepeat: false,
      contractDirection:
        direction === "fall"
          ? "Fall only when fast SMA (10 ticks) is below slow SMA (20 ticks)"
          : "Rise only when fast SMA (10 ticks) is above slow SMA (20 ticks)",
      maximumContractsPerRun: 1,
      stakeDemoUsd: 1,
    },
  };
}

async function main() {
  const runsDirectory = path.join(
    projectRoot,
    "data",
    "browser-bot",
    "runs",
  );
  const browserReportPath = path.join(
    projectRoot,
    "data",
    "browser-bot",
    "learning-report.json",
  );
  const runFiles = (await readdir(runsDirectory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  }))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const [runs, tickResult] = await Promise.all([
    Promise.all(
      runFiles.map((file) =>
        readFile(path.join(runsDirectory, file), "utf8").then((text) => ({
          ...JSON.parse(text),
          evidenceFile: file,
        })),
      ),
    ),
    loadArchivedTicks(projectRoot, "1HZ100V", { maxRows: 1_000_000 })
      .then((ticks) => ({ ticks, error: null }))
      .catch((error) => ({ ticks: null, error: error.message })),
  ]);
  const browserReport = createBrowserLearningReport(runs);
  await mkdir(path.dirname(browserReportPath), { recursive: true });
  await writeFile(
    browserReportPath,
    `${JSON.stringify(browserReport, null, 2)}\n`,
    "utf8",
  );
  const browserVariantId = "one-tick-fall-signal";
  const flowBacktestReport = tickResult.ticks
    ? runFallOnlySmaFlowBacktest(tickResult.ticks)
    : {
        blocked: true,
        error: `WAIT: checksummed historical evidence is unavailable: ${tickResult.error}`,
        input: { firstEpoch: null, lastEpoch: null, ticks: 0 },
        parameters: {
          ...RETIRED_BROWSER_STRATEGY,
          direction: "fall",
        },
        test: {},
      };
  const flowBacktestPath = path.join(
    projectRoot,
    "data",
    "browser-bot",
    "flow-backtest.json",
  );
  await writeFile(
    flowBacktestPath,
    `${JSON.stringify(flowBacktestReport, null, 2)}\n`,
    "utf8",
  );
  const gate = evaluateBrowserRunGate({
    browserReport,
    browserVariantId,
    flowBacktestReport,
    expectedStrategyHash: RETIRED_BROWSER_STRATEGY_HASH,
  });
  const outputPath = path.join(
    projectRoot,
    "data",
    "browser-bot",
    "run-gate.json",
  );
  await writeFile(outputPath, `${JSON.stringify(gate, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        action: gate.action,
        decision: gate.decision,
        failedRequirementCodes: gate.failedRequirementCodes,
        outputPath,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
