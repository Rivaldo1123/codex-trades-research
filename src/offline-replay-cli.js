import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runOfflineReplay } from "./offline-replay.js";

if (process.argv.length !== 2) {
  console.error("Usage: node src/offline-replay-cli.js (no arguments; fixed 30-day research window)");
  process.exitCode = 2;
} else {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const { report, reportPath } = await runOfflineReplay({ projectRoot });
    console.log(JSON.stringify({
      reportPath,
      window: report.window,
      scenarios: report.candidateScenarioLedger.length,
      exploratoryScreen: report.exploratoryScreen,
    }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.code === "INCOMPLETE" ? 2 : 1;
  }
}
