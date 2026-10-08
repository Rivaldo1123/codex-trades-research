import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runGapAwareOfflineReplay } from "./offline-replay-gap.js";

if (process.argv.length !== 2) {
  console.error("Usage: node src/offline-replay-gap-cli.js (fixed, known-gap 30-day research window)");
  process.exitCode = 2;
} else {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const { report, reportPath } = await runGapAwareOfflineReplay({ projectRoot });
    console.log(JSON.stringify({
      reportPath,
      window: report.window,
      missingRanges: report.missingRanges,
      scenarios: report.candidateScenarioLedger.length,
      exploratoryScreen: report.exploratoryScreen,
    }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
