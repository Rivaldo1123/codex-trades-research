import {
  settlementJournalEvent,
  strictFiniteNumber,
  strictPositiveInteger,
  validateContractIdentity,
} from "./demo-contract-validation.js";
import { groupTrades } from "./demo-learning.js";
import { isUnresolvedDemoTrade } from "./demo-risk.js";

function statementContractId(transaction) {
  try {
    return strictPositiveInteger(
      transaction.contract_id ?? transaction.contractId,
      "Statement contract ID",
    );
  } catch {
    return null;
  }
}

function statementMatchesTrade(transaction, trade, nowEpoch) {
  if (String(transaction.action_type ?? transaction.actionType ?? "").toLowerCase() !== "buy") {
    return false;
  }
  let transactionEpoch;
  let amount;
  try {
    transactionEpoch = strictPositiveInteger(
      transaction.transaction_time ?? transaction.transactionTime,
      "Statement transaction time",
    );
    amount = Math.abs(strictFiniteNumber(transaction.amount, "Statement amount"));
  } catch {
    return false;
  }
  const startedEpoch = Math.floor(Date.parse(trade.startedAt) / 1_000);
  if (!Number.isSafeInteger(startedEpoch) || transactionEpoch < startedEpoch - 5 ||
      transactionEpoch > nowEpoch) {
    return false;
  }
  const maximumLoss = strictFiniteNumber(
    trade.maximumLoss ?? trade.buyPrice ?? trade.stake,
    "Intended maximum loss",
    { positive: true },
  );
  return Math.abs(amount - maximumLoss) <= 1e-8;
}

function normalizeStatementResult(result) {
  if (Array.isArray(result)) {
    return {
      coverage: { complete: false, reason: "UNPAGINATED_STATEMENT_RESULT" },
      transactions: result,
    };
  }
  if (!result || !Array.isArray(result.transactions) ||
      !result.coverage || typeof result.coverage.complete !== "boolean") {
    throw new Error("Broker statement did not include verifiable pagination coverage.");
  }
  return result;
}

function compatibleAccount(trade, accountFingerprint) {
  return typeof accountFingerprint === "string" && /^[a-f0-9]{64}$/.test(accountFingerprint) &&
    trade.accountFingerprint === accountFingerprint;
}

async function reconcileKnownContract({
  accountFingerprint,
  appendEvent,
  client,
  now,
  trade,
  appended,
  blockers,
}) {
  let contract;
  try {
    contract = await client.getOpenContract(strictPositiveInteger(
      trade.contractId,
      "Journal contract ID",
    ));
    validateContractIdentity(contract, trade, { expectedContractId: trade.contractId });
  } catch (error) {
    blockers.push({
      tradeId: trade.tradeId,
      reason: `Could not establish compatible contract outcome: ${error.message}`,
    });
    return;
  }

  const status = String(contract.status ?? "").toLowerCase();
  const terminal = Number(contract.is_sold) === 1 ||
    ["won", "lost", "sold", "cancelled"].includes(status);
  if (terminal) {
    try {
      const event = settlementJournalEvent(trade, contract, now);
      await appendEvent(event);
      appended.push(event);
    } catch (error) {
      blockers.push({
        tradeId: trade.tradeId,
        reason: `Could not validate broker outcome: ${error.message}`,
      });
    }
    return;
  }

  if (trade.stage !== "reconciled" ||
      trade.reconciliationStatus !== "broker_confirmed_open") {
    const event = {
      accountFingerprint,
      buyPrice: strictFiniteNumber(
        contract.buy_price ?? trade.buyPrice ?? trade.maximumLoss,
        "Broker buy price",
        { positive: true },
      ),
      contractId: strictPositiveInteger(
        contract.contract_id ?? contract.contractId ?? trade.contractId,
        "Broker contract ID",
      ),
      eventAt: now.toISOString(),
      maximumLoss: strictFiniteNumber(
        contract.buy_price ?? trade.maximumLoss ?? trade.stake,
        "Broker maximum loss",
        { positive: true },
      ),
      reconciliationStatus: "broker_confirmed_open",
      stage: "reconciled",
      strategyHash: trade.strategyHash,
      tradeId: trade.tradeId,
    };
    await appendEvent(event);
    appended.push(event);
  }
  blockers.push({
    tradeId: trade.tradeId,
    reason: "The reconciled broker contract is still open.",
  });
}

async function compatibleStatementMatches({ client, rows, trade }) {
  const compatible = [];
  const indeterminate = [];
  for (const row of rows) {
    const contractId = statementContractId(row);
    if (contractId === null) {
      indeterminate.push("matching statement row identity cannot be established");
      continue;
    }
    try {
      const contract = await client.getOpenContract(contractId);
      validateContractIdentity(contract, trade, {
        expectedContractId: contractId,
        requireDurationEvidence: true,
      });
      compatible.push({ contract, contractId, row });
    } catch (error) {
      indeterminate.push(error.message);
    }
  }
  return { compatible, indeterminate };
}

