import { createHash } from "node:crypto";

import { DerivPublicClient, PUBLIC_ENDPOINT } from "./deriv-public.js";

export const RANGE_BREAK_CONTRACT_REQUEST = Object.freeze({
  contracts_for: "RB100",
});

export function rangeBreakProposalRequest(multiplier) {
  return {
    amount: 1,
    basis: "stake",
    contract_type: "MULTUP",
    currency: "USD",
    multiplier,
    proposal: 1,
    underlying_symbol: "RB100",
  };
}

function apiError(error) {
  const message = String(error?.message ?? error);
  const match = message.match(/^Deriv API error ([^:]+):\s*(.+)$/);
  return match
    ? { code: match[1], message: match[2] }
    : { code: "UNKNOWN", message };
}

function acceptedMultipliers(error) {
  const match = String(error?.message ?? error).match(/Accepts ([0-9,]+)/);
  return match
    ? match[1].split(",").map(Number).filter(Number.isFinite)
    : [];
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["id", "req_id", "subscription"].includes(key))
    .map(([key, child]) => [key, sanitize(child)]));
}

function parsedResponseHash(response) {
  return createHash("sha256").update(JSON.stringify(response)).digest("hex");
}

async function capture(client, request, expectedType) {
  try {
    const response = await client.request(request, expectedType, 30_000);
    return {
      outcome: "SUCCESS",
      parsedResponseJsonSha256BeforeSanitization: parsedResponseHash(response),
      request,
      response: sanitize(response),
    };
  } catch (error) {
    return {
      acceptedMultipliersFromError: acceptedMultipliers(error),
      error: apiError(error),
      outcome: "ERROR",
      request,
    };
  }
}

function multiplierRange(contractsCapture) {
  const available = contractsCapture.response?.contracts_for?.available;
  if (!Array.isArray(available)) return [];
  const contract = available.find((item) =>
    item.underlying_symbol === "RB100" && item.contract_type === "MULTUP");
  return Array.isArray(contract?.multiplier_range)
    ? contract.multiplier_range.map(Number).filter(Number.isFinite)
    : [];
}

function stopAfter(capture) {
  if (capture.outcome !== "ERROR") return false;
  return capture.error.code !== "ContractBuyValidationError" ||
    capture.acceptedMultipliersFromError.length === 0;
}

function hasForbiddenKey(value) {
  if (Array.isArray(value)) return value.some(hasForbiddenKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    ["id", "req_id", "subscription", "buy", "authorize"].includes(key) ||
    hasForbiddenKey(child));
}

export function validateRangeBreakReconciliationEvidence(report) {
  if (!report || report.schemaVersion !== 1 ||
      report.kind !== "range-break-capability-reconciliation-probe") {
    throw new Error("Unsupported Range Break reconciliation evidence schema.");
  }
  if (report.endpoint !== PUBLIC_ENDPOINT || report.authenticated !== false ||
      report.ordersAuthorized !== false || report.requestBudget?.noRetries !== true) {
    throw new Error("Range Break reconciliation evidence is not public/read-only.");
  }
  if (!Array.isArray(report.captures) || report.captures.length < 1 ||
      report.captures.length > 3 ||
      report.requestBudget.requestsActuallyMade !== report.captures.length ||
      report.requestBudget.maximumRequests !== 3) {
    throw new Error("Range Break reconciliation request budget is invalid.");
  }
  if (hasForbiddenKey(report)) {
    throw new Error("Range Break reconciliation evidence retained a forbidden identity or action.");
  }
  const allowed = [
    JSON.stringify(RANGE_BREAK_CONTRACT_REQUEST),
    JSON.stringify(rangeBreakProposalRequest(20)),
    JSON.stringify(rangeBreakProposalRequest(400)),
  ];
  for (let index = 0; index < report.captures.length; index += 1) {
    if (JSON.stringify(report.captures[index].request) !== allowed[index]) {
      throw new Error("Range Break reconciliation contains an unexpected request.");
    }
  }
  if (report.classification === "SPECIFICATION_CONFLICT") {
    if (report.captures.length !== 3 ||
        !report.comparison.contractsForMultiplierRange.includes(20) ||
        report.comparison.multiplier20Outcome !== "ERROR" ||
        !report.comparison.multiplier20ErrorAcceptedMultipliers.includes(400) ||
        report.comparison.multiplier400Outcome !== "SUCCESS" ||
        report.comparison.sameEndpointSymbolContractAndParametersExceptMultiplier !== true) {
      throw new Error("Range Break specification conflict is not supported by the captures.");
    }
  }
  return {
    classification: report.classification,
    requests: report.captures.length,
    valid: true,
  };
}

