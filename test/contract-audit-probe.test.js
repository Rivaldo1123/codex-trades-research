import assert from "node:assert/strict";
import test from "node:test";

import {
  runContractAuditProbe,
  summarizeIndicativeProposal,
  summarizeTickContracts,
} from "../src/contract-audit-probe.js";
import { PUBLIC_ENDPOINT } from "../src/deriv-public.js";

test("contract availability audit retains tick/clock distinction", () => {
  const contracts = summarizeTickContracts({
    msg_type: "contracts_for",
    contracts_for: {
      available: [
        { contract_category: "callput", contract_type: "PUT", expiry_type: "tick",
          max_contract_duration: "10t", min_contract_duration: "1t", sentiment: "down",
          underlying_symbol: "1HZ100V" },
        { contract_category: "callput", contract_type: "CALL", expiry_type: "tick",
          max_contract_duration: "10t", min_contract_duration: "1t", sentiment: "up",
          underlying_symbol: "1HZ100V" },
        { contract_category: "callput", contract_type: "CALL", expiry_type: "intraday",
          max_contract_duration: "1d", min_contract_duration: "15s", sentiment: "up",
          underlying_symbol: "1HZ100V" },
      ],
    },
  });
  assert.deepEqual(contracts.map((item) => item.contractType), ["CALL", "PUT"]);
  assert.ok(contracts.every((item) => item.expiryType === "tick"));
});

test("proposal audit separates gross payout from net profit", () => {
  const proposal = summarizeIndicativeProposal({
    msg_type: "proposal",
    proposal: {
      ask_price: "1.00",
      longcode: "Win payout if the exit is strictly higher.",
      payout: "1.95",
      spot: 1234.5,
      spot_time: 1_700_000_000,
    },
  }, { contractType: "CALL", durationTicks: 5 });
  assert.equal(proposal.grossPayout, 1.95);
  assert.equal(proposal.netProfitOnWin, 0.95);
  assert.equal(proposal.netProfitOnWinPerDollarStake, 0.95);
});

test("public probe cannot use an authenticated or alternate endpoint", async () => {
  const client = { endpoint: `${PUBLIC_ENDPOINT}?otp=secret`, close() {} };
  await assert.rejects(
    runContractAuditProbe({ clientFactory: () => client, wait: async () => {} }),
    /unauthenticated public endpoint/,
  );
});
