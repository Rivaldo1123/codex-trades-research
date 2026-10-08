import { contractIsTerminal, strictFiniteNumber, strictPositiveInteger } from "./demo-contract-validation.js";

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function optionalString(object, keys) {
  for (const key of keys) {
    if (typeof object?.[key] === "string" && object[key].trim() !== "") {
      return object[key].trim();
    }
  }
  return null;
}

function optionalPositiveInteger(object, keys, label) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object[key] !== null) {
      return strictPositiveInteger(object[key], label);
    }
  }
  return null;
}

export function normalizeBrowserPurchase(transaction) {
  if (!transaction || typeof transaction !== "object") {
    throw new Error("Statement purchase must be an object.");
  }
  const action = String(
    transaction.action_type ?? transaction.actionType ?? "",
  ).toLowerCase();
  if (action !== "buy") {
    throw new Error("Incident reconciliation accepts only broker buy rows.");
  }
  const transactionId = nonEmptyString(
    String(transaction.transaction_id ?? transaction.transactionId ?? ""),
    "Statement transaction ID",
  );
  const contractId = optionalPositiveInteger(
    transaction,
    ["contract_id", "contractId"],
    "Statement contract ID",
  );
  const transactionTime = strictPositiveInteger(
    transaction.transaction_time ?? transaction.transactionTime,
    "Statement transaction time",
  );
  const amount = strictFiniteNumber(
    transaction.amount,
    "Statement transaction amount",
  );
  return {
    amount,
    contractId,
    description: optionalString(transaction, ["longcode", "description"]),
    transactionId,
    transactionTime,
  };
}

function summarizeBrokerContract(contract, expectedContractId) {
  const contractId = strictPositiveInteger(
    contract?.contract_id ?? contract?.contractId,
    "Broker contract ID",
  );
  if (contractId !== expectedContractId) {
    throw new Error("Broker returned a different contract from the requested identity.");
  }
  const terminal = contractIsTerminal(contract);
  const status = String(contract?.status ?? "").trim().toLowerCase();
  const profit = terminal
    ? strictFiniteNumber(contract.profit, "Broker terminal profit")
    : null;
  return {
    buyPrice: contract?.buy_price === undefined
      ? null
      : strictFiniteNumber(contract.buy_price, "Broker buy price", { positive: true }),
    contractId,
    contractType: optionalString(contract, ["contract_type", "contractType"]),
    currency: optionalString(contract, ["currency"]),
    dateSettlement: optionalPositiveInteger(
      contract,
      ["date_settlement", "sell_time", "exit_spot_time"],
      "Broker settlement time",
    ),
    isOpen: !terminal,
    profit,
    status: status || (terminal ? "unknown-terminal" : "open"),
    symbol: optionalString(contract, ["underlying_symbol", "underlying", "symbol"]),
    terminal,
  };
}

export async function collectDemoIncidentEvidence({
  accountFingerprint,
  client,
  dateFrom,
  dateTo,
  observedAtUtc = new Date().toISOString(),
}) {
  nonEmptyString(accountFingerprint, "Account fingerprint");
  if (!Number.isSafeInteger(dateFrom) || dateFrom < 1 ||
      !Number.isSafeInteger(dateTo) || dateTo < dateFrom) {
    throw new Error("Incident interval must be a valid Unix-epoch range.");
  }
  if (!client || typeof client.getPortfolio !== "function" ||
      typeof client.getStatement !== "function" ||
      typeof client.getOpenContract !== "function") {
    throw new Error("Incident reconciliation requires a read-only broker client.");
  }

  const portfolio = await client.getPortfolio();
  if (!Array.isArray(portfolio)) {
    throw new Error("Broker portfolio must be an array.");
  }
  const openContractIds = portfolio.map((contract) => strictPositiveInteger(
    contract.contract_id ?? contract.contractId,
    "Portfolio contract ID",
  ));
  const statement = await client.getStatement({
    actionType: "buy",
    dateFrom,
    dateTo,
    limit: 100,
    maxPages: 20,
  });
  const coverage = statement?.coverage;
  const rawTransactions = statement?.transactions;
  if (!coverage || !Array.isArray(rawTransactions)) {
    throw new Error("Broker statement response lacks coverage metadata.");
  }

  const purchases = [];
  const seenTransactions = new Set();
  const seenContracts = new Set();
  const unresolved = [];
  for (const row of rawTransactions) {
    let purchase;
    try {
      purchase = normalizeBrowserPurchase(row);
    } catch (error) {
      unresolved.push({ reason: error.message, transactionId: null });
      continue;
    }
    if (seenTransactions.has(purchase.transactionId)) {
      unresolved.push({
        reason: "Duplicate statement transaction identity.",
        transactionId: purchase.transactionId,
      });
      continue;
    }
    seenTransactions.add(purchase.transactionId);
    if (purchase.contractId === null) {
      unresolved.push({
        reason: "Statement purchase has no contract identity.",
        transactionId: purchase.transactionId,
      });
      purchases.push({ ...purchase, brokerContract: null });
      continue;
    }
    if (seenContracts.has(purchase.contractId)) {
      unresolved.push({
        contractId: purchase.contractId,
        reason: "Multiple statement buys claim the same contract identity.",
        transactionId: purchase.transactionId,
      });
      purchases.push({ ...purchase, brokerContract: null });
      continue;
    }
    seenContracts.add(purchase.contractId);
    try {
      const contract = await client.getOpenContract(purchase.contractId);
      purchases.push({
        ...purchase,
        brokerContract: summarizeBrokerContract(contract, purchase.contractId),
      });
    } catch (error) {
      unresolved.push({
        contractId: purchase.contractId,
        reason: error.message,
        transactionId: purchase.transactionId,
      });
      purchases.push({ ...purchase, brokerContract: null });
    }
  }

  const terminal = purchases.filter((item) => item.brokerContract?.terminal);
  const realizedProfit = terminal.reduce(
    (sum, item) => sum + item.brokerContract.profit,
    0,
  );
  if (coverage.complete !== true) {
    unresolved.push({
      reason: `Statement coverage is incomplete: ${coverage.reason ?? "UNKNOWN"}.`,
      transactionId: null,
    });
  }
  for (const contractId of openContractIds) {
    unresolved.push({
      contractId,
      reason: seenContracts.has(contractId)
        ? "Broker contract remains open; its final outcome is not established."
        : "Open portfolio contract is not represented by a covered buy row in the incident interval.",
      transactionId: null,
    });
  }

  return {
    accountFingerprint,
    classification: unresolved.length > 0 || openContractIds.length > 0
      ? "UNRESOLVED_OR_OPEN"
      : "BROKER_RECORDS_RECONCILED_UNBOUND_TO_BROWSER_CONFIG",
    incidentDisposition: "ABORTED_CONNECTIVITY_LOSS",
    interval: { dateFrom, dateTo },
    kind: "read-only-demo-browser-incident-reconciliation",
    observedAtUtc,
    openContractIds,
    ordersAuthorized: false,
    purchases,
    schemaVersion: 1,
    statementCoverage: coverage,
    summary: {
      openContracts: openContractIds.length,
      purchases: purchases.length,
      realizedProfit,
      terminalContracts: terminal.length,
      unresolvedItems: unresolved.length,
    },
    unresolved,
    warning: "Broker records are time-window observations. The interrupted browser workspace did not durably bind every purchase to an exact strategy/configuration identity, so these records are not strategy-validation evidence.",
  };
}
