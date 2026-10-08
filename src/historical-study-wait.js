import { setTimeout as delay } from "node:timers/promises";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseCliArgs, runHistoricalStudy } from "./historical-study.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marketDirectory = path.join(projectRoot, "data", "market");
const backfillStatusPath = path.join(marketDirectory, "historical-backfill-status.json");
const studyStatusPath = path.join(marketDirectory, "historical-study-status.json");

export function classifyBackfillState(backfill, { fromEpoch, toEpoch, symbol }) {
  if (
    backfill.fromEpoch !== fromEpoch ||
    backfill.toEpochExclusive !== toEpoch ||
    backfill.symbol !== symbol
  ) {
    throw new Error("Backfill status does not match the requested study window and symbol.");
  }
  if (backfill.state === "COMPLETED") return "STUDY";
  if (["FAILED", "INCOMPLETE", "PAUSED", "PARTIAL"].includes(backfill.state)) return "BLOCKED";
  if (["STARTING", "RUNNING", "BACKING_OFF"].includes(backfill.state)) return "WAIT";
  throw new Error(`Unrecognized backfill state: ${backfill.state}`);
}

async function writeStudyStatus(status) {
  await mkdir(marketDirectory, { recursive: true });
  const temporary = `${studyStatusPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...status, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  await rename(temporary, studyStatusPath);
}

function processIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  let status = { state: "WAITING", pid: process.pid, ...options };
  await writeStudyStatus(status);
  for (;;) {
    const backfill = JSON.parse(await readFile(backfillStatusPath, "utf8"));
    const action = classifyBackfillState(backfill, options);
    if (action === "BLOCKED") {
      status = {
        ...status,
        state: "BLOCKED",
        reason: `Backfill ended in ${backfill.state}; no study was run.`,
      };
      await writeStudyStatus(status);
      process.exitCode = 2;
      return;
    }
    if (action === "STUDY") {
      status = { ...status, state: "STUDYING" };
      await writeStudyStatus(status);
      const { report, reportPath } = await runHistoricalStudy({ projectRoot, ...options });
      status = {
        ...status,
        state: "COMPLETED",
        reportPath,
        selectedId: report.selection.selectedId,
        untouchedTest: report.untouchedTest,
      };
      await writeStudyStatus(status);
      console.log(JSON.stringify({ reportPath, selectedId: status.selectedId }));
      return;
    }
    if (!processIsRunning(backfill.pid)) {
      throw new Error("The historical backfill process is no longer running, but its status is not final.");
    }
    await delay(60_000);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    await writeStudyStatus({ state: "FAILED", pid: process.pid, error: error.message });
    console.error(error.message);
    process.exitCode = 1;
  });
}
