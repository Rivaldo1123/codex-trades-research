import { DerivPublicClient, PUBLIC_ENDPOINT } from "./deriv-public.js";

export const FEASIBILITY_SYMBOLS = Object.freeze(["RB100", "RB200"]);
export const FEASIBILITY_HISTORY_WINDOW = Object.freeze({
  count: 1_000,
  end: 1_788_878_187,
  start: 1_788_870_987,
  symbol: "RB100",
});

function apiError(error) {
  const message = String(error?.message ?? error);
  const match = message.match(/^Deriv API error ([^:]+):\s*(.+)$/);
  return match
    ? { code: match[1], message: match[2] }
    : { code: "UNKNOWN", message };
}

function acceptedMultipliers(error) {
  const match = String(error?.message ?? error).match(/Accepts ([0-9,]+)/);
  if (!match) return [];
  return match[1].split(",").map(Number).filter(Number.isFinite);
}

export function summarizeContractsFor(message, symbol) {
  const available = message?.contracts_for?.available;
  if (message?.msg_type !== "contracts_for" || !Array.isArray(available)) {
    throw new Error(`Invalid contracts_for response for ${symbol}.`);
  }
  return available.map((contract) => ({
    cancellationRange: contract.cancellation_range ?? [],
    category: contract.contract_category,
    contractType: contract.contract_type,
    expiryType: contract.expiry_type,
    maximumDuration: contract.max_contract_duration,
    minimumDuration: contract.min_contract_duration,
    multiplierRange: contract.multiplier_range ?? [],
    sentiment: contract.sentiment,
    symbol: contract.underlying_symbol,
  })).sort((left, right) => left.contractType.localeCompare(right.contractType));
}

export function summarizeMultiplierProposal(message, request) {
  const proposal = message?.proposal;
  const askPrice = Number(proposal?.ask_price);
  const commission = Number(proposal?.commission);
  const multiplier = Number(proposal?.multiplier);
  const payout = Number(proposal?.payout);
  const quoteEpoch = Number(proposal?.spot_time);
  const quoteSpot = Number(proposal?.spot);
  if (message?.msg_type !== "proposal" ||
      !Number.isFinite(askPrice) || askPrice <= 0 ||
      !Number.isFinite(commission) || commission < 0 ||
      !Number.isFinite(multiplier) || multiplier <= 0 ||
      !Number.isFinite(payout) ||
      !Number.isSafeInteger(quoteEpoch) ||
      !Number.isFinite(quoteSpot)) {
    throw new Error("Invalid public multiplier proposal.");
  }
  const rawMoveBreakEvenFraction = commission / (askPrice * multiplier);
  return {
    askPrice,
    commission,
    commissionPerUnitStake: commission / askPrice,
    contractType: request.contract_type,
    grossPayoutField: payout,
    multiplier,
    quoteEpoch,
    quoteSpot,
    rawMoveBreakEvenBpsBeforeExitCosts: rawMoveBreakEvenFraction * 10_000,
    rawMoveBreakEvenFractionBeforeExitCosts: rawMoveBreakEvenFraction,
    symbol: request.underlying_symbol,
  };
}

export function summarizeHistory(ticks, breakEvenBps) {
  if (!Array.isArray(ticks) || ticks.length < 2 ||
      !Number.isFinite(breakEvenBps) || breakEvenBps < 0) {
    throw new Error("Historical feasibility sample is invalid.");
  }
  const cadenceSeconds = {};
  let positiveMoves = 0;
  let negativeMoves = 0;
  let unchangedMoves = 0;
  let upMovesAboveRawBreakEven = 0;
  let downMovesAboveRawBreakEven = 0;
  let sumAbsoluteBps = 0;
  let maximumAbsoluteBps = 0;
  for (let index = 1; index < ticks.length; index += 1) {
    const previous = ticks[index - 1];
    const current = ticks[index];
    if (!Number.isSafeInteger(previous.epoch) ||
        !Number.isSafeInteger(current.epoch) ||
        current.epoch <= previous.epoch ||
        !Number.isFinite(previous.quote) || previous.quote <= 0 ||
        !Number.isFinite(current.quote)) {
      throw new Error("Historical feasibility ticks are invalid or unordered.");
    }
    const cadence = current.epoch - previous.epoch;
    cadenceSeconds[cadence] = (cadenceSeconds[cadence] ?? 0) + 1;
    const changeBps = ((current.quote - previous.quote) / previous.quote) * 10_000;
    if (changeBps > 0) positiveMoves += 1;
    else if (changeBps < 0) negativeMoves += 1;
    else unchangedMoves += 1;
    if (changeBps > breakEvenBps) upMovesAboveRawBreakEven += 1;
    if (changeBps < -breakEvenBps) downMovesAboveRawBreakEven += 1;
    const absolute = Math.abs(changeBps);
    sumAbsoluteBps += absolute;
    maximumAbsoluteBps = Math.max(maximumAbsoluteBps, absolute);
  }
  const changes = ticks.length - 1;
  return {
    cadenceSeconds,
    changes,
    downMovesAboveRawBreakEven,
    firstEpoch: ticks[0].epoch,
    lastEpoch: ticks.at(-1).epoch,
    maximumAbsoluteOneTickMoveBps: maximumAbsoluteBps,
    meanAbsoluteOneTickMoveBps: sumAbsoluteBps / changes,
    negativeMoves,
    positiveMoves,
    rows: ticks.length,
    unchangedMoves,
    upMovesAboveRawBreakEven,
    warning: "Raw tick movement only; this is not a historical multiplier return because exit quotes, slippage, and closure processing are absent.",
  };
}