export async function runRangeBreakReconciliationProbe({
  accessedAtUtc = new Date().toISOString(),
  clientFactory = () => new DerivPublicClient(),
} = {}) {
  const client = clientFactory();
  if (client.endpoint !== PUBLIC_ENDPOINT) {
    throw new Error("Range Break reconciliation is locked to the public endpoint.");
  }
  const captures = [];
  try {
    await client.connect();
    const contractsCapture = await capture(
      client,
      RANGE_BREAK_CONTRACT_REQUEST,
      "contracts_for",
    );
    captures.push(contractsCapture);
    if (contractsCapture.outcome !== "SUCCESS") {
      const report = buildReport({ accessedAtUtc, captures });
      validateRangeBreakReconciliationEvidence(report);
      return report;
    }

    const multiplier20 = await capture(
      client,
      rangeBreakProposalRequest(20),
      "proposal",
    );
    captures.push(multiplier20);
    if (stopAfter(multiplier20)) {
      const report = buildReport({ accessedAtUtc, captures });
      validateRangeBreakReconciliationEvidence(report);
      return report;
    }

    captures.push(await capture(
      client,
      rangeBreakProposalRequest(400),
      "proposal",
    ));
    const report = buildReport({ accessedAtUtc, captures });
    validateRangeBreakReconciliationEvidence(report);
    return report;
  } finally {
    client.close();
  }
}

function buildReport({ accessedAtUtc, captures }) {
  const range = multiplierRange(captures[0] ?? {});
  const multiplier20 = captures[1];
  const multiplier400 = captures[2];
  const conflict = range.includes(20) &&
    multiplier20?.outcome === "ERROR" &&
    multiplier20.acceptedMultipliersFromError.includes(400) &&
    multiplier400?.outcome === "SUCCESS";
  return {
    accessedAtUtc,
    authenticated: false,
    captures,
    classification: conflict
      ? "SPECIFICATION_CONFLICT"
      : "UNRESOLVED_OR_EARLY_STOP",
    comparison: {
      contractsForMultiplierRange: range,
      multiplier20ErrorAcceptedMultipliers:
        multiplier20?.acceptedMultipliersFromError ?? [],
      multiplier20Outcome: multiplier20?.outcome ?? "NOT_REQUESTED",
      multiplier400Outcome: multiplier400?.outcome ?? "NOT_REQUESTED",
      sameEndpointSymbolContractAndParametersExceptMultiplier:
        captures.length === 3,
    },
    endpoint: PUBLIC_ENDPOINT,
    kind: "range-break-capability-reconciliation-probe",
    limitations: [
      "contracts_for has a symbol request while proposal additionally requires contract type, currency, basis, amount, and multiplier; they are related capability and validation endpoints, not identical requests.",
      "The public response is not account-specific and does not establish availability for every jurisdiction or account.",
      "A successful proposal is an indicative point quote, not a purchase or historical executable quote.",
    ],
    ordersAuthorized: false,
    provenance: {
      protocol: "research/protocols/feasibility-addendum-v2.md",
      sanitization: "Removed proposal/subscription identifiers and request IDs; retained a SHA-256 of each parsed successful response before sanitization.",
    },
    requestBudget: {
      maximumRequests: 3,
      noRetries: true,
      requestsActuallyMade: captures.length,
    },
    schemaVersion: 1,
  };
}
