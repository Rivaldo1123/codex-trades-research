const TERMINAL_STATUSES = new Set(["won", "lost", "sold", "cancelled"]);

export function strictFiniteNumber(value, label, { positive = false } = {}) {
  if (typeof value === "boolean" || value === null || value === undefined) {
    throw new Error(`${label} must be a finite numeric value.`);
  }
  if (typeof value === "string" && value.trim() === "") {
    throw new Error(`${label} must be a finite numeric value.`);
  }
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error(`${label} must be a finite numeric value.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (positive && parsed <= 0)) {
    throw new Error(`${label} must be ${positive ? "a positive" : "a finite"} numeric value.`);
  }
  return parsed;
}

export function strictPositiveInteger(value, label) {
  const parsed = strictFiniteNumber(value, label, { positive: true });
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return parsed;
}

function optionalString(object, keys) {
  for (const key of keys) {
    if (typeof object?.[key] === "string" && object[key].trim() !== "") {
      return object[key].trim();
    }
  }
  return null;
}

function optionalNumber(object, keys, label) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object[key] !== null) {
      return strictFiniteNumber(object[key], label);
    }
  }
  return null;
}

function equalMoney(left, right) {
  return Math.abs(left - right) <= 1e-8;
}

export function contractIsTerminal(contract) {
  const status = String(contract?.status ?? "").toLowerCase();
  return Number(contract?.is_sold) === 1 || TERMINAL_STATUSES.has(status);
}

export function validateContractIdentity(contract, intent, {
  expectedContractId = intent?.contractId ?? null,
  requireDurationEvidence = false,
} = {}) {
  if (!contract || typeof contract !== "object" || !intent || typeof intent !== "object") {
    throw new Error("Contract reconciliation requires broker data and an intended contract.");
  }
  const contractId = strictPositiveInteger(
    contract.contract_id ?? contract.contractId,
    "Broker contract ID",
  );
  if (expectedContractId !== null && expectedContractId !== undefined &&
      String(strictPositiveInteger(expectedContractId, "Expected contract ID")) !== String(contractId)) {
    throw new Error("Broker contract identity is incompatible with the purchased contract.");
  }

  const checks = [
    [optionalString(contract, ["underlying_symbol", "underlying", "symbol"]), intent.symbol,
      "instrument"],
    [optionalString(contract, ["contract_type", "contractType"])?.toUpperCase(),
      intent.contractType?.toUpperCase(), "contract type"],
    [optionalString(contract, ["currency"])?.toUpperCase(), intent.currency?.toUpperCase(),
      "currency"],
  ];
  for (const [actual, expected, label] of checks) {
    if (expected && actual && actual !== expected) {
      throw new Error(`Broker contract ${label} is incompatible with the purchase intent.`);
    }
    if (requireDurationEvidence && expected && !actual && label !== "currency") {
      throw new Error(`Broker contract ${label} is unavailable; identity cannot be established safely.`);
    }
  }

  const expectedPrice = strictFiniteNumber(
    intent.buyPrice ?? intent.maximumLoss ?? intent.stake,
    "Intended maximum loss",
    { positive: true },
  );
  const actualPrice = strictFiniteNumber(
    contract.buy_price ?? contract.buyPrice,
    "Broker buy price",
    { positive: true },
  );
  if (!equalMoney(actualPrice, expectedPrice)) {
    throw new Error("Broker contract buy price is incompatible with the purchase intent.");
  }

  const intendedDuration = Number(intent.duration);
  const intendedUnit = intent.durationUnit;
  const explicitDuration = optionalNumber(contract, ["duration"], "Broker duration");
  const explicitUnit = optionalString(contract, ["duration_unit", "durationUnit"]);
  const terminalTickCount = contractIsTerminal(contract)
    ? optionalNumber(contract, ["tick_count"], "Broker tick count")
    : null;
  let durationVerified = false;
  if (Number.isSafeInteger(intendedDuration) && intendedDuration > 0) {
    if (explicitDuration !== null) {
      if (explicitDuration !== intendedDuration) {
        throw new Error("Broker contract duration is incompatible with the purchase intent.");
      }
      durationVerified = Boolean(explicitUnit && intendedUnit && explicitUnit === intendedUnit);
    } else if (intendedUnit === "t" && terminalTickCount !== null) {
      if (terminalTickCount !== intendedDuration) {
        throw new Error("Broker contract tick duration is incompatible with the purchase intent.");
      }
      durationVerified = true;
    }
    if (explicitUnit && intendedUnit && explicitUnit !== intendedUnit) {
      throw new Error("Broker contract duration unit is incompatible with the purchase intent.");
    }
    if (requireDurationEvidence && !durationVerified) {
      throw new Error("Broker contract duration is unavailable; identity cannot be established safely.");
    }
  }

  const purchaseEpoch = optionalNumber(
    contract,
    ["purchase_time", "purchaseTime", "date_start", "start_time"],
    "Broker purchase time",
  );
  if (purchaseEpoch !== null && intent.startedAt) {
    const intentEpoch = Math.floor(Date.parse(intent.startedAt) / 1_000);
    if (!Number.isSafeInteger(intentEpoch) || purchaseEpoch < intentEpoch - 5) {
      throw new Error("Broker contract timing is incompatible with the purchase intent.");
    }
  }

  return { buyPrice: actualPrice, contractId, durationVerified };
}

export function validateSettlement(contract, intent, {
  expectedContractId = intent?.contractId,
  now = new Date(),
} = {}) {
  const identity = validateContractIdentity(contract, intent, { expectedContractId });
  if (!contractIsTerminal(contract)) {
    throw new Error("Cannot account for a broker contract whose outcome is still open.");
  }
  const status = String(contract.status ?? "").toLowerCase();
  if (!TERMINAL_STATUSES.has(status)) {
    throw new Error("Broker settlement has an unsupported terminal status.");
  }
  if (status === "cancelled") {
    throw new Error("Cancelled broker contracts require explicit refund evidence and remain unresolved.");
  }
  const profit = strictFiniteNumber(contract.profit, "Broker settlement profit");
  if (status === "won" && profit <= 0) {
    throw new Error("Broker win status is inconsistent with settlement profit.");
  }
  if (status === "lost" && profit >= 0) {
    throw new Error("Broker loss status is inconsistent with settlement profit.");
  }

  let outcomeKind = "expiry";
  let performanceEligible = true;
  if (status === "sold") {
    strictFiniteNumber(contract.sell_price ?? contract.sellPrice, "Broker early-sale price");
    outcomeKind = "early_sale";
    performanceEligible = false;
  }
  const closedEpoch = optionalNumber(
    contract,
    ["date_settlement", "sell_time", "exit_spot_time", "exitSpotTime"],
    "Broker settlement time",
  );
  const closedAt = closedEpoch === null
    ? now.toISOString()
    : new Date(closedEpoch * 1_000).toISOString();
  const exitValue = contract.exit_spot ?? contract.exit_tick ?? contract.exitSpot;

  return {
    buyPrice: identity.buyPrice,
    closedAt,
    contractId: identity.contractId,
    exitSpot: exitValue === undefined || exitValue === null
      ? null
      : strictFiniteNumber(exitValue, "Broker exit spot"),
    outcomeKind,
    performanceEligible,
    profit,
    status,
  };
}

export function settlementJournalEvent(trade, contract, now = new Date()) {
  const settlement = validateSettlement(contract, trade, {
    expectedContractId: trade.contractId,
    now,
  });
  return {
    ...settlement,
    accountFingerprint: trade.accountFingerprint,
    eventAt: now.toISOString(),
    reconciled: true,
    stage: "settled",
    strategyHash: trade.strategyHash,
    tradeId: trade.tradeId,
  };
}
