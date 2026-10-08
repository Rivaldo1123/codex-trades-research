import path from "node:path";
import { fileURLToPath } from "node:url";

import { runAdditional500Screen } from "./method-screen-500.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const { report, reportPath } = await runAdditional500Screen({ projectRoot,
    onProgress: (progress) => process.stdout.write(`${JSON.stringify(progress)}\n`) });
  process.stdout.write(`${JSON.stringify({ reportPath, decision: report.decision,
    additionalMethods: report.additionalMethods, totalMethods: report.totalMethods,
    totalScenarios: report.totalScenarios,
    developmentPassCount: report.developmentPassCount,
    provisionalTopThree: report.provisionalTopThree })}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
}
