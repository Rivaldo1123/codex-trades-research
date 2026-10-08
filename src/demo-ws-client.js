import { validateDemoWebSocketUrl } from "./deriv-demo.js";
import { verifyDemoDeploymentEligibility } from "./demo-deployment-gate.js";

const AUTHORIZED_ORDER_REQUEST = Symbol("authorized-demo-order-request");
const ORDER_REQUEST_FIELDS = [
  "buy",
  "buy_contract_for_multiple_accounts",
  "cancel",
  "sell",
  "sell_contract_for_multiple_accounts",
];

function decodeMessage(event) {
  if (typeof event.data === "string") {
    return event.data;
  }
  if (event.data instanceof ArrayBuffer) {
    return new TextDecoder().decode(event.data);
  }
  throw new Error("Deriv returned an unsupported WebSocket message type.");
}

function positiveNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return parsed;
}

function contractId(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("Deriv did not return a valid contract ID.");
  }
  return parsed;
}

export function directionToContractType(direction) {
  if (direction === "up") {
    return "CALL";
  }
  if (direction === "down") {
    return "PUT";
  }
  throw new Error("A demo trade direction must be up or down.");
}

export class DerivDemoClient {
  constructor(endpoint) {
    this.endpoint = validateDemoWebSocketUrl(endpoint);
    this.socket = null;
    this.pending = new Map();
    this.nextRequestId = 1;
  }