function hasForbiddenIdentityKey(value) {
  if (Array.isArray(value)) return value.some(hasForbiddenIdentityKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    ["id", "proposalId", "subscriptionId"].includes(key) ||
    hasForbiddenIdentityKey(child));
}

export function validateProductFeasibilityEvidence(report) {
  if (!report || report.schemaVersion !== 1 ||
      report.kind !== "read-only-product-capability-and-payout-feasibility-probe") {
    throw new Error("Unsupported product-feasibility evidence schema.");
  }
  if (report.endpoint !== PUBLIC_ENDPOINT || report.ordersAuthorized !== false) {
    throw new Error("Product-feasibility evidence is not public/read-only.");
  }
  if (hasForbiddenIdentityKey(report)) {
    throw new Error("Product-feasibility evidence contains a quote identity.");
  }
  const counts = report.requestCounts;
  const budget = report.requestBudget;
  if (!counts || !Object.values(counts).every(Number.isSafeInteger) ||
      !budget || budget.noRetries !== true ||
      !Number.isSafeInteger(budget.plannedMaximumRequests) ||
      !Number.isSafeInteger(budget.boundedRequestsActuallyMade)) {
    throw new Error("Product-feasibility request budget is invalid.");
  }
  const actualRequests = Object.values(counts).reduce((sum, value) => sum + value, 0);
  if (actualRequests !== budget.boundedRequestsActuallyMade ||
      actualRequests > budget.plannedMaximumRequests) {
    throw new Error("Product-feasibility evidence exceeded or misstated its request budget.");
  }
  if (!Array.isArray(report.indicativeProposals) ||
      report.indicativeProposals.length !== 4) {
    throw new Error("Expected four point-in-time multiplier indications.");
  }
  for (const quote of report.indicativeProposals) {
    const expectedFraction = quote.commission / (quote.askPrice * quote.multiplier);
    if (![quote.askPrice, quote.commission, quote.multiplier,
      quote.rawMoveBreakEvenFractionBeforeExitCosts,
      quote.rawMoveBreakEvenBpsBeforeExitCosts].every(Number.isFinite) ||
        Math.abs(quote.rawMoveBreakEvenFractionBeforeExitCosts - expectedFraction) > 1e-12 ||
        Math.abs(quote.rawMoveBreakEvenBpsBeforeExitCosts - expectedFraction * 10_000) > 1e-9) {
      throw new Error("Multiplier break-even calculation is inconsistent.");
    }
  }
  const relevant = report.catalog?.relevant;
  if (![relevant?.rangeBreak, relevant?.regimeSwitching, relevant?.skewStep]
    .every(Array.isArray)) {
    throw new Error("Relevant product catalogue evidence is incomplete.");
  }
  if (report.historicalPointSample?.status === "AVAILABLE_POINT_SAMPLE") {
    const sample = report.historicalPointSample.result;
    if (!Number.isSafeInteger(sample?.rows) || sample.rows < 2 ||
        sample.changes !== sample.rows - 1 ||
        !String(sample.warning).includes("not a historical multiplier return")) {
      throw new Error("Historical point sample is invalid or overclaims its meaning.");
    }
  }
  return {
    boundedRequests: actualRequests,
    historyStatus: report.historicalPointSample?.status,
    proposalCount: report.indicativeProposals.length,
    valid: true,
  };
}

function relevantCatalog(symbols) {
  const patterns = {
    rangeBreak: /range break/i,
    regimeSwitching: /drift switch|volatility switch/i,
    skewStep: /skew step/i,
  };
  return Object.fromEntries(Object.entries(patterns).map(([key, pattern]) => [
    key,
    symbols.filter((item) => pattern.test(`${item.name ?? ""} ${item.symbol ?? ""}`)),
  ]));
}

