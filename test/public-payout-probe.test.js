import assert from "node:assert/strict";
import test from "node:test";

import { publicProposalRequest, summarizePublicProposal } from
  "../src/public-payout-probe.js";

test("payout probe can request only fixed public five-tick Rise/Fall proposals", () => {
  assert.deepEqual(publicProposalRequest("R_50", "CALL"), {
    proposal: 1, amount: 1, basis: "stake", contract_type: "CALL", currency: "USD",
    duration: 5, duration_unit: "t", underlying_symbol: "R_50",
  });
  assert.throws(() => publicProposalRequest("frxEURUSD", "CALL"));
  assert.throws(() => publicProposalRequest("R_50", "MULTUP"));
});

test("payout probe saves only indicative prices, never a purchasable proposal id", () => {
  const result = summarizePublicProposal("R_50", "PUT", {
    msg_type: "proposal", proposal: { id: "do-not-save", ask_price: 1,
      payout: 1.95, spot: 81.5328, spot_time: 1_791_430_000 },
  });
  assert.equal(result.netProfitOnWinPerDollarStake, 0.95);
  assert.equal(JSON.stringify(result).includes("do-not-save"), false);
  assert.throws(() => summarizePublicProposal("R_50", "PUT", {
    msg_type: "proposal", proposal: { ask_price: 1, payout: 0.9,
      spot: 1, spot_time: 1_791_430_000 },
  }));
});
