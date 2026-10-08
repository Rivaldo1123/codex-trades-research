import path from "node:path";
import { fileURLToPath } from "node:url";

import { runPublicPayoutProbe } from "./public-payout-probe.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const { report, reportPath } = await runPublicPayoutProbe({ projectRoot });
  process.stdout.write(`${JSON.stringify({ reportPath, quotes: report.quotes })}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
}
