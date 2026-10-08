import assert from "node:assert/strict";
import test from "node:test";

import {
  DerivPublicClient,
  PUBLIC_ENDPOINT,
} from "../src/deriv-public.js";

test("the public client accepts only the locked public endpoint", () => {
  assert.doesNotThrow(() => new DerivPublicClient(PUBLIC_ENDPOINT));
  assert.throws(
    () => new DerivPublicClient("wss://api.derivws.com/trading/v1/options/ws/real"),
    /Safety lock/,
  );
});
