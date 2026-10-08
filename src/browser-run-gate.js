import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runFallOnlySmaFlowBacktest } from "./browser-flow-backtest.js";
import { createBrowserLearningReport } from "./browser-learning.js";
import { loadArchivedTicks } from "./data-store.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_BROWSER_GATE_POLICY = Object.freeze({
  maximumArchiveAgeHours: 6,
  minimumApiEdge: 0.01,
  minimumApiTestObservations: 5_000,
  minimumBrowserObservations: 200,
  minimumProfitFactor: 1.1,
});

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
}) {
  const totals = browserVariantId
    ? browserReport?.byVariant?.[browserVariantId] ?? {}
    : browserReport?.totals ?? {};
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
  const runFiles = (await readdir(runsDirectory))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const [runs, ticks] = await Promise.all([
    Promise.all(
      runFiles.map((file) =>
        readFile(path.join(runsDirectory, file), "utf8").then(JSON.parse),
      ),
    ),
    loadArchivedTicks(projectRoot, "1HZ100V", { maxRows: 1_000_000 }),
  ]);
  const browserReport = createBrowserLearningReport(runs);
  await writeFile(
    browserReportPath,
    `${JSON.stringify(browserReport, null, 2)}\n`,
    "utf8",
  );
  const browserVariantId = "one-tick-fall-signal";
  const flowBacktestReport = runFallOnlySmaFlowBacktest(ticks);
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
