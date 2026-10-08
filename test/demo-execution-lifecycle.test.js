import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { hashDemoStrategyConfig, tradeDemoOnce } from "../src/demo-bot.js";
import {
  computeDemoExecutorSourceSha256,
  DEMO_EXECUTOR_VERSION,
} from "../src/demo-deployment-gate.js";
import { hashDemoAccountId } from "../src/demo-identities.js";

const instant = new Date("2026-10-08T12:00:00.000Z");
const epoch = Math.floor(instant.getTime() / 1_000);

function config() {
  return {
    accountId: null,
    appId: "offline-test-app",
    currency: "USD",
    executionEnabled: true,
    learning: {
      automaticParameterChanges: false,
      journalPath: "data/demo/trade-events.jsonl",
      reportPath: "data/demo/learning-report.json",
    },
    mode: "demo-only",
    realEndpointAllowed: false,
    risk: {
      cooldownMinutes: 15,
      dailyLimitTimezone: "UTC",
      martingale: false,
      maxDailyLossDemoUsd: 5,
      maxOpenContracts: 1,
      maxTradesPerDay: 4,
      stakeDemoUsd: 1,
    },
    strategy: {
      candleCount: 100,
      contractDuration: 5,
      contractDurationUnit: "t",
      fastWindow: 2,
      granularitySeconds: 60,
      name: "OFFLINE_FIXTURE_ONLY",
      settlementTimeoutSeconds: 10,
      slowWindow: 3,
    },
    symbol: "1HZ100V",
  };
}

async function writeJson(root, relative, value) {
  const target = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
  return target;
}

async function qualifiedRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "qualified-demo-fixture-"));
  const demoConfig = config();
  const strategyHash = hashDemoStrategyConfig(demoConfig);
  const executorSourceSha256 = await computeDemoExecutorSourceSha256();
  const product = {
    contractTypes: ["CALL", "PUT"],
    currency: "USD",
    duration: 5,
    durationUnit: "t",
    stake: 1,
    symbol: "1HZ100V",
  };
  const executionAssumptions = {
    maxProposalAgeSeconds: 5,
    minimumWinNetPerUnitRisk: 0.5,
    requireCompleteCandles: true,
  };
  const protocol = {
    acceptanceRules: {
      maximumDrawdown: 100,
      minimumCalendarDays: 30,
      minimumLowerConfidenceBound: 0.005,
      minimumNetExpectancy: 0.01,
      minimumTrades: 500,
    },
    candidateId: "offline-lifecycle-fixture",
    candidateSelectedAt: "2026-09-01T00:00:00.000Z",
    executionAssumptions,
    kind: "demo-candidate-qualification-protocol",
    product,
    schemaVersion: 1,
    strategyHash,
  };
  const protocolContent = `${JSON.stringify(protocol, null, 2)}\n`;
  const protocolSha256 = createHash("sha256").update(protocolContent).digest("hex");
  const result = {
    candidateId: protocol.candidateId,
    evaluationWindow: {
      end: "2026-10-02T00:00:00.000Z",
      start: "2026-09-02T00:00:00.000Z",
    },
    executionAssumptions,
    executorSourceSha256,
    generatedAt: "2026-10-03T00:00:00.000Z",
    independentEvaluation: true,
    kind: "demo-candidate-validation-result",
    metrics: {
      calendarDays: 30,
      dependenceAdjustedLowerConfidenceBound: 0.006,
      maximumDrawdown: 10,
      netExpectancy: 0.02,
      operationalFailures: 0,
      trades: 500,
    },
    previouslyViewedBeforeSelection: false,
    protocolSha256,
    schemaVersion: 1,
    strategyHash,
  };
  const resultContent = `${JSON.stringify(result, null, 2)}\n`;
  await writeJson(root, "research/deployment/test-protocol.json", protocol);
  await writeJson(root, "research/deployment/test-result.json", result);
  const evidence = {
    candidateId: protocol.candidateId,
    decision: "QUALIFIED_FOR_CONTROLLED_DEMO_VALIDATION",
    executorSourceSha256,
    executorVersion: DEMO_EXECUTOR_VERSION,
    kind: "qualified-demo-candidate-evidence",
    protocol: {
      path: "research/deployment/test-protocol.json",
      sha256: protocolSha256,
    },
    result: {
      path: "research/deployment/test-result.json",
      sha256: createHash("sha256").update(resultContent).digest("hex"),
    },
    schemaVersion: 1,
    strategyHash,
  };
  const evidenceContent = `${JSON.stringify(evidence, null, 2)}\n`;
  await writeJson(root, "research/deployment/test-evidence.json", evidence);
  await writeJson(root, "research/deployment/active-demo-candidate.json", {
    candidate: {
      candidateId: evidence.candidateId,
      evidence: {
        path: "research/deployment/test-evidence.json",
        sha256: createHash("sha256").update(evidenceContent).digest("hex"),
      },
      executionAssumptions: {
        ...executionAssumptions,
      },
      executorSourceSha256,
      executorVersion: DEMO_EXECUTOR_VERSION,
      product,
      strategyHash,
    },
    executionAuthorized: true,
    kind: "demo-deployment-decision",
    schemaVersion: 1,
    state: "QUALIFIED_FOR_CONTROLLED_DEMO_VALIDATION",
  });
  return root;
}