  async connect(timeoutMs = 15_000) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }

    const socket = new WebSocket(this.endpoint);
    this.socket = socket;

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(decodeMessage(event));
      } catch (error) {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
        return;
      }

      const requestId = message.req_id ?? message.echo_req?.req_id;
      const pending = this.pending.get(requestId);
      if (!pending) {
        return;
      }

      if (message.error) {
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.reject(
          new Error(
            `Deriv API error ${message.error.code ?? "unknown"}: ${message.error.message ?? "Unknown error"}`,
          ),
        );
        return;
      }

      if (!pending.expectedTypes.has(message.msg_type)) {
        return;
      }

      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.resolve(message);
    });

    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          new Error("Deriv demo WebSocket closed before the response arrived."),
        );
      }
      this.pending.clear();
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("Timed out connecting to the Deriv demo account."));
      }, timeoutMs);

      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );

      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("Could not connect to the Deriv demo account."));
        },
        { once: true },
      );
    });
  }

  request(payload, expectedTypes, timeoutMs = 15_000, orderCapability = null) {
    if (ORDER_REQUEST_FIELDS.some((field) => payload?.[field] !== undefined) &&
        orderCapability !== AUTHORIZED_ORDER_REQUEST) {
      throw new Error(
        "Safety lock: order-bearing demo requests require the qualified executor path.",
      );
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Connect to Deriv demo before making a request.");
    }

    const reqId = this.nextRequestId++;
    const request = { ...payload, req_id: reqId };
    const acceptedTypes = new Set(
      Array.isArray(expectedTypes) ? expectedTypes : [expectedTypes],
    );

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`Deriv demo request ${reqId} timed out.`));
      }, timeoutMs);

      this.pending.set(reqId, {
        expectedTypes: acceptedTypes,
        reject,
        resolve,
        timer,
      });

      this.socket.send(JSON.stringify(request));
    });
  }

  async getCandles(symbol, { count, granularity }) {
    if (!/^[A-Za-z0-9_]{2,30}$/.test(symbol)) {
      throw new Error("Symbol has an invalid format.");
    }
    if (!Number.isInteger(count) || count < 100 || count > 1000) {
      throw new Error("Demo candle count must be from 100 through 1000.");
    }
    if (!Number.isInteger(granularity) || granularity < 1) {
      throw new Error("Demo candle granularity must be a positive integer.");
    }

    const message = await this.request(
      {
        count,
        end: "latest",
        granularity,
        style: "candles",
        ticks_history: symbol,
      },
      ["candles", "history"],
      30_000,
    );

    if (!Array.isArray(message.candles)) {
      throw new Error("Deriv did not return demo candle data.");
    }

    return message.candles
      .map((candle) => {
        const parsed = {
          close: Number(candle.close),
          epoch: Number(candle.epoch),
          high: Number(candle.high),
          low: Number(candle.low),
          open: Number(candle.open),
        };
        if (!Number.isSafeInteger(parsed.epoch) ||
            ![parsed.close, parsed.high, parsed.low, parsed.open].every(Number.isFinite)) {
          throw new Error("Deriv returned a malformed demo candle.");
        }
        return parsed;
      })
      .sort((a, b) => a.epoch - b.epoch);
  }

  async getBalance() {
    const message = await this.request({ balance: 1 }, "balance");
    const value = message.balance?.balance ?? message.balance;
    const balance = Number(value);
    if (!Number.isFinite(balance)) {
      throw new Error("Deriv did not return a numeric demo balance.");
    }
    return {
      amount: balance,
      currency: message.balance?.currency ?? null,
    };
  }

  async getPortfolio() {
    const message = await this.request({ portfolio: 1 }, "portfolio");
    const contracts = message.portfolio?.contracts;
    if (!Array.isArray(contracts)) {
      throw new Error("Deriv did not return a demo portfolio.");
    }
    return contracts;
  }

  async getStatement({
    actionType = "buy",
    dateFrom,
    dateTo,
    limit = 100,
    maxPages = 20,
  } = {}) {
    if (actionType !== "buy") {
      throw new Error("Safety lock: reconciliation may request only buy statement rows.");
    }
    if (
      !Number.isSafeInteger(dateFrom) ||
      dateFrom < 0 ||
      !Number.isSafeInteger(dateTo) ||
      dateTo < dateFrom
    ) {
      throw new Error("Statement reconciliation requires a valid epoch range.");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 999) {
      throw new Error("Statement reconciliation limit must be from 1 through 999.");
    }
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) {
      throw new Error("Statement reconciliation page limit must be from 1 through 100.");
    }

    const transactions = [];
    const transactionIds = new Set();
    const pageFingerprints = new Set();
    let offset = 0;
    for (let page = 1; page <= maxPages; page += 1) {
      let message;
      try {
        message = await this.request(
          {
            action_type: actionType,
            date_from: dateFrom,
            date_to: dateTo,
            description: 1,
            limit,
            offset,
            statement: 1,
          },
          "statement",
          30_000,
        );
      } catch (error) {
        return {
          coverage: {
            complete: false,
            dateFrom,
            dateTo,
            failure: error.message,
            nextOffset: offset,
            pages: page - 1,
            reason: "PAGINATION_REQUEST_FAILED",
            rows: transactions.length,
          },
          transactions,
        };
      }
      const pageRows = message.statement?.transactions;
      const reportedCount = Number(message.statement?.count);
      if (!Array.isArray(pageRows) || !Number.isSafeInteger(reportedCount) ||
          reportedCount !== pageRows.length) {
        throw new Error("Deriv returned malformed statement page coverage.");
      }
      const ids = pageRows.map((transaction) => {
        if (!transaction || typeof transaction !== "object") {
          throw new Error("Deriv returned a malformed statement transaction.");
        }
        const id = transaction.transaction_id ?? transaction.transactionId;
        if ((typeof id !== "number" && typeof id !== "string") || String(id).trim() === "") {
          throw new Error("Deriv statement transaction is missing its identity.");
        }
        const action = String(transaction.action_type ?? transaction.actionType ?? "").toLowerCase();
        const amount = transaction.amount;
        const transactionTime = Number(
          transaction.transaction_time ?? transaction.transactionTime,
        );
        if (action !== actionType || amount === null || amount === undefined ||
            (typeof amount === "string" && amount.trim() === "") ||
            typeof amount === "boolean" || !Number.isFinite(Number(amount)) ||
            !Number.isSafeInteger(transactionTime) || transactionTime < dateFrom ||
            transactionTime > dateTo) {
          throw new Error("Deriv statement transaction is missing required reconciliation fields.");
        }
        return String(id);
      });
      const fingerprint = JSON.stringify(ids);
      if (pageFingerprints.has(fingerprint) && pageRows.length > 0) {
        return {
          coverage: {
            complete: false,
            dateFrom,
            dateTo,
            nextOffset: offset,
            pages: page,
            reason: "DUPLICATE_PAGE",
            rows: transactions.length,
          },
          transactions,
        };
      }
      pageFingerprints.add(fingerprint);
      for (let index = 0; index < pageRows.length; index += 1) {
        if (transactionIds.has(ids[index])) {
          return {
            coverage: {
              complete: false,
              dateFrom,
              dateTo,
              nextOffset: offset,
              pages: page,
              reason: "DUPLICATE_OR_CHANGING_RESULTS",
              rows: transactions.length,
            },
            transactions,
          };
        }
        transactionIds.add(ids[index]);
        transactions.push(pageRows[index]);
      }
      offset += pageRows.length;
      if (pageRows.length < limit) {
        return {
          coverage: {
            complete: true,
            dateFrom,
            dateTo,
            nextOffset: offset,
            pages: page,
            reason: "EXHAUSTED",
            rows: transactions.length,
          },
          transactions,
        };
      }
    }
    return {
      coverage: {
        complete: false,
        dateFrom,
        dateTo,
        nextOffset: offset,
        pages: maxPages,
        reason: "PAGE_LIMIT_REACHED",
        rows: transactions.length,
      },
      transactions,
    };
  }

  async getProposal({
    currency,
    direction,
    duration,
    durationUnit,
    stake,
    symbol,
  }) {
    const contractType = directionToContractType(direction);
    positiveNumber(stake, "Demo stake");
    if (!Number.isInteger(duration) || duration < 1) {
      throw new Error("Contract duration must be a positive integer.");
    }
    if (durationUnit !== "t") {
      throw new Error("Safety lock: only tick-duration demo contracts are allowed.");
    }

    const message = await this.request(
      {
        amount: stake,
        basis: "stake",
        contract_type: contractType,
        currency,
        duration,
        duration_unit: durationUnit,
        proposal: 1,
        underlying_symbol: symbol,
      },
      "proposal",
    );

    const proposal = message.proposal;
    if (!proposal?.id) {
      throw new Error("Deriv did not return a proposal ID.");
    }
    return {
      askPrice: positiveNumber(proposal.ask_price, "Proposal ask price"),
      contractType,
      currency,
      duration,
      durationUnit,
      id: String(proposal.id),
      payout: positiveNumber(proposal.payout, "Proposal payout"),
      spot: positiveNumber(proposal.spot, "Proposal spot"),
      spotTime: contractId(proposal.spot_time),
      symbol,
    };
  }

  async buyProposal(proposalId, maximumPrice, authorization = null) {
    if (!authorization || typeof authorization !== "object") {
      throw new Error("Safety lock: demo purchase lacks deployment authorization.");
    }
    const eligibility = await verifyDemoDeploymentEligibility({
      config: authorization.config,
      projectRoot: authorization.projectRoot,
      strategyHash: authorization.strategyHash,
    });
    if (eligibility.candidateId !== authorization.candidateId ||
        eligibility.executorSourceSha256 !== authorization.executorSourceSha256) {
      throw new Error("Safety lock: demo purchase authorization changed before submission.");
    }
    if (!/^[\w-]{32,128}$/.test(proposalId)) {
      throw new Error("Deriv proposal ID has an invalid format.");
    }
    const price = positiveNumber(maximumPrice, "Maximum demo price");
    const message = await this.request(
      { buy: proposalId, price },
      "buy",
      30_000,
      AUTHORIZED_ORDER_REQUEST,
    );
    return {
      buyPrice: positiveNumber(
        message.buy?.buy_price ?? price,
        "Confirmed demo buy price",
      ),
      contractId: contractId(message.buy?.contract_id),
      longcode: message.buy?.longcode ?? null,
      payout: message.buy?.payout === undefined
        ? null
        : positiveNumber(message.buy.payout, "Confirmed demo payout"),
      purchaseTime: message.buy?.purchase_time === undefined
        ? null
        : contractId(message.buy.purchase_time),
      shortcode: message.buy?.shortcode ?? null,
      startTime: message.buy?.start_time === undefined
        ? null
        : contractId(message.buy.start_time),
      transactionId: message.buy?.transaction_id === undefined
        ? null
        : contractId(message.buy.transaction_id),
    };
  }

  async getOpenContract(id) {
    const message = await this.request(
      { contract_id: contractId(id), proposal_open_contract: 1 },
      "proposal_open_contract",
    );
    if (!message.proposal_open_contract) {
      throw new Error("Deriv did not return contract status.");
    }
    return message.proposal_open_contract;
  }

  async waitForSettlement(
    id,
    { pollIntervalMs = 1_000, timeoutMs = 90_000 } = {},
  ) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const contract = await this.getOpenContract(id);
      const status = String(contract.status ?? "").toLowerCase();
      if (
        Number(contract.is_sold) === 1 ||
        ["won", "lost", "sold", "cancelled"].includes(status)
      ) {
        return contract;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    throw new Error("Timed out waiting for the demo contract to settle.");
  }

  close() {
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) {
      this.socket.close();
    }
  }
}