export async function reconcileUnresolvedDemoTrades({
  accountFingerprint,
  client,
  events,
  appendEvent,
  now = new Date(),
  noPurchaseGraceSeconds = 120,
  noPurchaseRepeatSeconds = 30,
}) {
  if (typeof appendEvent !== "function") {
    throw new Error("Demo reconciliation requires an append-only journal callback.");
  }
  let unresolved;
  try {
    unresolved = groupTrades(events).filter(isUnresolvedDemoTrade);
  } catch (error) {
    return {
      appended: [],
      blockers: [{ tradeId: null, reason: `Demo journal integrity failure: ${error.message}` }],
      unresolved: null,
    };
  }
  const appended = [];
  const blockers = [];
  if (unresolved.length === 0) return { appended, blockers, unresolved: 0 };

  const eligible = [];
  for (const trade of unresolved) {
    if (!compatibleAccount(trade, accountFingerprint)) {
      blockers.push({
        tradeId: trade.tradeId,
        reason: "The unresolved trade has missing or incompatible account identity.",
      });
    } else {
      eligible.push(trade);
    }
  }
  if (eligible.length === 0) {
    return { appended, blockers, unresolved: unresolved.length };
  }

  const withoutContract = eligible.filter(
    (trade) => trade.contractId === undefined || trade.contractId === null,
  );
  let statementResult = { transactions: [], coverage: { complete: true, pages: 0 } };
  if (withoutContract.length > 0) {
    const startEpoch = Math.max(0, Math.min(...withoutContract.map((trade) =>
      Math.floor(Date.parse(trade.startedAt) / 1_000))) - 10);
    try {
      statementResult = normalizeStatementResult(await client.getStatement({
        actionType: "buy",
        dateFrom: startEpoch,
        dateTo: Math.floor(now.getTime() / 1_000),
        limit: 999,
      }));
    } catch (error) {
      for (const trade of withoutContract) {
        blockers.push({
          tradeId: trade.tradeId,
          reason: `Broker statement reconciliation failed: ${error.message}`,
        });
      }
    }
  }

  const alreadyBound = new Set(
    groupTrades(events)
      .map((trade) => trade.contractId)
      .filter((value) => value !== undefined && value !== null)
      .map(String),
  );
  const nowEpoch = Math.floor(now.getTime() / 1_000);
  for (const original of eligible) {
    let trade = original;
    if (trade.contractId === undefined || trade.contractId === null) {
      if (blockers.some((item) => item.tradeId === trade.tradeId)) continue;
      const potentialRows = statementResult.transactions.filter((transaction) =>
        statementMatchesTrade(transaction, trade, nowEpoch) &&
        !alreadyBound.has(String(statementContractId(transaction))));
      const { compatible, indeterminate } = await compatibleStatementMatches({
        client,
        rows: potentialRows,
        trade,
      });
      if (compatible.length === 1 && potentialRows.length === 1 && indeterminate.length === 0) {
        const match = compatible[0];
        alreadyBound.add(String(match.contractId));
        const event = {
          accountFingerprint,
          buyPrice: Math.abs(strictFiniteNumber(match.row.amount, "Statement amount")),
          contractId: match.contractId,
          eventAt: now.toISOString(),
          maximumLoss: Math.abs(strictFiniteNumber(match.row.amount, "Statement amount")),
          reconciliationStatus: "broker_purchase_found_and_terms_verified",
          stage: "reconciled",
          strategyHash: trade.strategyHash,
          tradeId: trade.tradeId,
          transactionId: match.row.transaction_id ?? match.row.transactionId,
        };
        await appendEvent(event);
        appended.push(event);
        trade = { ...trade, ...event };
      } else if (potentialRows.length > 0) {
        blockers.push({
          tradeId: trade.tradeId,
          reason: compatible.length > 1 || potentialRows.length > 1
            ? "Multiple broker purchases could match by time and price; the purchase cannot be assigned safely."
            : `A possible broker purchase is incompatible or cannot be established safely: ${indeterminate.join("; ")}`,
        });
        continue;
      } else if (!statementResult.coverage.complete) {
        blockers.push({
          tradeId: trade.tradeId,
          reason: `Broker statement coverage is incomplete (${statementResult.coverage.reason ?? "unknown reason"}); absence cannot prove no purchase.`,
        });
        continue;
      } else {
        const ageSeconds = (now.getTime() - Date.parse(trade.startedAt)) / 1_000;
        if (ageSeconds < noPurchaseGraceSeconds) {
          blockers.push({
            tradeId: trade.tradeId,
            reason: "No broker purchase is visible yet; the uncertainty grace period has not elapsed.",
          });
          continue;
        }
        const priorCount = Number.isSafeInteger(trade.noPurchaseEvidenceCount)
          ? trade.noPurchaseEvidenceCount
          : 0;
        if (priorCount < 1) {
          const event = {
            accountFingerprint,
            eventAt: now.toISOString(),
            noPurchaseEvidenceCount: 1,
            reconciliationStatus: "statement_complete_no_match_observed",
            stage: "uncertain",
            statementCoverage: statementResult.coverage,
            strategyHash: trade.strategyHash,
            tradeId: trade.tradeId,
          };
          await appendEvent(event);
          appended.push(event);
          blockers.push({
            tradeId: trade.tradeId,
            reason: "One complete statement observation found no purchase; a later complete observation is required before release.",
          });
          continue;
        }
        const previousObservationEpoch = Math.floor(Date.parse(trade.eventAt) / 1_000);
        if (!Number.isSafeInteger(previousObservationEpoch) ||
            nowEpoch - previousObservationEpoch < noPurchaseRepeatSeconds) {
          blockers.push({
            tradeId: trade.tradeId,
            reason: "The second complete statement observation must be obtained later than the first.",
          });
          continue;
        }
        const event = {
          accountFingerprint,
          eventAt: now.toISOString(),
          noPurchaseEvidenceCount: priorCount + 1,
          reconciliationStatus: "not_purchased",
          stage: "reconciled",
          statementCoverage: statementResult.coverage,
          strategyHash: trade.strategyHash,
          tradeId: trade.tradeId,
        };
        await appendEvent(event);
        appended.push(event);
        continue;
      }
    }
    await reconcileKnownContract({
      accountFingerprint,
      appendEvent,
      appended,
      blockers,
      client,
      now,
      trade,
    });
  }
  return { appended, blockers, unresolved: unresolved.length };
}
