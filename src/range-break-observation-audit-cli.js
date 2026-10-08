import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  auditRangeBreakObservation,
  renderRangeBreakObservationAssessmentMarkdown,
} from "./range-break-observation-audit.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statusPath = path.join(projectRoot, "data", "range-break-observer", "status.json");
const protocolPath = path.join(
  projectRoot,
  "research",
  "protocols",
  "range-break-observation-v2.json",
);

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function resolveLocal(value, label) {
  const resolved = path.resolve(projectRoot, value);
  if (resolved !== projectRoot && !resolved.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error(`${label} must stay inside the project directory.`);
  }
  return resolved;
}

async function main() {
  const requestedManifest = argumentValue("--manifest");
  let manifestPath;
  if (requestedManifest) {
    manifestPath = resolveLocal(requestedManifest, "Manifest path");
  } else {
    let status;
    try {
      status = JSON.parse(await readFile(statusPath, "utf8"));
    } catch (error) {
      throw new Error(
        `Local Range Break status is unavailable (${error.message}). ` +
        "A public checkout can read the tracked compact assessment, but recomputation requires the exact ignored manifest and raw JSONL.",
      );
    }
    manifestPath = resolveLocal(status.manifestPath, "Manifest path");
  }
  let manifestBytes;
  try {
    manifestBytes = await readFile(manifestPath);
  } catch (error) {
    throw new Error(
      `Exact Range Break manifest is unavailable (${error.message}). ` +
      "Restore the checksum-identified local observation; do not substitute newly downloaded ticks.",
    );
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const requestedRaw = argumentValue("--raw");
  const rawPath = requestedRaw
    ? resolveLocal(requestedRaw, "Raw observation path")
    : path.join(path.dirname(manifestPath), manifest.rawFile);
  let rawBytes;
  try {
    rawBytes = await readFile(rawPath);
  } catch (error) {
    throw new Error(
      `Exact Range Break raw JSONL is unavailable (${error.message}). ` +
      "Restore the file matching the manifest hash; a new observation is not the same evidence.",
    );
  }
  const assessment = auditRangeBreakObservation({
    manifestBytes,
    protocolBytes: await readFile(protocolPath),
    rawBytes,
  });
  const rendered = `${JSON.stringify(assessment, null, 2)}\n`;
  const output = argumentValue("--output");
  if (output) {
    await writeFile(resolveLocal(output, "Output path"), rendered, { flag: "wx" });
  }
  const markdownOutput = argumentValue("--markdown-output");
  if (markdownOutput) {
    await writeFile(
      resolveLocal(markdownOutput, "Markdown output path"),
      renderRangeBreakObservationAssessmentMarkdown(assessment),
      { flag: "wx" },
    );
  }
  process.stdout.write(rendered);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