export async function runProductFeasibilityProbe({
  accessedAtUtc = new Date().toISOString(),
  clientFactory = () => new DerivPublicClient(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const client = clientFactory();
  if (client.endpoint !== PUBLIC_ENDPOINT) {
    throw new Error("Product feasibility probe is locked to the public endpoint.");
  }
  const requestCounts = { activeSymbols: 0, contractsFor: 0, history: 0, proposals: 0 };
  try {
    await client.connect();
    requestCounts.activeSymbols += 1;
    const symbols = await client.getActiveSymbols();
    const catalog = relevantCatalog(symbols);
    const contractsBySymbol = {};
    for (const symbol of FEASIBILITY_SYMBOLS) {
      requestCounts.contractsFor += 1;
      contractsBySymbol[symbol] = summarizeContractsFor(
        await client.request({ contracts_for: symbol }, "contracts_for", 30_000),
        symbol,
      );
    }

    const advertisedMultiplier = contractsBySymbol.RB100[0]?.multiplierRange?.[0];
    let advertisedMultiplierProbe;
    let proposalMultiplier = advertisedMultiplier;
    requestCounts.proposals += 1;
    try {
      await client.request({
        amount: 1,
        basis: "stake",
        contract_type: "MULTUP",
        currency: "USD",
        multiplier: advertisedMultiplier,
        proposal: 1,
        underlying_symbol: "RB100",
      }, "proposal", 30_000);
      advertisedMultiplierProbe = { accepted: true, multiplier: advertisedMultiplier };
    } catch (error) {
      const alternatives = acceptedMultipliers(error);
      proposalMultiplier = alternatives[0] ?? null;
      advertisedMultiplierProbe = {
        accepted: false,
        error: apiError(error),
        multiplier: advertisedMultiplier,
        proposalAcceptedMultipliersFromError: alternatives,
      };
    }

    const indicativeProposals = [];
    if (Number.isFinite(proposalMultiplier)) {
      for (const symbol of FEASIBILITY_SYMBOLS) {
        for (const contractType of ["MULTUP", "MULTDOWN"]) {
          const request = {
            amount: 1,
            basis: "stake",
            contract_type: contractType,
            currency: "USD",
            multiplier: proposalMultiplier,
            proposal: 1,
            underlying_symbol: symbol,
          };
          requestCounts.proposals += 1;
          indicativeProposals.push(summarizeMultiplierProposal(
            await client.request(request, "proposal", 30_000),
            request,
          ));
          await wait(500);
        }
      }
    }

    let historicalPointSample;
    requestCounts.history += 1;
    try {
      const ticks = await client.getTicksHistory(FEASIBILITY_HISTORY_WINDOW.symbol, {
        count: FEASIBILITY_HISTORY_WINDOW.count,
        end: FEASIBILITY_HISTORY_WINDOW.end,
        start: FEASIBILITY_HISTORY_WINDOW.start,
      });
      const breakEvenBps = indicativeProposals.find((item) =>
        item.symbol === FEASIBILITY_HISTORY_WINDOW.symbol &&
        item.contractType === "MULTUP")?.rawMoveBreakEvenBpsBeforeExitCosts;
      historicalPointSample = {
        request: FEASIBILITY_HISTORY_WINDOW,
        result: summarizeHistory(ticks, breakEvenBps),
        status: "AVAILABLE_POINT_SAMPLE",
      };
    } catch (error) {
      historicalPointSample = {
        error: apiError(error),
        request: FEASIBILITY_HISTORY_WINDOW,
        status: "UNAVAILABLE_DURING_BOUNDED_PROBE",
      };
    }

    const report = {
      accessedAtUtc,
      advertisedMultiplierProbe,
      catalog: {
        relevant: catalog,
        totalActiveSymbols: symbols.length,
      },
      contractsBySymbol,
      endpoint: PUBLIC_ENDPOINT,
      historicalPointSample,
      indicativeProposals,
      kind: "read-only-product-capability-and-payout-feasibility-probe",
      limitations: [
        "The public Options catalogue is not proof of availability on CFD platforms, in every jurisdiction, or for every account.",
        "Proposals are unauthenticated point-in-time indications and were not purchased.",
        "Multiplier proposals have no fixed expiry or binary payout; realistic historical P/L needs exit pricing and processing evidence.",
        "A point history response establishes only point availability, not complete coverage.",
      ],
      ordersAuthorized: false,
      requestBudget: {
        boundedRequestsActuallyMade: Object.values(requestCounts)
          .reduce((sum, value) => sum + value, 0),
        noRetries: true,
        plannedMaximumRequests: 9,
      },
      requestCounts,
      schemaVersion: 1,
    };
    validateProductFeasibilityEvidence(report);
    return report;
  } finally {
    client.close();
  }
}
