import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  runProductFeasibilityProbe,
  validateProductFeasibilityEvidence,
} from "./product-feasibility-probe.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutputPath = path.join(
  projectRoot,
  "research",
  "evidence",
  "product-feasibility-public-probe-2026-10-08-v1.json",
);

const args = process.argv.slice(2);
const collect = args.includes("--collect");
const verify = args.includes("--verify");
const outputIndex = args.indexOf("--output");
const outputValue = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
if (args.filter((arg) => arg === "--output").length > 1 ||
    (outputIndex >= 0 && (!outputValue || outputValue.startsWith("--"))) ||
    (collect && verify)) {
  throw new Error("Usage: node src/product-feasibility-probe-cli.js [--verify] [--output PATH]");
}
const valueIndexes = new Set(outputIndex >= 0 ? [outputIndex + 1] : []);
const unknownArgs = args.filter((arg, index) =>
  !valueIndexes.has(index) && !["--collect", "--verify", "--output"].includes(arg));
if (unknownArgs.length > 0) {
  throw new Error(`Unknown argument: ${unknownArgs[0]}`);
}
const outputPath = outputIndex >= 0
  ? path.resolve(projectRoot, outputValue)
  : defaultOutputPath;

if (collect) {
  if (outputIndex < 0 || outputPath === defaultOutputPath) {
    throw new Error("Collection requires --output with a new evidence path; existing evidence is immutable.");
  }
  const report = await runProductFeasibilityProbe();
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({
    mode: "bounded-public-collection",
    outputPath,
    requestBudget: report.requestBudget,
    relevantCatalog: report.catalog.relevant,
    historicalPointSampleStatus: report.historicalPointSample.status,
  }, null, 2));
} else {
  const bytes = await readFile(outputPath);
  const report = JSON.parse(bytes.toString("utf8"));
  const validation = validateProductFeasibilityEvidence(report);
  console.log(JSON.stringify({
    mode: "offline-verification",
    outputPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    validation,
  }, null, 2));
}
