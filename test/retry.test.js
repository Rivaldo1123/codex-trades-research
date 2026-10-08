import assert from "node:assert/strict";
import test from "node:test";

import { retryRateLimited } from "../src/retry.js";

test("retryRateLimited retries a rate-limit response", async () => {
  let calls = 0;
  const delays = [];

  const result = await retryRateLimited(
    async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error("Deriv API error RateLimit: rate limit reached");
      }
      return "ok";
    },
    {
      delaysMs: [5, 10],
      sleep: async (delayMs) => delays.push(delayMs),
    },
  );

  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [5, 10]);
});

test("retryRateLimited does not retry unrelated failures", async () => {
  let calls = 0;

  await assert.rejects(
    retryRateLimited(
      async () => {
        calls += 1;
        throw new Error("Connection refused");
      },
      { delaysMs: [1], sleep: async () => {} },
    ),
    /Connection refused/,
  );

  assert.equal(calls, 1);
});
