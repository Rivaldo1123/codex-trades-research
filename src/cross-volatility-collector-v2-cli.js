import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCrossVolatilityCollection } from "./cross-volatility-collector.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const { reportPath, report } = await runCrossVolatilityCollection({ projectRoot,
    studyVersion: 2,
    onProgress: (status) => {
      if (["BACKING_OFF", "FAILED", "COMPLETED", "INCOMPLETE"].includes(status.state) ||
          status.pagesStored % 10 === 0) {
        process.stdout.write(`${JSON.stringify({ state: status.state,
          currentSymbol: status.currentSymbol, symbolsCompleted: status.symbolsCompleted,
          pagesStored: status.pagesStored, rowsStored: status.rowsStored,
          retryAtUtc: status.retryAtUtc, lastError: status.lastError })}\n`);
      }
    } });
  process.stdout.write(`${JSON.stringify({ reportPath, state: report.state,
    symbolCount: report.symbolCount,
    totalObservedTicks: report.totalObservedTicks,
    totalExpectedTicks: report.totalExpectedTicks })}\n`);
  if (report.state !== "COMPLETED") process.exitCode = 2;
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
}
