import path from "node:path";
import { fileURLToPath } from "node:url";

import { runFiftyMethodScreen } from "./method-screen-50.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const { report, reportPath } = await runFiftyMethodScreen({ projectRoot });
  process.stdout.write(`${JSON.stringify({ reportPath, decision: report.decision,
    methodCount: report.methodCount, scenarioCount: report.scenarioCount,
    developmentPassCount: report.developmentPassCount,
    provisionalTopThree: report.provisionalTopThree })}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
}