function client(overrides = {}) {
  return {
    close() {},
    async buyProposal() {
      return { buyPrice: 1, contractId: 7001, transactionId: 8001 };
    },
    async getBalance() { return { amount: 1000, currency: "USD" }; },
    async getCandles() {
      return Array.from({ length: 100 }, (_, index) => ({
        close: 100 + index,
        epoch: epoch - (100 - index) * 60,
        high: 100 + index,
        low: 100 + index,
        open: 100 + index,
      }));
    },
    async getPortfolio() { return []; },
    async getProposal() {
      return {
        askPrice: 1,
        contractType: "CALL",
        currency: "USD",
        duration: 5,
        durationUnit: "t",
        id: "p".repeat(32),
        payout: 1.9,
        spot: 199,
        spotTime: epoch,
        symbol: "1HZ100V",
      };
    },
    async waitForSettlement() {
      return {
        buy_price: "1",
        contract_id: 7001,
        contract_type: "CALL",
        currency: "USD",
        exit_spot: "200",
        exit_spot_time: epoch + 5,
        is_sold: 1,
        profit: "0.9",
        purchase_time: epoch,
        status: "won",
        tick_count: 5,
        underlying_symbol: "1HZ100V",
      };
    },
    ...overrides,
  };
}

function runtime(mockClient, accountId = "VRTC100") {
  let clockTicks = 0;
  return {
    async connectDemo() { return { client: mockClient, id: accountId }; },
    now: () => new Date(instant.getTime() + clockTicks++ * 2_000),
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
  };
}

test("the tracked no-candidate decision blocks before broker connection", async () => {
  let connected = false;
  await assert.rejects(
    tradeDemoOnce({
      config: config(),
      credentials: {},
      projectRoot: path.resolve("."),
      runtime: { async connectDemo() { connected = true; throw new Error("unexpected"); } },
    }),
    /no candidate is qualified/,
  );
  assert.equal(connected, false);
});

