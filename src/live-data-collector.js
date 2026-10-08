import { setTimeout as delay } from "node:timers/promises";

import { PUBLIC_ENDPOINT } from "./deriv-public.js";

export function isRateLimitError(error) {
  return (
    error?.code === "RateLimit" ||
    /rate\s*limit/i.test(error?.message ?? "")
  );
}

export function parseSubscribedTick(message, expectedSymbol) {
  const payload = typeof message === "string" ? JSON.parse(message) : message;
  if (payload?.error) {
    throw new Error(
      `Deriv API error ${payload.error.code ?? "unknown"}: ${payload.error.message ?? "Unknown error"}`,
    );
  }
  if (payload?.msg_type !== "tick") return null;

  const symbol = payload.tick?.symbol ?? payload.echo_req?.ticks;
  const epoch = Number(payload.tick?.epoch);
  const quote = Number(payload.tick?.quote);
  if (symbol !== expectedSymbol) {
    throw new Error(`Received a live tick for unexpected symbol ${symbol}.`);
  }
  if (!Number.isInteger(epoch) || epoch < 1 || !Number.isFinite(quote)) {
    throw new Error("Deriv returned an invalid live tick.");
  }
  return { epoch, quote };
}

export async function subscribePublicTicks({
  endpoint = PUBLIC_ENDPOINT,
  onTick,
  signal,
  symbol,
}) {
  if (endpoint !== PUBLIC_ENDPOINT) {
    throw new Error("Safety lock: live collection requires the public endpoint.");
  }
  if (!/^[A-Za-z0-9_]{2,30}$/.test(symbol)) {
    throw new Error("Symbol has an invalid format.");
  }
  if (typeof onTick !== "function") {
    throw new Error("Live collection requires an onTick handler.");
  }

  await new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const stop = () => {
      if (socket.readyState < WebSocket.CLOSING) socket.close();
      finish(resolve);
    };
    signal?.addEventListener("abort", stop, { once: true });

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({ ticks: symbol, subscribe: 1, req_id: 1 }),
      );
    });
    socket.addEventListener("message", (event) => {
      try {
        const tick = parseSubscribedTick(event.data, symbol);
        if (tick) {
          Promise.resolve(onTick(tick)).catch((error) => {
            if (socket.readyState < WebSocket.CLOSING) socket.close();
            finish(reject, error);
          });
        }
      } catch (error) {
        if (socket.readyState < WebSocket.CLOSING) socket.close();
        finish(reject, error);
      }
    });
    socket.addEventListener("error", () => {
      finish(reject, new Error("Could not maintain the Deriv public tick stream."));
    });
    socket.addEventListener("close", () => {
      if (signal?.aborted) finish(resolve);
      else finish(reject, new Error("Deriv public tick stream closed unexpectedly."));
    });
  });
}

export async function reconnectDelay(attempt, signal) {
  const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
  await delay(delayMs, undefined, { signal });
}
