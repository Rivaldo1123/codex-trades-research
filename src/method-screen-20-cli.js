import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTwentyMethodScreen } from "./method-screen-20.js";

if (process.argv.length !== 2) {
  console.error("The fixed 20-method screen accepts no overrides.");
  process.exitCode = 2;
} else {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  runTwentyMethodScreen({ projectRoot }).then(({ report, reportPath }) => {
    console.log(JSON.stringify({ reportPath,
      methods: report.methodDefinitions.length, scenarios: report.scenarioLedger.length,
      provisionalTopThree: report.provisionalTopThree,
      developmentPassCount: report.developmentPassCount,
      topRows: report.ranking.slice(0, 3), decision: report.decision }, null, 2));
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
