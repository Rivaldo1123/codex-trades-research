import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function directionFromVariant(variantId) {
  if (typeof variantId !== "string") return null;
  if (variantId.includes("rise")) return "rise";
  if (variantId.includes("fall")) return "fall";
  return null;
}

export function reconstructRecordedTransaction({
  direction,
  durationTicks,
  quotesByEpoch,
  transaction,
}) {
  if (!new Set(["rise", "fall"]).has(direction) ||
      !Number.isSafeInteger(durationTicks) || durationTicks < 1 ||
      !(quotesByEpoch instanceof Map)) {
    throw new Error("Recorded transaction reconstruction inputs are invalid.");
  }
  const purchaseEpoch = Date.parse(transaction?.timestamp) / 1_000;
  if (!Number.isSafeInteger(purchaseEpoch)) {
    throw new Error("Recorded transaction timestamp is invalid.");
  }
  const entryEpoch = purchaseEpoch + 1;
  const exitEpoch = entryEpoch + durationTicks;
  const archivedEntrySpot = quotesByEpoch.get(entryEpoch);
  const archivedExitSpot = quotesByEpoch.get(exitEpoch);
  const entryMatches = archivedEntrySpot === Number(transaction.entrySpot);
  const exitMatches = archivedExitSpot === Number(transaction.exitSpot);
  const tie = Number(transaction.exitSpot) === Number(transaction.entrySpot);
  const won = direction === "rise"
    ? Number(transaction.exitSpot) > Number(transaction.entrySpot)
    : Number(transaction.exitSpot) < Number(transaction.entrySpot);
  const expectedProfit = won ? 0.9 : -1;
  return {
    accountingMatches:
      Number(transaction.buyPrice) === 1 && Number(transaction.profit) === expectedProfit,
    archivedEntrySpot: archivedEntrySpot ?? null,
    archivedExitSpot: archivedExitSpot ?? null,
    entryEpoch,
    entryMatches,
    exitEpoch,
    exitMatches,
    expectedProfit,
    purchaseEpoch,
    tie,
    timingAndSpotsMatch: entryMatches && exitMatches,
    won,
  };
}

export async function readRecordedBrowserRuns(projectRoot) {
  const directory = path.join(projectRoot, "data", "browser-bot", "runs");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const runs = [];
  for (const name of names) {
    const bytes = await readFile(path.join(directory, name));
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(parsed.transactions) || parsed.transactions.length === 0) continue;
    runs.push({
      direction: directionFromVariant(parsed.variantId),
      durationTicks: Number(parsed.durationTicks),
      file: name,
      fileSha256: sha256(bytes),
      source: parsed.source,
      symbol: parsed.symbol,
      transactions: parsed.transactions,
      variantId: parsed.variantId,
    });
  }
  return runs;
}

export function auditRecordedBrowserRuns(runs, quotesByEpoch) {
  const details = [];
  for (const run of runs) {
    if (run.symbol !== "1HZ100V" || run.source !== "Deriv Bot Builder demo account" ||
        !run.direction || !Number.isSafeInteger(run.durationTicks)) {
      throw new Error(`Recorded browser run ${run.file} has invalid identity metadata.`);
    }
    for (const transaction of run.transactions) {
      details.push({
        ...reconstructRecordedTransaction({
          direction: run.direction,
          durationTicks: run.durationTicks,
          quotesByEpoch,
          transaction,
        }),
        direction: run.direction,
        durationTicks: run.durationTicks,
        file: run.file,
      });
    }
  }
  return {
    accountingMatches: details.filter((item) => item.accountingMatches).length,
    fileEvidence: runs.map(({ file, fileSha256, transactions, variantId }) => ({
      file,
      fileSha256,
      transactions: transactions.length,
      variantId,
    })),
    losses: details.filter((item) => !item.won).length,
    records: details.length,
    ties: details.filter((item) => item.tie).length,
    timingAndSpotsMatch: details.filter((item) => item.timingAndSpotsMatch).length,
    wins: details.filter((item) => item.won).length,
  };
}
