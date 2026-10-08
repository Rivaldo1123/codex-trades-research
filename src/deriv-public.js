const PUBLIC_ENDPOINT =
  "wss://api.derivws.com/trading/v1/options/ws/public";

function decodeMessage(event) {
  if (typeof event.data === "string") {
    return event.data;
  }

  if (event.data instanceof ArrayBuffer) {
    return new TextDecoder().decode(event.data);
  }

  throw new Error("Deriv returned an unsupported WebSocket message type.");
}

export class DerivPublicClient {
  constructor(endpoint = PUBLIC_ENDPOINT) {
    if (endpoint !== PUBLIC_ENDPOINT) {
      throw new Error(
        `Safety lock: only the public Deriv endpoint is allowed (${PUBLIC_ENDPOINT}).`,
      );
    }

    this.endpoint = endpoint;
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
        for (const request of this.pending.values()) {
          request.reject(error);
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
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Deriv WebSocket closed before the response arrived."));
      }
      this.pending.clear();
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("Timed out connecting to Deriv public market data."));
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
          reject(new Error("Could not connect to Deriv public market data."));
        },
        { once: true },
      );
    });
  }

  request(payload, expectedTypes, timeoutMs = 15_000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Connect to Deriv before making a request.");
    }

    const reqId = this.nextRequestId++;
    const request = { ...payload, req_id: reqId };
    const acceptedTypes = new Set(
      Array.isArray(expectedTypes) ? expectedTypes : [expectedTypes],
    );

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`Deriv request ${reqId} timed out.`));
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

  async getActiveSymbols() {
    const message = await this.request(
      { active_symbols: "brief" },
      "active_symbols",
    );

    return message.active_symbols.map((item) => ({
      market: item.market,
      name: item.underlying_symbol_name ?? item.display_name,
      symbol: item.underlying_symbol ?? item.symbol,
      type: item.underlying_symbol_type ?? item.symbol_type,
    }));
  }

  async getCandles(symbol, { count = 1000, granularity = 60 } = {}) {
    if (!/^[A-Za-z0-9_]{2,30}$/.test(symbol)) {
      throw new Error("Symbol has an invalid format.");
    }

    if (!Number.isInteger(count) || count < 100 || count > 5000) {
      throw new Error("Candle count must be an integer from 100 through 5000.");
    }

    if (!Number.isInteger(granularity) || granularity < 1) {
      throw new Error("Granularity must be a positive whole number of seconds.");
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
    );

    if (!Array.isArray(message.candles)) {
      throw new Error("Deriv did not return candle data for this request.");
    }

    return message.candles
      .map((candle) => ({
        close: Number(candle.close),
        epoch: Number(candle.epoch),
        high: Number(candle.high),
        low: Number(candle.low),
        open: Number(candle.open),
      }))
      .sort((a, b) => a.epoch - b.epoch);
  }

  async getTicksHistory(
    symbol,
    { count = 5000, end = "latest", start } = {},
  ) {
    if (!/^[A-Za-z0-9_]{2,30}$/.test(symbol)) {
      throw new Error("Symbol has an invalid format.");
    }

    if (!Number.isInteger(count) || count < 1 || count > 5000) {
      throw new Error("Tick count must be an integer from 1 through 5000.");
    }

    if (end !== "latest" && (!Number.isInteger(end) || end < 1)) {
      throw new Error('Tick-history end must be "latest" or a Unix epoch.');
    }

    if (start !== undefined && (!Number.isInteger(start) || start < 1)) {
      throw new Error("Tick-history start must be a positive Unix epoch.");
    }

    const request = {
      count,
      end: end === "latest" ? end : String(end),
      style: "ticks",
      ticks_history: symbol,
    };
    if (start !== undefined) {
      request.start = start;
    }

    const message = await this.request(request, "history", 30_000);
    const prices = message.history?.prices;
    const times = message.history?.times;
    if (!Array.isArray(prices) || !Array.isArray(times)) {
      throw new Error("Deriv did not return tick history for this request.");
    }
    if (prices.length !== times.length) {
      throw new Error("Deriv returned mismatched tick timestamps and prices.");
    }

    const ticks = times
      .map((epoch, index) => ({
        epoch: Number(epoch),
        quote: Number(prices[index]),
      }))
      .sort((a, b) => a.epoch - b.epoch);
    if (ticks.some((tick) => !Number.isInteger(tick.epoch) || !Number.isFinite(tick.quote))) {
      throw new Error("Deriv returned an invalid tick timestamp or quote.");
    }
    if (
      ticks.some(
        (tick) =>
          (start !== undefined && tick.epoch < start) ||
          (end !== "latest" && tick.epoch > end),
      )
    ) {
      throw new Error("Deriv returned ticks outside the requested historical range.");
    }
    return ticks;
  }

  close() {
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) {
      this.socket.close();
    }
  }
}

export { PUBLIC_ENDPOINT };
