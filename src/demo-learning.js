import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { strictFiniteNumber, strictPositiveInteger } from "./demo-contract-validation.js";

const IMMUTABLE_TRADE_FIELDS = [
  "accountFingerprint",
  "contractType",
  "currency",
  "direction",
  "duration",
  "durationUnit",
  "startedAt",
  "strategyHash",
  "symbol",
];
const STAGES = new Set(["intent", "pending", "uncertain", "reconciled", "settled", "correction"]);
const INITIAL_STAGES = new Set(["intent", "pending"]);
const ALLOWED_TRANSITIONS = new Map([
  ["intent", new Set(["pending", "uncertain", "reconciled"])],
  ["pending", new Set(["uncertain", "reconciled"])],
  ["uncertain", new Set(["uncertain", "reconciled", "settled"])],
  ["reconciled", new Set(["reconciled", "uncertain", "settled"])],
  ["settled", new Set(["settled", "correction"])],
]);

export async function readTradeEvents(filePath) {
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`Invalid JSON in demo journal line ${index + 1}.`);
      }
    });
}

export async function appendTradeEvent(filePath, event) {
  validateTradeJournal([...(await readTradeEvents(filePath)), event]);
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, "a");
  try {
    await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function conflictingValue(current, event, field) {
  return current[field] !== undefined && event[field] !== undefined &&
    JSON.stringify(current[field]) !== JSON.stringify(event[field]);
}

function settlementSignature(event) {
  return JSON.stringify({
    closedAt: event.closedAt ?? null,
    contractId: strictPositiveInteger(event.contractId, "Journal settlement contract ID"),
    outcomeKind: event.outcomeKind ?? "expiry",
    performanceEligible: event.performanceEligible ?? true,
    profit: strictFiniteNumber(event.profit, "Journal settlement profit"),
    status: event.status ?? null,
  });
}

function isTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validateEventIdentity(event, index) {
  if (!/^[a-f0-9]{64}$/.test(event.accountFingerprint ?? "") ||
      !/^[a-f0-9]{64}$/.test(event.strategyHash ?? "") ||
      !isTimestamp(event.eventAt)) {
    throw new Error(`Demo journal event ${index + 1} lacks a valid account, strategy, or event-time identity.`);
  }
}

function validateInitialEvent(event) {
  const expectedContractType = event.direction === "up"
    ? "CALL"
    : event.direction === "down"
      ? "PUT"
      : null;
  if (!isTimestamp(event.startedAt) ||
      !/^[A-Za-z0-9_]{2,30}$/.test(event.symbol ?? "") ||
      !/^[A-Z0-9]{3,10}$/.test(event.currency ?? "") ||
      event.contractType !== expectedContractType ||
      !Number.isSafeInteger(event.duration) || event.duration < 1 ||
      event.durationUnit !== "t") {
    throw new Error(`Initial demo journal intent ${event.tradeId} has incomplete contract identity.`);
  }
  strictFiniteNumber(event.maximumLoss ?? event.stake, "Initial maximum loss", {
    positive: true,
  });
}

export function validateTradeJournal(events) {
  if (!Array.isArray(events)) throw new Error("Demo journal must be an array of events.");
  const trades = new Map();
  const histories = new Map();
  const contractOwners = new Map();
  const transactionOwners = new Map();
  for (const [index, event] of events.entries()) {
    if (!event || typeof event !== "object" ||
        typeof event.tradeId !== "string" || event.tradeId.trim() === "" ||
        !STAGES.has(event.stage)) {
      throw new Error(`Invalid demo journal event at position ${index + 1}.`);
    }
    validateEventIdentity(event, index);
    const current = trades.get(event.tradeId) ?? { tradeId: event.tradeId };
    const history = histories.get(event.tradeId);
    if (!history) {
      if (!INITIAL_STAGES.has(event.stage)) {
        throw new Error(`Demo trade ${event.tradeId} must begin with a durable intent or pending record.`);
      }
      validateInitialEvent(event);
      if (Date.parse(event.eventAt) < Date.parse(event.startedAt)) {
        throw new Error(`Initial demo journal event precedes its trade start for ${event.tradeId}.`);
      }
    } else {
      if (history.releasedWithoutPurchase) {
        throw new Error(`Demo trade ${event.tradeId} cannot change after a verified no-purchase release.`);
      }
      if (!ALLOWED_TRANSITIONS.get(history.stage)?.has(event.stage)) {
        throw new Error(
          `Illegal demo journal transition ${history.stage} -> ${event.stage} for trade ${event.tradeId}.`,
        );
      }
      if (Date.parse(event.eventAt) < history.lastEventEpoch) {
        throw new Error(`Demo journal event time moved backwards for trade ${event.tradeId}.`);
      }
      if (event.stage === "settled" && !history.everReconciled) {
        throw new Error(`Demo trade ${event.tradeId} cannot settle before its broker contract is reconciled.`);
      }
    }
    for (const field of IMMUTABLE_TRADE_FIELDS) {
      if (conflictingValue(current, event, field)) {
        throw new Error(`Conflicting ${field} for demo trade ${event.tradeId}.`);
      }
    }
    if (conflictingValue(current, event, "contractId")) {
      throw new Error(`Conflicting contract identity for demo trade ${event.tradeId}.`);
    }
    if (event.contractId !== undefined && event.contractId !== null) {
      const id = String(strictPositiveInteger(event.contractId, "Journal contract ID"));
      const owner = contractOwners.get(id);
      if (owner && owner !== event.tradeId) {
        throw new Error(`Contract ${id} is assigned to multiple demo trades.`);
      }
      contractOwners.set(id, event.tradeId);
    }
    if (event.transactionId !== undefined && event.transactionId !== null) {
      const id = String(event.transactionId);
      if (id.trim() === "") throw new Error("Journal transaction ID cannot be blank.");
      const owner = transactionOwners.get(id);
      if (owner && owner !== event.tradeId) {
        throw new Error(`Transaction ${id} is assigned to multiple demo trades.`);
      }
      transactionOwners.set(id, event.tradeId);
    }

    const nextHistory = history ?? {
      everReconciled: false,
      lastEventEpoch: Date.parse(event.eventAt),
      releasedWithoutPurchase: false,
      stage: event.stage,
    };
    nextHistory.lastEventEpoch = Date.parse(event.eventAt);
    if (event.stage === "reconciled") {
      const contractIdentity = event.contractId ?? current.contractId;
      if (event.reconciliationStatus === "not_purchased") {
        if (contractIdentity !== undefined && contractIdentity !== null) {
          throw new Error(`A no-purchase release cannot retain a contract ID for trade ${event.tradeId}.`);
        }
        nextHistory.releasedWithoutPurchase = true;
      } else {
        strictPositiveInteger(contractIdentity, "Reconciled journal contract ID");
      }
      nextHistory.everReconciled = true;
    }

    if (event.stage === "settled") {
      if (!isTimestamp(event.closedAt) || !["won", "lost", "sold"].includes(event.status)) {
        throw new Error(`Malformed terminal settlement for demo trade ${event.tradeId}.`);
      }
      if (Date.parse(event.closedAt) < Date.parse(current.startedAt) ||
          Date.parse(event.closedAt) > Date.parse(event.eventAt)) {
        throw new Error(`Settlement chronology is invalid for demo trade ${event.tradeId}.`);
      }
      const settlementProfit = strictFiniteNumber(event.profit, "Journal settlement profit");
      if ((event.status === "won" && settlementProfit <= 0) ||
          (event.status === "lost" && settlementProfit >= 0) ||
          (event.status === "sold" && event.performanceEligible !== false)) {
        throw new Error(`Inconsistent terminal settlement for demo trade ${event.tradeId}.`);
      }
      if (current.settlementSignature &&
          current.settlementSignature !== settlementSignature(event)) {
        throw new Error(`Conflicting settlement records for demo trade ${event.tradeId}.`);
      }
      current.settlementSignature = settlementSignature(event);
    }
    if (event.stage === "correction") {
      if (!current.settlementSignature) {
        throw new Error(`A correction requires a prior settlement for demo trade ${event.tradeId}.`);
      }
      if (typeof event.correctionId !== "string" || event.correctionId.trim() === "" ||
          typeof event.correctedAt !== "string" || Number.isNaN(Date.parse(event.correctedAt))) {
        throw new Error(`Malformed correction for demo trade ${event.tradeId}.`);
      }
      if (Date.parse(event.correctedAt) < Date.parse(current.closedAt) ||
          Date.parse(event.correctedAt) > Date.parse(event.eventAt)) {
        throw new Error(`Correction chronology is invalid for demo trade ${event.tradeId}.`);
      }
      const adjustment = strictFiniteNumber(event.profitAdjustment, "Journal profit adjustment");
      current.settlementAdjustments ??= [];
      if (current.settlementAdjustments.some((item) => item.correctionId === event.correctionId)) {
        const prior = current.settlementAdjustments.find((item) => item.correctionId === event.correctionId);
        if (prior.profitAdjustment !== adjustment || prior.correctedAt !== event.correctedAt) {
          throw new Error(`Conflicting correction ${event.correctionId} for demo trade ${event.tradeId}.`);
        }
      } else {
        current.settlementAdjustments.push({
          correctedAt: event.correctedAt,
          correctionId: event.correctionId,
          profitAdjustment: adjustment,
        });
      }
      current.realizedProfit = strictFiniteNumber(current.profit, "Journal settlement profit") +
        current.settlementAdjustments.reduce((sum, item) => sum + item.profitAdjustment, 0);
      trades.set(event.tradeId, current);
      histories.set(event.tradeId, nextHistory);
      continue;
    }

    const next = { ...current, ...event };
    if (event.stage === "settled") {
      next.profit = strictFiniteNumber(event.profit, "Journal settlement profit");
      next.realizedProfit = next.profit +
        (next.settlementAdjustments ?? []).reduce((sum, item) => sum + item.profitAdjustment, 0);
    }
    trades.set(event.tradeId, next);
    if (event.stage !== "correction") nextHistory.stage = event.stage;
    histories.set(event.tradeId, nextHistory);
  }
  return [...trades.values()];
}

export function groupTrades(events) {
  return validateTradeJournal(events);
}

export function assertTradeJournalAccount(events, accountFingerprint) {
  if (typeof accountFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(accountFingerprint)) {
    throw new Error("Current demo account fingerprint is invalid.");
  }
  validateTradeJournal(events);
  const incompatible = events.find((event) =>
    event.accountFingerprint !== accountFingerprint);
  if (incompatible) {
    throw new Error(
      "Demo journal belongs to another or unknown account; use a separate journal and risk state.",
    );
  }
}

function mean(values) {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function createLearningReport(events) {
  const allTrades = groupTrades(events);
  const settled = allTrades.filter(
    (trade) => trade.stage === "settled" && Number.isFinite(trade.realizedProfit) &&
      trade.performanceEligible !== false,
  );
  const wins = settled.filter((trade) => trade.realizedProfit > 0);
  const losses = settled.filter((trade) => trade.realizedProfit < 0);
  const pushes = settled.filter((trade) => trade.realizedProfit === 0);
  const profits = settled.map((trade) => trade.realizedProfit);

  const byDirection = Object.fromEntries(
    ["up", "down"].map((direction) => {
      const trades = settled.filter((trade) => trade.direction === direction);
      const directionWins = trades.filter((trade) => trade.realizedProfit > 0).length;
      return [
        direction,
        {
          averageProfit: mean(trades.map((trade) => trade.realizedProfit)),
          settledTrades: trades.length,
          winRate: trades.length === 0 ? null : directionWins / trades.length,
        },
      ];
    }),
  );

  return {
    automaticParameterChanges: false,
    generatedAt: new Date().toISOString(),
    methodology:
      "Forward demo outcomes only. Results do not imply real-money profitability.",
    totals: {
      averageProfit: mean(profits),
      losses: losses.length,
      netProfit: profits.reduce((sum, value) => sum + value, 0),
      pushes: pushes.length,
      settledTrades: settled.length,
      winRate: settled.length === 0 ? null : wins.length / settled.length,
      wins: wins.length,
    },
    byDirection,
  };
}

export async function writeLearningReport(filePath, report) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
