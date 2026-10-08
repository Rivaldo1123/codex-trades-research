import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCrossVolatilityScreen } from "./cross-volatility-screen.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const { report, reportPath } = await runCrossVolatilityScreen({ projectRoot,
    studyVersion: 2,
    onProgress: (progress) => process.stdout.write(`${JSON.stringify(progress)}\n`) });
  process.stdout.write(`${JSON.stringify({ reportPath, decision: report.decision,
    symbolCount: report.symbolCount, totalVerifiedTicks: report.totalVerifiedTicks,
    scenarioCount: report.scenarioCount, exploratoryHitCount: report.exploratoryHitCount })}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
}
