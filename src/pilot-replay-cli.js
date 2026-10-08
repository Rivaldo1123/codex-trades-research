import path from "node:path";
import { fileURLToPath } from "node:url";

import { runPilotReplay } from "./pilot-replay.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocolPath = path.join(projectRoot, "data", "market",
  "forward-protocol-2026-10-07-v3-pilot.json");
const expectedProtocolSha256 = "3847b023023dbe5434fb23b71cad4a6d376f42fe26393e605348a1267722979e";

async function main() {
  if (process.argv.length !== 2) {
    throw new Error("The v3 pilot replay is pinned; no protocol, date or strategy overrides are accepted.");
  }
  const { report, reportPath } = await runPilotReplay({ projectRoot, protocolPath,
    expectedProtocolSha256 });
  console.log(JSON.stringify({ decision: report.decision, reason: report.reason,
    coverage: report.audit.coverage,
    observedGenuineSeconds: report.audit.observedGenuineSeconds,
    missingSeconds: report.audit.missingSeconds,
    scenarios: report.scenarioLedger.length, reportPath,
    botBuilderRunPermission: false, demoOrderPermission: false,
    realOrderPermission: false }, null, 2));
  if (report.decision === "INCONCLUSIVE") process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
