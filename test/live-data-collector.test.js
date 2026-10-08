import assert from "node:assert/strict";
import test from "node:test";

import {
  isRateLimitError,
  parseSubscribedTick,
} from "../src/live-data-collector.js";

test("live collector accepts only a valid tick for the expected symbol", () => {
  assert.deepEqual(
    parseSubscribedTick(
      {
        msg_type: "tick",
        tick: { epoch: 1_791_333_600, quote: 1271.25, symbol: "1HZ100V" },
      },
      "1HZ100V",
    ),
    { epoch: 1_791_333_600, quote: 1271.25 },
  );
  assert.equal(parseSubscribedTick({ msg_type: "ping" }, "1HZ100V"), null);
  assert.throws(
    () =>
      parseSubscribedTick(
        {
          msg_type: "tick",
          tick: { epoch: 1_791_333_600, quote: 1271.25, symbol: "R_10" },
        },
        "1HZ100V",
      ),
    /unexpected symbol/,
  );
});

test("live collector surfaces Deriv API errors", () => {
  assert.throws(
    () =>
      parseSubscribedTick(
        { error: { code: "RateLimit", message: "Rate limit reached" } },
        "1HZ100V",
      ),
    /RateLimit/,
  );
});

test("live collector recognizes exhausted history rate limits", () => {
  assert.equal(isRateLimitError(new Error("Rate limit reached")), true);
  assert.equal(isRateLimitError({ code: "RateLimit", message: "Busy" }), true);
  assert.equal(isRateLimitError(new Error("Connection closed")), false);
});
