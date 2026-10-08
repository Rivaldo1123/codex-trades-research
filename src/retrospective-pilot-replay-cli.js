import path from "node:path";
import { fileURLToPath } from "node:url";

import { runRetrospectivePilotReplay } from "./retrospective-pilot-replay.js";

if (process.argv.length !== 2) {
  console.error("The retrospective pilot replay accepts no overrides.");
  process.exitCode = 2;
} else {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  runRetrospectivePilotReplay({ projectRoot }).then(({ report, reportPath }) => {
    console.log(JSON.stringify({ reportPath, decision: report.decision,
      scenarios: report.scenarioLedger.length,
      summary: report.scenarioLedger.filter((row) => row.profitOnWin === 0.8).map((row) =>
        ({ candidateId: row.candidateId, delayTicks: row.delayTicks,
          trades: row.fullWindow.settledTrades, wins: row.fullWindow.wins,
          losses: row.fullWindow.losses,
          winRate: row.fullWindow.winRate,
          averageProfitPerDollarStake: row.fullWindow.averageProfitPerDollarStake })) }, null, 2));
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
