import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { auditForwardArchive } from "./forward-replay.js";
import {
  addRobustnessChecks,
  buildSearchFeatureCache,
  evaluateSearchConfiguration,
} from "./strategy-search-engine.js";
import {
  generateFrozenConfigurations,
  sha256,
  validateSearchProtocol,
} from "./strategy-search-config.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocolPath = path.join(
  projectRoot,
  "research",
  "protocols",
  "development-screen-v1.json",
);

function parseArgs(args) {
  const command = args[0] ?? "run";
  if (!["benchmark", "run", "status"].includes(command)) {
    throw new Error("Usage: strategy-search-cli.js <benchmark|run|status> [--count N]");
  }
  let count = 200;
  for (let index = 1; index < args.length; index += 2) {
    if (args[index] !== "--count" || args[index + 1] === undefined) {
      throw new Error("Usage: strategy-search-cli.js <benchmark|run|status> [--count N]");
    }
    count = Number(args[index + 1]);
  }
  if (!Number.isInteger(count) || count < 1 || count > 2_000) {
    throw new Error("Benchmark count must be from 1 through 2,000.");
  }
  return { command, count };
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameMissingRanges(actual, expected) {
  return (
    actual.length === expected.length &&
    actual.every(
      (range, index) =>
        range.fromEpoch === expected[index].fromEpoch &&
        range.toEpochExclusive === expected[index].toEpochExclusive &&
        range.missingSeconds === expected[index].missingTicks,
    )
  );
}

async function loadInputs() {
  const protocolBytes = await readFile(protocolPath);
  const protocol = validateSearchProtocol(
    JSON.parse(protocolBytes.toString("utf8")),
  );
  const generated = generateFrozenConfigurations(protocol);
  const loadedAt = performance.now();
  const { quotes, present, audit } = await auditForwardArchive({
    fromEpoch: protocol.dataset.fromEpochInclusive,
    projectRoot,
    symbol: protocol.dataset.symbol,
    toEpochExclusive: protocol.dataset.toEpochExclusive,
  });
  if (
    !sameMissingRanges(
      audit.missingRanges,
      protocol.dataset.knownMissingRanges,
    )
  ) {
    throw new Error("Dataset missing ranges differ from the frozen protocol.");
  }
  const auditedAt = performance.now();
  const cache = buildSearchFeatureCache({ present, protocol, quotes });
  const featuredAt = performance.now();
  return {
    audit,
    cache,
    configurations: generated.configurations,
    generatorAudit: generated.audit,
    loadTiming: {
      archiveAuditSeconds: (auditedAt - loadedAt) / 1_000,
      featureBuildSeconds: (featuredAt - auditedAt) / 1_000,
      totalPreparationSeconds: (featuredAt - loadedAt) / 1_000,
    },
    protocol,
    protocolSha256: digest(protocolBytes),
  };
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

function processMemory() {
  return Object.fromEntries(Object.entries(process.memoryUsage()));
}

function sampleConfigurations(configurations, count) {
  if (count >= configurations.length) return configurations;
  const sampled = [];
  const step = configurations.length / count;
  for (let index = 0; index < count; index += 1) {
    sampled.push(configurations[Math.floor(index * step)]);
  }
  return sampled;
}

async function benchmark(count) {
  const inputs = await loadInputs();
  const sample = sampleConfigurations(inputs.configurations, count);
  const started = performance.now();
  for (const config of sample) {
    evaluateSearchConfiguration({
      cache: inputs.cache,
      config,
      protocol: inputs.protocol,
    });
  }
  const elapsedEvaluationSeconds = (performance.now() - started) / 1_000;
  const secondsPerConfiguration =
    elapsedEvaluationSeconds / sample.length;
  const expectedEvaluationSeconds =
    secondsPerConfiguration * inputs.configurations.length;
  const report = {
    kind: "strategy-search-benchmark",
    generatedAt: new Date().toISOString(),
    batchId: inputs.protocol.batchId,
    protocolSha256: inputs.protocolSha256,
    code: codeState(),
    sampleConfigurations: sample.length,
    uniquePlannedConfigurations: inputs.configurations.length,
    evaluationWindowsPerConfiguration:
      inputs.protocol.evaluationWindows.length,
    stressScenariosPerWindow:
      inputs.protocol.parameterRanges.entryDelayTicks.length *
      inputs.protocol.parameterRanges.profitPerDollarOnWin.length,
    plannedBacktestRuns:
      inputs.configurations.length *
      inputs.protocol.evaluationWindows.length *
      inputs.protocol.parameterRanges.entryDelayTicks.length *
      inputs.protocol.parameterRanges.profitPerDollarOnWin.length,
    elapsedEvaluationSeconds,
    secondsPerConfiguration,
    expectedEvaluationSeconds,
    expectedTotalSeconds:
      inputs.loadTiming.totalPreparationSeconds + expectedEvaluationSeconds,
    recommendedWorkerCount: 1,
    rationale:
      "One worker shares the cached feature arrays and stays within the 4 GB host; process workers would duplicate the archive and cache.",
    preparation: inputs.loadTiming,
    dataset: inputs.audit,
    featureCache: inputs.cache.metadata,
    memory: processMemory(),
  };
  const outputDirectory = path.join(projectRoot, "research", "benchmarks");
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(
    outputDirectory,
    "development-screen-v1-benchmark.json",
  );
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ outputPath, ...report }, null, 2));
}

