import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  runRangeBreakReconciliationProbe,
  validateRangeBreakReconciliationEvidence,
} from "./range-break-reconciliation.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultEvidencePath = path.join(
  projectRoot,
  "research",
  "evidence",
  "range-break-reconciliation-public-probe-2026-10-08-v2.json",
);

const args = process.argv.slice(2);
const collect = args.includes("--collect");
const verify = args.includes("--verify");
const outputIndex = args.indexOf("--output");
const outputValue = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
if (args.filter((arg) => arg === "--output").length > 1 ||
    (outputIndex >= 0 && (!outputValue || outputValue.startsWith("--"))) ||
    (collect && verify)) {
  throw new Error("Usage: node src/range-break-reconciliation-cli.js [--verify] [--output PATH]");
}
const valueIndexes = new Set(outputIndex >= 0 ? [outputIndex + 1] : []);
const unknown = args.filter((arg, index) =>
  !valueIndexes.has(index) && !["--collect", "--verify", "--output"].includes(arg));
if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
const evidencePath = outputIndex >= 0
  ? path.resolve(projectRoot, outputValue)
  : defaultEvidencePath;

if (collect) {
  if (outputIndex < 0) {
    throw new Error("Collection requires --output with a new immutable evidence path.");
  }
  const report = await runRangeBreakReconciliationProbe();
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({
    classification: report.classification,
    evidencePath,
    requestBudget: report.requestBudget,
  }, null, 2));
} else {
  const bytes = await readFile(evidencePath);
  const report = JSON.parse(bytes.toString("utf8"));
  console.log(JSON.stringify({
    evidencePath,
    mode: "offline-verification",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    validation: validateRangeBreakReconciliationEvidence(report),
  }, null, 2));
}
