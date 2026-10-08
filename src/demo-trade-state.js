import { groupTrades } from "./demo-learning.js";
import { isUnresolvedDemoTrade } from "./demo-risk.js";

const FINAL_CONTRACT_STATUSES = new Set(["won", "lost", "sold", "cancelled"]);

function positiveContractId(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("Broker reconciliation returned an invalid contract ID.");
  }
  return parsed;
}

function finite(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Broker reconciliation returned non-numeric ${label}.`);
  }
  return parsed;
}

function contractIsFinal(contract) {
  const status = String(contract.status ?? "").toLowerCase();
  return Number(contract.is_sold) === 1 || FINAL_CONTRACT_STATUSES.has(status);
}

function statementContractId(transaction) {
  const candidate =
    transaction.contract_id ??
    transaction.contractId ??
    transaction.reference_id ??
    transaction.referenceId;
  try {
    return positiveContractId(candidate);
  } catch {
    return null;
  }
}

function statementMatchesTrade(transaction, trade, nowEpoch) {
  if (String(transaction.action_type ?? transaction.actionType ?? "").toLowerCase() !== "buy") {
    return false;
  }
  const transactionEpoch = Number(
    transaction.transaction_time ?? transaction.transactionTime,
  );
  const startedEpoch = Math.floor(Date.parse(trade.startedAt) / 1_000);
  if (
    !Number.isSafeInteger(transactionEpoch) ||
    !Number.isSafeInteger(startedEpoch) ||
    transactionEpoch < startedEpoch - 5 ||
    transactionEpoch > nowEpoch
  ) {
    return false;
  }
  const amount = Math.abs(Number(transaction.amount));
  const maximumLoss = Number(
    trade.maximumLoss ?? trade.buyPrice ?? trade.stake,
  );
  if (
    Number.isFinite(maximumLoss) &&
    maximumLoss > 0 &&
    Number.isFinite(amount) &&
    Math.abs(amount - maximumLoss) > 1e-6
  ) {
    return false;
  }
  return true;
}

function settledEvent(trade, contract, now) {
  const contractId = positiveContractId(
    contract.contract_id ?? contract.contractId ?? trade.contractId,
  );
  if (trade.contractId && String(trade.contractId) !== String(contractId)) {
    throw new Error("Broker reconciliation returned a different contract identity.");
  }
  const status = String(contract.status ?? "").toLowerCase();
  if (!contractIsFinal(contract)) {
    throw new Error("Cannot create a settled event for an open contract.");
  }
  return {
    buyPrice: finite(
      contract.buy_price ?? contract.buyPrice ?? trade.buyPrice ?? trade.maximumLoss,
      "buy price",
    ),
    closedAt: new Date(
      Number.isFinite(Number(contract.exit_spot_time))
        ? Number(contract.exit_spot_time) * 1_000
        : now.getTime(),
    ).toISOString(),
    contractId,
    eventAt: now.toISOString(),
    exitSpot:
      contract.exit_spot === undefined && contract.exit_tick === undefined
        ? null
        : finite(contract.exit_spot ?? contract.exit_tick, "exit spot"),
    profit: finite(contract.profit, "settlement profit"),
    reconciled: true,
    stage: "settled",
    status,
    tradeId: trade.tradeId,
  };
}

async function reconcileKnownContract({
  appendEvent,
  client,
  now,
  trade,
  appended,
  blockers,
}) {
  let contract;
  try {
    contract = await client.getOpenContract(positiveContractId(trade.contractId));
  } catch (error) {
    blockers.push({
      tradeId: trade.tradeId,
      reason: `Could not establish contract outcome: ${error.message}`,
    });
    return;
  }
  if (contractIsFinal(contract)) {
    const event = settledEvent(trade, contract, now);
    await appendEvent(event);
    appended.push(event);
    return;
  }
  if (
    trade.stage !== "reconciled" ||
    trade.reconciliationStatus !== "broker_confirmed_open"
  ) {
    const event = {
      buyPrice: finite(
        contract.buy_price ?? trade.buyPrice ?? trade.maximumLoss,
        "buy price",
      ),
      contractId: positiveContractId(
        contract.contract_id ?? contract.contractId ?? trade.contractId,
      ),
      eventAt: now.toISOString(),
      maximumLoss: finite(
        contract.buy_price ?? trade.maximumLoss ?? trade.stake,
        "maximum loss",
      ),
      reconciliationStatus: "broker_confirmed_open",
      stage: "reconciled",
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

export async function reconcileUnresolvedDemoTrades({
  client,
  events,
  appendEvent,
  now = new Date(),
  noPurchaseGraceSeconds = 120,
}) {
  if (typeof appendEvent !== "function") {
    throw new Error("Demo reconciliation requires an append-only journal callback.");
  }
  const unresolved = groupTrades(events).filter(isUnresolvedDemoTrade);
  const appended = [];
  const blockers = [];
  if (unresolved.length === 0) return { appended, blockers, unresolved: 0 };

  const withoutContract = unresolved.filter(
    (trade) => trade.contractId === undefined || trade.contractId === null,
  );
  let statement = [];
  if (withoutContract.length > 0) {
    const startEpoch = Math.max(
      0,
      Math.min(...withoutContract.map((trade) => Math.floor(Date.parse(trade.startedAt) / 1_000))) - 10,
    );
    try {
      statement = await client.getStatement({
        actionType: "buy",
        dateFrom: startEpoch,
        dateTo: Math.floor(now.getTime() / 1_000),
        limit: 999,
      });
    } catch (error) {
      return {
        appended,
        blockers: unresolved.map((trade) => ({
          tradeId: trade.tradeId,
          reason: `Broker statement reconciliation failed: ${error.message}`,
        })),
        unresolved: unresolved.length,
      };
    }
  }

  const alreadyBound = new Set(
    groupTrades(events)
      .map((trade) => trade.contractId)
      .filter((value) => value !== undefined && value !== null)
      .map(String),
  );
  const nowEpoch = Math.floor(now.getTime() / 1_000);
  for (const original of unresolved) {
    let trade = original;
    if (trade.contractId === undefined || trade.contractId === null) {
      const potentialMatches = statement.filter((transaction) =>
        statementMatchesTrade(transaction, trade, nowEpoch),
      );
      const matches = potentialMatches.filter((transaction) => {
        const id = statementContractId(transaction);
        return (
          id !== null &&
          !alreadyBound.has(String(id))
        );
      });
      if (matches.length === 1) {
        const contractId = statementContractId(matches[0]);
        alreadyBound.add(String(contractId));
        const event = {
          buyPrice: Math.abs(finite(matches[0].amount, "statement amount")),
          contractId,
          eventAt: now.toISOString(),
          maximumLoss: Math.abs(finite(matches[0].amount, "statement amount")),
          reconciliationStatus: "broker_purchase_found",
          stage: "reconciled",
          tradeId: trade.tradeId,
          transactionId:
            matches[0].transaction_id ?? matches[0].transactionId ?? null,
        };
        await appendEvent(event);
        appended.push(event);
        trade = { ...trade, ...event };
      } else if (matches.length > 1 || potentialMatches.length > 0) {
        blockers.push({
          tradeId: trade.tradeId,
          reason:
            matches.length > 1
              ? "Multiple broker purchases could match the uncertain purchase intent."
              : "A broker purchase may match, but its contract identity cannot be established safely.",
        });
        continue;
      } else {
        const ageSeconds = (now.getTime() - Date.parse(trade.startedAt)) / 1_000;
        if (ageSeconds >= noPurchaseGraceSeconds) {
          const event = {
            eventAt: now.toISOString(),
            reconciliationStatus: "not_purchased",
            stage: "reconciled",
            tradeId: trade.tradeId,
          };
          await appendEvent(event);
          appended.push(event);
        } else {
          blockers.push({
            tradeId: trade.tradeId,
            reason: "No broker purchase is visible yet; the uncertainty grace period has not elapsed.",
          });
        }
        continue;
      }
    }
    await reconcileKnownContract({
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
