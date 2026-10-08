import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SETTLED_STATUSES = new Set(["won", "lost"]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function hashBrowserStrategyConfig(config) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(config)))
    .digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function finiteNumber(value, label) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be finite.`);
  return parsed;
}

function positiveNumber(value, label) {
  const parsed = finiteNumber(value, label);
  if (parsed <= 0) throw new Error(`${label} must be positive.`);
  return parsed;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function normalizeContractId(value) {
  const text = typeof value === "bigint" ? value.toString() : String(value ?? "");
  if (!/^[1-9]\d{0,30}$/.test(text)) {
    throw new Error("contractId must be a positive integer identity.");
  }
  return text;
}

function normalizeTransaction(run, transaction) {
  if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) {
    throw new Error("transaction must be an object.");
  }
  const accountId = requiredString(
    transaction.accountId ?? run.accountId,
    "accountId",
  );
  const contractId = normalizeContractId(
    transaction.contractId ?? transaction.contract_id,
  );
  const strategyHash = requiredString(
    transaction.strategyHash ?? run.strategyHash,
    "strategyHash",
  ).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(strategyHash)) {
    throw new Error("strategyHash must be a 64-character SHA-256 value.");
  }
  if (
    run.strategyHash !== undefined &&
    String(run.strategyHash).toLowerCase() !== strategyHash
  ) {
    throw new Error("transaction strategyHash conflicts with its run strategyHash.");
  }
  const variantId = requiredString(run.variantId, "variantId");
  const status = requiredString(
    transaction.settlementStatus ?? transaction.status,
    "settlement status",
  ).toLowerCase();
  if (!SETTLED_STATUSES.has(status)) {
    throw new Error('settlement status must be exactly "won" or "lost".');
  }
  const profit = finiteNumber(transaction.profit, "profit");
  const buyPrice = positiveNumber(transaction.buyPrice, "buyPrice");
  if ((status === "won" && profit <= 0) || (status === "lost" && profit > 0)) {
    throw new Error("settlement status conflicts with numeric profit.");
  }
  const timestampMs = Date.parse(transaction.settledAt ?? transaction.timestamp);
  if (!Number.isFinite(timestampMs)) {
    throw new Error("settlement timestamp must be a valid date.");
  }
  const entrySpot = transaction.entrySpot === undefined
    ? null
    : finiteNumber(transaction.entrySpot, "entrySpot");
  const exitSpot = transaction.exitSpot === undefined
    ? null
    : finiteNumber(transaction.exitSpot, "exitSpot");
  return {
    accountFingerprint: sha256Text(accountId),
    buyPrice,
    contractId,
    entrySpot,
    exitSpot,
    profit,
    status,
    strategyHash,
    timestamp: new Date(timestampMs).toISOString(),
    variantId,
  };
}

function sameSettlement(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateBrowserEvidence(runs) {
  if (!Array.isArray(runs)) throw new Error("Browser evidence must be an array of runs.");
  const byIdentity = new Map();
  const conflicted = new Set();
  const rejections = [];
  const conflicts = [];
  let inputRows = 0;
  let duplicateRows = 0;
  for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
    const run = runs[runIndex];
    const source = run?.evidenceFile ?? `run[${runIndex}]`;
    if (!Array.isArray(run?.transactions)) {
      rejections.push({ source, row: null, reason: "Run has no transactions array." });
      continue;
    }
    for (let row = 0; row < run.transactions.length; row += 1) {
      inputRows += 1;
      let normalized;
      try {
        normalized = normalizeTransaction(run, run.transactions[row]);
      } catch (error) {
        rejections.push({ source, row, reason: error.message });
        continue;
      }
      const identity = `${normalized.accountFingerprint}:${normalized.contractId}`;
      if (conflicted.has(identity)) {
        conflicts.push({ identity, source, row, reason: "Identity was already conflicting." });
        continue;
      }
      const previous = byIdentity.get(identity);
      if (!previous) {
        byIdentity.set(identity, normalized);
      } else if (sameSettlement(previous, normalized)) {
        duplicateRows += 1;
      } else {
        byIdentity.delete(identity);
        conflicted.add(identity);
        conflicts.push({
          identity,
          source,
          row,
          reason: "Conflicting records share the same account and contract identity.",
        });
      }
    }
  }
  return {
    transactions: [...byIdentity.values()].sort(
      (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
    ),
    audit: {
      acceptedUniqueSettlements: byIdentity.size,
      conflictingIdentities: conflicted.size,
      conflicts,
      duplicateRows,
      inputRows,
      rejectedRows: rejections.length,
      rejections,
      status:
        conflicted.size > 0
          ? "INVALID_CONFLICTING_IDENTITIES"
          : byIdentity.size === 0
            ? "NO_VALID_SETTLEMENTS"
            : "VALID",
      valid: conflicted.size === 0,
    },
  };
}

function wilsonInterval(wins, observations, z = 1.959963984540054) {
  if (observations === 0) return { lower: null, upper: null };
  const rate = wins / observations;
  const z2 = z * z;
  const denominator = 1 + z2 / observations;
  const center = (rate + z2 / (2 * observations)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt(
      (rate * (1 - rate)) / observations + z2 / (4 * observations ** 2),
    );
  return { lower: center - margin, upper: center + margin };
}

function streaks(transactions) {
  let currentType = null;
  let current = 0;
  let maxWins = 0;
  let maxLosses = 0;
  for (const transaction of transactions) {
    const type = transaction.profit > 0 ? "win" : "loss";
    current = type === currentType ? current + 1 : 1;
    currentType = type;
    if (type === "win") maxWins = Math.max(maxWins, current);
    else maxLosses = Math.max(maxLosses, current);
  }
  return { maxConsecutiveLosses: maxLosses, maxConsecutiveWins: maxWins };
}

function summarize(items) {
  const wins = items.filter((transaction) => transaction.profit > 0).length;
  const losses = items.length - wins;
  const grossWins = items
    .filter((transaction) => transaction.profit > 0)
    .reduce((sum, transaction) => sum + transaction.profit, 0);
  const grossLosses = -items
    .filter((transaction) => transaction.profit <= 0)
    .reduce((sum, transaction) => sum + transaction.profit, 0);
  const netProfit = grossWins - grossLosses;
  return {
    averageProfitPerTrade: items.length === 0 ? null : netProfit / items.length,
    grossLosses,
    grossWins,
    losses,
    netProfit,
    observations: items.length,
    profitFactor: grossLosses === 0 ? null : grossWins / grossLosses,
    totalStake: items.reduce((sum, transaction) => sum + transaction.buyPrice, 0),
    winRate: items.length === 0 ? null : wins / items.length,
    winRateWilson95: wilsonInterval(wins, items.length),
    wins,
    ...streaks(items),
  };
}

export function createBrowserLearningReport(runs) {
  const { transactions, audit } = validateBrowserEvidence(runs);
  const variants = new Map();
  const strategies = new Map();
  for (const transaction of transactions) {
    const variant = variants.get(transaction.variantId) ?? [];
    variant.push(transaction);
    variants.set(transaction.variantId, variant);
    const strategy = strategies.get(transaction.strategyHash) ?? [];
    strategy.push(transaction);
    strategies.set(transaction.strategyHash, strategy);
  }
  const targetWinRate = 0.8;
  const totals = summarize(transactions);
  return {
    generatedAt: new Date().toISOString(),
    branch: "Deriv Bot Builder demo observations",
    disclaimer:
      "Only deduplicated, identity-bound, settled Demo observations are counted. Results are not a guarantee of future performance.",
    evidenceAudit: audit,
    runs: runs.length,
    byVariant: Object.fromEntries(
      [...variants.entries()].sort(([left], [right]) => left.localeCompare(right)).map(
        ([variantId, items]) => [variantId, summarize(items)],
      ),
    ),
    byStrategyHash: Object.fromEntries(
      [...strategies.entries()].sort(([left], [right]) => left.localeCompare(right)).map(
        ([strategyHash, items]) => [strategyHash, summarize(items)],
      ),
    ),
    totals,
    target: {
      achieved: totals.winRate !== null && totals.winRate >= targetWinRate,
      targetWinRate,
      warning:
        "An 80% win-rate target cannot be engineered or promised; optimizing until historical data says 80% would create selection bias.",
    },
  };
}

async function main() {
  const runsDirectory = path.join(projectRoot, "data", "browser-bot", "runs");
  const files = (await readdir(runsDirectory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  }))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const runs = [];
  for (const file of files) {
    runs.push({
      ...JSON.parse(await readFile(path.join(runsDirectory, file), "utf8")),
      evidenceFile: file,
    });
  }
  const report = createBrowserLearningReport(runs);
  const reportPath = path.join(projectRoot, "data", "browser-bot", "learning-report.json");
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ reportPath, evidenceAudit: report.evidenceAudit, ...report.totals }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