async function atomicJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(temporary, filePath);
}

async function readLedger(filePath) {
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(`Invalid checkpoint ledger JSON at line ${index + 1}.`);
    }
  }
  return records;
}

function compactResult(record) {
  return {
    configHash: record.configurationHash,
    evaluation: record.evaluation,
    family: record.family,
    strategyId: record.strategyId,
  };
}

function rejectionCounts(results) {
  const counts = {};
  for (const item of results) {
    for (const reason of item.evaluation.acceptanceFailures) {
      counts[reason] = (counts[reason] ?? 0) + 1;
    }
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function summarizeLeaderboard(item, configurationsByHash) {
  const config = configurationsByHash.get(item.configHash);
  return {
    strategyId: item.strategyId,
    configurationHash: item.configHash,
    family: item.family,
    configuration: Object.fromEntries(
      Object.entries(config).filter(
        ([name]) => !["configHash", "strategyId"].includes(name),
      ),
    ),
    qualifiesDevelopment: item.evaluation.qualifiesDevelopment,
    acceptanceFailures: item.evaluation.acceptanceFailures,
    averageNetProfitPerDollarStaked:
      item.evaluation.base.averageProfitPerDollarStaked,
    profitFactor: item.evaluation.base.profitFactor,
    maximumDrawdownStakeUnits:
      item.evaluation.drawdown.maximumDrawdownStakeUnits,
    longestLosingStreak: item.evaluation.drawdown.longestLosingStreak,
    trades: item.evaluation.base.trades,
    activeCalendarDays: item.evaluation.activity.activeCalendarDays,
    minimumStressAverageProfitPerDollarStaked:
      item.evaluation.minimumStressAverageProfitPerDollarStaked,
    minimumSevereStressAverageProfitPerDollarStaked:
      item.evaluation.minimumSevereStressAverageProfitPerDollarStaked,
    adjustedPValueBonferroni:
      item.evaluation.uncertainty.adjustedPValueBonferroni,
    dayBlockBootstrap: item.evaluation.dayBlockBootstrap ?? null,
    nearbySettings: item.evaluation.nearbySettings ?? null,
    performanceByWindowAndDelay: item.evaluation.scenarios,
  };
}

async function writeMarkdownSummary(summary, outputPath) {
  const rows = summary.leaderboard.slice(0, 10).map((item, index) => {
    const expectancy = Number.isFinite(item.averageNetProfitPerDollarStaked)
      ? item.averageNetProfitPerDollarStaked.toFixed(5)
      : "n/a";
    const stress = Number.isFinite(
      item.minimumStressAverageProfitPerDollarStaked,
    )
      ? item.minimumStressAverageProfitPerDollarStaked.toFixed(5)
      : "n/a";
    return `| ${index + 1} | ${item.strategyId} | ${item.family} | ${expectancy} | ${stress} | ${item.trades} | ${item.maximumDrawdownStakeUnits.toFixed(2)} | ${item.qualifiesDevelopment ? "yes" : "no"} |`;
  });
  const content = [
    "# Development screen v1 results",
    "",
    `Outcome: **${summary.outcome}**`,
    "",
    `Completed ${summary.counts.uniqueConfigurationsCompleted.toLocaleString()} distinct valid configurations and ${summary.counts.totalBacktestRunsCompleted.toLocaleString()} window/stress backtest runs.`,
    "",
    "All input history was previously viewed development data. Public ticks and assumed payouts are not historical executable account quotes. The protected prospective final window is not yet available.",
    "",
    "| Rank | Strategy | Family | Base avg/$ | Worst 0.80 stress avg/$ | Trades | Max DD | Development-qualified |",
    "|---:|---|---|---:|---:|---:|---:|---|",
    ...rows,
    "",
    "No order was placed or authorized by this research run.",
    "",
  ].join("\n");
  await writeFile(outputPath, content, "utf8");
}

async function runSearch() {
  const inputs = await loadInputs();
  const state = codeState();
  if (state.trackedWorktreeDirty) {
    throw new Error(
      "Main search requires committed tracked code and protocol. Commit the engineering checkpoint, then rerun.",
    );
  }
  const localDirectory = path.join(
    projectRoot,
    "data",
    "research",
    inputs.protocol.batchId,
  );
  const preliminaryPath = path.join(localDirectory, "ledger.preliminary.jsonl");
  const finalPath = path.join(localDirectory, "ledger.final.jsonl");
  const progressPath = path.join(localDirectory, "progress.json");
  await mkdir(localDirectory, { recursive: true });
  const previous = await readLedger(preliminaryPath);
  const priorByHash = new Map(
    previous.map((record) => [record.configurationHash, record]),
  );
  for (const record of previous) {
    if (
      record.protocolSha256 !== inputs.protocolSha256 ||
      record.codeCommit !== state.commit ||
      record.dataset?.manifestSha256 !== inputs.audit.manifestSha256
    ) {
      throw new Error("Checkpoint provenance differs from current code, protocol, or dataset.");
    }
  }
  const started = performance.now();
  let buffer = "";
  let completedThisRun = 0;
  for (const config of inputs.configurations) {
    if (priorByHash.has(config.configHash)) continue;
    let evaluation = null;
    let failure = null;
    try {
      evaluation = evaluateSearchConfiguration({
        cache: inputs.cache,
        config,
        protocol: inputs.protocol,
      });
    } catch (error) {
      failure = error.message;
    }
    const record = {
      trialId: `${inputs.protocol.batchId}:${config.configHash}`,
      strategyId: config.strategyId,
      family: config.family,
      configurationHash: config.configHash,
      configuration: Object.fromEntries(
        Object.entries(config).filter(
          ([name]) => !["configHash", "strategyId"].includes(name),
        ),
      ),
      codeCommit: state.commit,
      trackedWorktreeDirty: false,
      protocolSha256: inputs.protocolSha256,
      dataset: {
        fromEpochInclusive: inputs.protocol.dataset.fromEpochInclusive,
        manifestSha256: inputs.audit.manifestSha256,
        previouslyViewed: true,
        source: inputs.protocol.dataset.source,
        symbol: inputs.protocol.dataset.symbol,
        toEpochExclusive: inputs.protocol.dataset.toEpochExclusive,
      },
      randomSeed: null,
      executionAssumptions: {
        decisionCadenceSeconds:
          inputs.protocol.decisionSampling.utcCadenceSeconds,
        entryDelayTicks: inputs.protocol.parameterRanges.entryDelayTicks,
        oneOpenContract: true,
        payoutOnLossOrTie:
          inputs.protocol.parameterRanges.profitPerDollarOnLossOrTie,
        payoutOnWin: inputs.protocol.parameterRanges.profitPerDollarOnWin,
        stake: inputs.protocol.safety.fixedNormalizedStake,
        ties: inputs.protocol.decisionSampling.ties,
      },
      evaluation,
      failed: failure !== null,
      failureReason: failure,
    };
    buffer += JSON.stringify(record) + "\n";
    priorByHash.set(config.configHash, record);
    completedThisRun += 1;
    if (completedThisRun % 100 === 0) {
      await appendFile(preliminaryPath, buffer, "utf8");
      buffer = "";
      const completed = priorByHash.size;
      const elapsedSeconds = (performance.now() - started) / 1_000;
      const throughput = completedThisRun / Math.max(elapsedSeconds, 1e-9);
      const remaining = inputs.configurations.length - completed;
      const progress = {
        batchId: inputs.protocol.batchId,
        phase: "DEVELOPMENT_SEARCH",
        completedConfigurations: completed,
        failedTrials: [...priorByHash.values()].filter((item) => item.failed)
          .length,
        plannedConfigurations: inputs.configurations.length,
        completedBacktestRuns:
          completed *
          inputs.protocol.evaluationWindows.length *
          inputs.protocol.parameterRanges.entryDelayTicks.length *
          inputs.protocol.parameterRanges.profitPerDollarOnWin.length,
        configurationsPerSecond: throughput,
        estimatedRemainingSeconds: remaining / Math.max(throughput, 1e-9),
        updatedAt: new Date().toISOString(),
      };
      await atomicJson(progressPath, progress);
      console.log(JSON.stringify(progress));
    }
  }
  if (buffer) await appendFile(preliminaryPath, buffer, "utf8");
  const records = [...priorByHash.values()];
  if (records.length !== inputs.configurations.length) {
    throw new Error(
      `Search checkpoint has ${records.length} trials; expected ${inputs.configurations.length}.`,
    );
  }
  const failedTrials = records.filter((record) => record.failed);
  const successful = records.filter((record) => !record.failed).map(compactResult);
  if (failedTrials.length > 0) {
    throw new Error(
      `${failedTrials.length} strategy trials failed. Preserve the ledger and diagnose before finalizing.`,
    );
  }
  const configurationsByHash = new Map(
    inputs.configurations.map((config) => [config.configHash, config]),
  );
  const ranked = addRobustnessChecks({
    configurationsByHash,
    protocol: inputs.protocol,
    results: successful,
  });
  let finalContent = "";
  for (const item of successful) {
    const original = priorByHash.get(item.configHash);
    finalContent +=
      JSON.stringify({
        ...original,
        evaluation: item.evaluation,
        finalAssessment: true,
      }) + "\n";
  }
  try {
    await writeFile(finalPath, finalContent, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await readLedger(finalPath);
    if (existing.length !== successful.length) {
      throw new Error("Existing final ledger is incomplete; preserve it and use a new batch ID.");
    }
  }
  const qualifies = ranked.filter(
    (item) => item.evaluation.qualifiesDevelopment,
  );
  const familyBest = Object.fromEntries(
    Object.entries(Object.groupBy(ranked, (item) => item.family)).map(
      ([family, items]) => [
        family,
        summarizeLeaderboard(items[0], configurationsByHash),
      ],
    ),
  );
  const elapsedSeconds = (performance.now() - started) / 1_000;
  const totalRuns =
    successful.length *
    inputs.protocol.evaluationWindows.length *
    inputs.protocol.parameterRanges.entryDelayTicks.length *
    inputs.protocol.parameterRanges.profitPerDollarOnWin.length;
  const outcome =
    qualifies.length > 0
      ? "INCONCLUSIVE_MORE_NEW_DATA_REQUIRED"
      : "NO_RELIABLE_EDGE_FOUND";
  const summary = {
    kind: "strategy-development-search-summary",
    generatedAt: new Date().toISOString(),
    outcome,
    batchId: inputs.protocol.batchId,
    code: state,
    protocol: {
      path: path.relative(projectRoot, protocolPath).replaceAll("\\", "/"),
      sha256: inputs.protocolSha256,
      acceptanceRules: inputs.protocol.acceptanceRules,
      protectedFinalEvaluation: inputs.protocol.protectedFinalEvaluation,
    },
    dataset: {
      ...inputs.audit,
      previouslyViewedDevelopmentData: true,
      executableHistoricalContractQuotes: false,
    },
    counts: {
      strategyFamilies: Object.keys(inputs.protocol.searchBudget.families).length,
      uniqueConfigurationsPlanned:
        inputs.protocol.searchBudget.plannedUniqueConfigurations,
      uniqueConfigurationsCompleted: successful.length,
      evaluationWindows: inputs.protocol.evaluationWindows.length,
      stressScenariosPerWindow:
        inputs.protocol.parameterRanges.entryDelayTicks.length *
        inputs.protocol.parameterRanges.profitPerDollarOnWin.length,
      totalBacktestRunsCompleted: totalRuns,
      invalidGridCombinations: inputs.generatorAudit.invalidGridCombinations,
      duplicateConfigurations: inputs.generatorAudit.duplicateConfigurations,
      failedTrials: failedTrials.length,
      developmentQualified: qualifies.length,
      frozenFinalists: Math.min(
        qualifies.length,
        inputs.protocol.acceptanceRules.maximumFinalShortlist,
      ),
    },
    runtime: {
      elapsedSearchSecondsThisInvocation: elapsedSeconds,
      preparation: inputs.loadTiming,
      memoryAtCompletion: processMemory(),
      workerCount: 1,
    },
    rejectionReasonCounts: rejectionCounts(successful),
    familyBest,
    leaderboard: ranked.slice(0, 20).map((item) =>
      summarizeLeaderboard(item, configurationsByHash),
    ),
    finalists: qualifies
      .slice(0, inputs.protocol.acceptanceRules.maximumFinalShortlist)
      .map((item) => summarizeLeaderboard(item, configurationsByHash)),
    evidenceLimitations: [
      "All searched ticks were previously viewed development data.",
      "Historical public prices are not executable account proposals or fills.",
      "Payouts and entry delays are sensitivity assumptions, not observed historical contract terms.",
      "Bonferroni correction covers this frozen 12,012-configuration batch but cannot reconstruct every informal prior project search.",
      "The prospective final holdout has not occurred; no candidate can qualify for controlled demo validation from this batch alone."
    ],
    detailedLedger: {
      preliminaryPath: path.relative(projectRoot, preliminaryPath).replaceAll("\\", "/"),
      finalPath: path.relative(projectRoot, finalPath).replaceAll("\\", "/"),
      retainedLocallyOutsideGit: true,
      finalSha256: sha256(finalContent),
    },
  };
  const resultDirectory = path.join(projectRoot, "research", "results");
  await mkdir(resultDirectory, { recursive: true });
  const summaryPath = path.join(
    resultDirectory,
    "development-screen-v1-summary.json",
  );
  const markdownPath = path.join(
    resultDirectory,
    "development-screen-v1-summary.md",
  );
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
  await writeMarkdownSummary(summary, markdownPath);
  await atomicJson(progressPath, {
    batchId: inputs.protocol.batchId,
    phase: "COMPLETED",
    completedConfigurations: successful.length,
    plannedConfigurations: inputs.configurations.length,
    completedBacktestRuns: totalRuns,
    outcome,
    summaryPath,
    updatedAt: new Date().toISOString(),
  });
  console.log(
    JSON.stringify(
      {
        counts: summary.counts,
        leaderboard: summary.leaderboard.slice(0, 5),
        outcome,
        summaryPath,
      },
      null,
      2,
    ),
  );
}

async function status() {
  const statusPath = path.join(
    projectRoot,
    "data",
    "research",
    "development-screen-v1",
    "progress.json",
  );
  try {
    console.log(await readFile(statusPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    console.log(
      JSON.stringify(
        {
          batchId: "development-screen-v1",
          phase: "NOT_STARTED",
          state: "WAIT",
          reason: "No local search checkpoint exists.",
        },
        null,
        2,
      ),
    );
  }
}

async function main() {
  const { command, count } = parseArgs(process.argv.slice(2));
  if (command === "benchmark") return benchmark(count);
  if (command === "status") return status();
  return runSearch();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
