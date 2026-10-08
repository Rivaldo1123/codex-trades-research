import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  generateFrozenConfigurations,
  validateSearchProtocol,
} from "../src/strategy-search-config.js";

const protocol = JSON.parse(
  await readFile(
    new URL("../research/protocols/development-screen-v1.json", import.meta.url),
    "utf8",
  ),
);

test("frozen search has 12,012 distinct meaningful configurations", () => {
  validateSearchProtocol(protocol);
  const first = generateFrozenConfigurations(protocol);
  const second = generateFrozenConfigurations(protocol);
  assert.equal(first.configurations.length, 12_012);
  assert.equal(new Set(first.configurations.map((item) => item.configHash)).size, 12_012);
  assert.deepEqual(
    first.configurations.map((item) => item.configHash),
    second.configurations.map((item) => item.configHash),
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(
        Object.groupBy(first.configurations, (item) => item.family),
      ).map(([family, items]) => [family, items.length]),
    ),
    protocol.searchBudget.families,
  );
});

test("payout and delay scenarios are not counted as configurations", () => {
  const generated = generateFrozenConfigurations(protocol);
  assert.ok(
    generated.configurations.every(
      (item) =>
        !Object.hasOwn(item, "entryDelayTicks") &&
        !Object.hasOwn(item, "payoutOnWin"),
    ),
  );
  assert.equal(
    generated.configurations.length *
      protocol.evaluationWindows.length *
      protocol.parameterRanges.entryDelayTicks.length *
      protocol.parameterRanges.profitPerDollarOnWin.length,
    324_324,
  );
});
