import { DerivPublicClient, PUBLIC_ENDPOINT } from "./deriv-public.js";

export const CONTRACT_AUDIT_SYMBOL = "1HZ100V";
export const CONTRACT_AUDIT_DURATIONS_TICKS = Object.freeze([1, 2, 3, 5, 7, 10]);
export const CONTRACT_AUDIT_TYPES = Object.freeze(["CALL", "PUT"]);

function finitePositive(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Deriv returned an invalid ${label}.`);
  }
  return parsed;
}

export function summarizeTickContracts(message, symbol = CONTRACT_AUDIT_SYMBOL) {
  if (message?.msg_type !== "contracts_for" ||
      !Array.isArray(message.contracts_for?.available)) {
    throw new Error("Deriv did not return a contracts_for availability list.");
  }
  const contracts = message.contracts_for.available
    .filter((item) => item.underlying_symbol === symbol &&
      item.expiry_type === "tick" && CONTRACT_AUDIT_TYPES.includes(item.contract_type))
    .map((item) => ({
      contractCategory: item.contract_category,
      contractType: item.contract_type,
      expiryType: item.expiry_type,
      maximumDuration: item.max_contract_duration,
      minimumDuration: item.min_contract_duration,
      sentiment: item.sentiment,
      symbol: item.underlying_symbol,
    }))
    .sort((left, right) => left.contractType.localeCompare(right.contractType));
  if (contracts.length !== CONTRACT_AUDIT_TYPES.length ||
      !CONTRACT_AUDIT_TYPES.every((type) =>
        contracts.some((contract) => contract.contractType === type))) {
    throw new Error("Expected CALL and PUT tick contracts were not both available.");
  }
  return contracts;
}

export function summarizeIndicativeProposal(
  message,
  { contractType, durationTicks, symbol = CONTRACT_AUDIT_SYMBOL },
) {
  if (!CONTRACT_AUDIT_TYPES.includes(contractType) ||
      !CONTRACT_AUDIT_DURATIONS_TICKS.includes(durationTicks)) {
    throw new Error("Contract audit proposal is outside the frozen product grid.");
  }
  const proposal = message?.proposal;
  if (message?.msg_type !== "proposal" || !proposal) {
    throw new Error("Deriv did not return an indicative proposal.");
  }
  const askPrice = finitePositive(proposal.ask_price, "proposal ask price");
  const grossPayout = finitePositive(proposal.payout, "proposal gross payout");
  const quoteSpot = finitePositive(proposal.spot, "proposal spot");
  const quoteEpoch = Number(proposal.spot_time);
  if (!Number.isSafeInteger(quoteEpoch) || grossPayout <= askPrice) {
    throw new Error("Deriv returned an invalid proposal time or payout relationship.");
  }
  return {
    askPrice,
    contractType,
    durationTicks,
    grossPayout,
    longcode: typeof proposal.longcode === "string" ? proposal.longcode : null,
    netProfitOnWin: grossPayout - askPrice,
    netProfitOnWinPerDollarStake: (grossPayout - askPrice) / askPrice,
    quoteEpoch,
    quoteSpot,
    symbol,
  };
}

async function requestWithBackoff(client, payload, expectedType, wait) {
  const delays = [5_000, 10_000, 20_000];
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await client.request(payload, expectedType, 30_000);
    } catch (error) {
      if (!/RateLimit/.test(String(error)) || attempt === delays.length) throw error;
      await wait(delays[attempt]);
    }
  }
  throw new Error("Unreachable contract-audit retry state.");
}

export async function runContractAuditProbe({
  clientFactory = () => new DerivPublicClient(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const client = clientFactory();
  if (client.endpoint !== PUBLIC_ENDPOINT) {
    throw new Error("Contract audit is locked to the unauthenticated public endpoint.");
  }
  try {
    await client.connect();
    const availabilityMessage = await requestWithBackoff(
      client,
      { contracts_for: CONTRACT_AUDIT_SYMBOL },
      "contracts_for",
      wait,
    );
    const availableTickContracts = summarizeTickContracts(availabilityMessage);
    const indicativeProposals = [];
    for (const durationTicks of CONTRACT_AUDIT_DURATIONS_TICKS) {
      for (const contractType of CONTRACT_AUDIT_TYPES) {
        const message = await requestWithBackoff(
          client,
          {
            amount: 1,
            basis: "stake",
            contract_type: contractType,
            currency: "USD",
            duration: durationTicks,
            duration_unit: "t",
            proposal: 1,
            underlying_symbol: CONTRACT_AUDIT_SYMBOL,
          },
          "proposal",
          wait,
        );
        indicativeProposals.push(summarizeIndicativeProposal(message, {
          contractType,
          durationTicks,
        }));
        await wait(1_000);
      }
    }
    return {
      accessedAtUtc: new Date().toISOString(),
      availableTickContracts,
      endpoint: PUBLIC_ENDPOINT,
      indicativeProposals,
      kind: "deriv-public-contract-audit-probe",
      limitations: [
        "No authentication, account quote, purchase, or order was used.",
        "Availability and public proposal values are point-in-time observations.",
        "Public indicative proposals are not historical executable account quotes.",
      ],
      ordersAuthorized: false,
      schemaVersion: 1,
      symbol: CONTRACT_AUDIT_SYMBOL,
    };
  } finally {
    client.close();
  }
}
