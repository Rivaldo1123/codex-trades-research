import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectShortlistHistory, evaluateShortlistHistory,
  studyRootFor } from "./shortlist-historical-check.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2];
if (process.argv.length !== 3 || !["collect", "evaluate"].includes(command)) {
  throw new Error("Usage: node src/shortlist-historical-cli.js collect|evaluate");
}
try {
  const result = command === "collect" ? await collectShortlistHistory({ projectRoot,
    onProgress: (status) => {
      if (status.pagesStored % 25 === 0 && status.state === "RUNNING") {
        console.log(JSON.stringify({ state: status.state, symbol: status.currentSymbol,
          pagesStored: status.pagesStored, rowsStored: status.rowsStored }));
      }
    } }) : await evaluateShortlistHistory({ projectRoot });
  console.log(JSON.stringify({ state: result.report.state ?? result.report.decision,
    path: result.reportPath, studyRoot: studyRootFor(projectRoot),
    ...(command === "evaluate" ? { candidates: result.report.candidates.map((item) =>
      ({ symbol: item.symbol, decision: item.decision, failures: item.failures })) } : {}) }));
  if (result.report.state === "INCOMPLETE") process.exitCode = 2;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
