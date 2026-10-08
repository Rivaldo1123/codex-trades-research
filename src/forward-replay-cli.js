import path from "node:path";
import { fileURLToPath } from "node:url";

import { runForwardReplay } from "./forward-replay.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocolPath = path.join(projectRoot, "data", "market", "forward-protocol-2026-10-07-v2.json");
const protocolSha256 = "5e5fbcc219f1071895e259ade4e6f603b43170087fcbea98d60545f6665ccc56";

async function main() {
  if (process.argv.length !== 2) {
    throw new Error("The v2 forward replay is pinned; no protocol or timing overrides are accepted.");
  }
  const { report, reportPath } = await runForwardReplay({
    projectRoot,
    protocolPath,
    expectedProtocolSha256: protocolSha256,
  });
  console.log(JSON.stringify({ decision: report.decision, reason: report.reason ?? null,
    coverage: report.audit.coverage, observedGenuineSeconds: report.audit.observedGenuineSeconds,
    missingSeconds: report.audit.missingSeconds, reportPath,
    botBuilderRunPermission: false }, null, 2));
  if (report.decision === "INCONCLUSIVE") process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
