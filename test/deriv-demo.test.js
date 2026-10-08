import assert from "node:assert/strict";
import test from "node:test";

import {
  extractAccounts,
  selectDemoAccount,
  validateDemoConfig,
  validateDemoWebSocketUrl,
} from "../src/deriv-demo.js";

test("demo config rejects execution and real-endpoint access", () => {
  const safe = {
    appId: "app123",
    executionEnabled: false,
    currency: "USD",
    learning: { automaticParameterChanges: false },
    mode: "demo-only",
    realEndpointAllowed: false,
    risk: {
      cooldownMinutes: 15,
      martingale: false,
      maxDailyLossDemoUsd: 5,
      maxOpenContracts: 1,
      maxTradesPerDay: 4,
      stakeDemoUsd: 1,
    },
    strategy: { contractDuration: 5, contractDurationUnit: "t" },
  };
  assert.doesNotThrow(() => validateDemoConfig(safe));
  assert.doesNotThrow(() =>
    validateDemoConfig({ ...safe, executionEnabled: true }),
  );
  assert.throws(
    () => validateDemoConfig({ ...safe, realEndpointAllowed: true }),
    /Safety lock/,
  );
  assert.throws(
    () =>
      validateDemoConfig({
        ...safe,
        risk: { ...safe.risk, stakeDemoUsd: 2 },
      }),
    /Safety lock/,
  );
});

test("demo URL validator rejects the real-money endpoint", () => {
  assert.match(
    validateDemoWebSocketUrl(
      "wss://api.derivws.com/trading/v1/options/ws/demo?otp=abc",
    ),
    /\/ws\/demo/,
  );
  assert.throws(
    () =>
      validateDemoWebSocketUrl(
        "wss://api.derivws.com/trading/v1/options/ws/real?otp=abc",
      ),
    /Safety lock/,
  );
});

test("account helpers select only a demo account", () => {
  const accounts = extractAccounts({
    data: {
      accounts: [
        { account_id: "real-1", account_type: "real" },
        { account_id: "demo-1", account_type: "demo" },
      ],
    },
  });
  assert.equal(selectDemoAccount(accounts).account_id, "demo-1");
  assert.throws(() => selectDemoAccount(accounts, "real-1"), /not a returned demo/);
});