test("the real orchestration path executes only an exact hash-bound fixture", async () => {
  const root = await qualifiedRoot();
  try {
    const result = await tradeDemoOnce({
      config: config(), credentials: {}, projectRoot: root, runtime: runtime(client()),
    });
    assert.equal(result.profit, 0.9);
    const journal = (await readFile(path.join(root, "data/demo/trade-events.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    assert.deepEqual(journal.map((event) => event.stage), ["pending", "reconciled", "settled"]);
    assert.ok(journal.every((event) => event.accountFingerprint === hashDemoAccountId("VRTC100")));
    assert.equal(journal[2].contractId, 7001);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a different strategy configuration cannot reuse qualification evidence", async () => {
  const root = await qualifiedRoot();
  try {
    const changed = config();
    changed.strategy.name = "DIFFERENT_VALID_STRATEGY";
    await assert.rejects(
      tradeDemoOnce({ config: changed, credentials: {}, projectRoot: root,
        runtime: runtime(client()) }),
      /identity does not match/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a self-declared qualified flag without frozen protocol and result is insufficient", async () => {
  const root = await qualifiedRoot();
  try {
    const evidencePath = path.join(root, "research/deployment/test-evidence.json");
    const decisionPath = path.join(root, "research/deployment/active-demo-candidate.json");
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    delete evidence.protocol;
    delete evidence.result;
    evidence.qualified = true;
    const content = `${JSON.stringify(evidence, null, 2)}\n`;
    await writeFile(evidencePath, content);
    const decision = JSON.parse(await readFile(decisionPath, "utf8"));
    decision.candidate.evidence.sha256 = createHash("sha256").update(content).digest("hex");
    await writeFile(decisionPath, `${JSON.stringify(decision, null, 2)}\n`);
    await assert.rejects(
      tradeDemoOnce({ config: config(), credentials: {}, projectRoot: root,
        runtime: runtime(client()) }),
      /does not establish the exact candidate qualification/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("immediate settlement cannot substitute another contract identity", async () => {
  const root = await qualifiedRoot();
  try {
    let purchases = 0;
    const mock = client({
      async buyProposal() {
        purchases += 1;
        return { buyPrice: 1, contractId: 7001, transactionId: 8001 };
      },
      async waitForSettlement() {
        return {
          buy_price: 1,
          contract_id: 9999,
          contract_type: "CALL",
          currency: "USD",
          is_sold: 1,
          profit: 0.9,
          status: "won",
          tick_count: 5,
          underlying_symbol: "1HZ100V",
        };
      },
    });
    await assert.rejects(
      tradeDemoOnce({ config: config(), credentials: {}, projectRoot: root,
        runtime: runtime(mock) }),
      /outcome is uncertain/,
    );
    assert.equal(purchases, 1);
    const journal = (await readFile(path.join(root, "data/demo/trade-events.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    assert.equal(journal.at(-1).stage, "uncertain");
    assert.equal(journal.some((event) => event.stage === "settled"), false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a journal failure after purchase leaves the durable intent and never retries", async () => {
  const root = await qualifiedRoot();
  try {
    const events = [];
    let purchases = 0;
    const mock = client({
      async buyProposal() {
        purchases += 1;
        return { buyPrice: 1, contractId: 7001, transactionId: 8001 };
      },
    });
    const injected = {
      ...runtime(mock),
      async appendTradeEvent(_path, event) {
        if (events.length === 1) throw new Error("simulated durable write failure");
        events.push(event);
      },
      async readTradeEvents() { return [...events]; },
    };
    await assert.rejects(
      tradeDemoOnce({ config: config(), credentials: {}, projectRoot: root, runtime: injected }),
      /confirmed but could not be journalled/,
    );
    assert.equal(purchases, 1);
    assert.deepEqual(events.map((event) => event.stage), ["pending"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a journal from another account cannot supply risk state or permit a new purchase", async () => {
  const root = await qualifiedRoot();
  try {
    await writeJson(root, "data/demo/trade-events.jsonl", {});
    const journalPath = path.join(root, "data/demo/trade-events.jsonl");
    await writeFile(journalPath, `${JSON.stringify({
      accountFingerprint: hashDemoAccountId("VRTC-OTHER"),
      contractType: "CALL",
      currency: "USD",
      direction: "up",
      duration: 5,
      durationUnit: "t",
      eventAt: instant.toISOString(),
      maximumLoss: 1,
      stage: "pending",
      stake: 1,
      startedAt: instant.toISOString(),
      strategyHash: hashDemoStrategyConfig(config()),
      symbol: "1HZ100V",
      tradeId: "other-account",
    })}\n`);
    let purchases = 0;
    const mock = client({ async buyProposal() { purchases += 1; throw new Error("no"); } });
    await assert.rejects(
      tradeDemoOnce({ config: config(), credentials: {}, projectRoot: root,
        runtime: runtime(mock, "VRTC100") }),
      /journal belongs to another or unknown account/,
    );
    assert.equal(purchases, 0);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a lost purchase response is journalled uncertain and is never retried in that run", async () => {
  const root = await qualifiedRoot();
  try {
    let purchases = 0;
    const mock = client({
      async buyProposal() {
        purchases += 1;
        throw new Error("response connection closed");
      },
    });
    await assert.rejects(
      tradeDemoOnce({ config: config(), credentials: {}, projectRoot: root,
        runtime: runtime(mock) }),
      /purchase outcome is uncertain/,
    );
    assert.equal(purchases, 1);
    const journal = (await readFile(path.join(root, "data/demo/trade-events.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    assert.deepEqual(journal.map((event) => event.stage), ["pending", "uncertain"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("stale executable quotes are rejected before purchase", async () => {
  const root = await qualifiedRoot();
  try {
    let purchases = 0;
    const mock = client({
      async buyProposal() { purchases += 1; throw new Error("unexpected"); },
      async getProposal() {
        return {
          askPrice: 1,
          contractType: "CALL",
          currency: "USD",
          duration: 5,
          durationUnit: "t",
          id: "p".repeat(32),
          payout: 1.9,
          spot: 199,
          spotTime: epoch - 6,
          symbol: "1HZ100V",
        };
      },
    });
    await assert.rejects(
      tradeDemoOnce({ config: config(), credentials: {}, projectRoot: root,
        runtime: runtime(mock) }),
      /quote-freshness/,
    );
    assert.equal(purchases, 0);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("proposal response latency is included in the quote-freshness check", async () => {
  const root = await qualifiedRoot();
  try {
    let purchases = 0;
    const mock = client({
      async buyProposal() { purchases += 1; throw new Error("unexpected"); },
    });
    const injected = runtime(mock);
    const clock = [instant, new Date(instant.getTime() + 10_000)];
    injected.now = () => new Date((clock.shift() ?? clock.at(-1) ?? instant).getTime());
    await assert.rejects(
      tradeDemoOnce({ config: config(), credentials: {}, projectRoot: root, runtime: injected }),
      /quote-freshness/,
    );
    assert.equal(purchases, 0);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("proposal term evidence is mandatory rather than treated as an optional match", async () => {
  const root = await qualifiedRoot();
  try {
    let purchases = 0;
    const mock = client({
      async buyProposal() { purchases += 1; throw new Error("unexpected"); },
      async getProposal() {
        const proposal = await client().getProposal();
        delete proposal.durationUnit;
        return proposal;
      },
    });
    await assert.rejects(
      tradeDemoOnce({ config: config(), credentials: {}, projectRoot: root,
        runtime: runtime(mock) }),
      /proposal terms differ/i,
    );
    assert.equal(purchases, 0);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("the run lock prevents concurrent order attempts", async () => {
  const root = await qualifiedRoot();
  let entered;
  let release;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const releasePromise = new Promise((resolve) => { release = resolve; });
  try {
    const firstClient = client({
      async getCandles() {
        entered();
        await releasePromise;
        return client().getCandles();
      },
    });
    const first = tradeDemoOnce({
      config: config(), credentials: {}, projectRoot: root, runtime: runtime(firstClient),
    });
    await enteredPromise;
    await assert.rejects(
      tradeDemoOnce({ config: config(), credentials: {}, projectRoot: root,
        runtime: runtime(client()) }),
      /Another demo bot run appears active/,
    );
    release();
    await first;
  } finally {
    release?.();
    await rm(root, { force: true, recursive: true });
  }
});
