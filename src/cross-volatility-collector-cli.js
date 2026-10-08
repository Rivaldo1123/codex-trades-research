import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCrossVolatilityCollection } from "./cross-volatility-collector.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const { reportPath, report } = await runCrossVolatilityCollection({ projectRoot,
    onProgress: (status) => {
      if (status.state === "BACKING_OFF" || status.state === "FAILED" ||
          status.state === "COMPLETED" || status.pagesStored % 10 === 0) {
        process.stdout.write(`${JSON.stringify({ state: status.state,
          currentSymbol: status.currentSymbol, symbolsCompleted: status.symbolsCompleted,
          pagesStored: status.pagesStored, rowsStored: status.rowsStored,
          retryAtUtc: status.retryAtUtc, lastError: status.lastError })}\n`);
      }
    } });
  process.stdout.write(`${JSON.stringify({ reportPath, symbolCount: report.symbolCount,
    totalObservedTicks: report.totalObservedTicks })}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
}
