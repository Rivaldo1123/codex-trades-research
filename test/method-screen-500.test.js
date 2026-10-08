import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { additionalMethodGroups,
  buildVariantGroupSignals } from "../src/method-screen-500.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(readFileSync(path.join(root, "data", "market",
  "method-screen-500-additional-v1.json"), "utf8"));

test("five fixed families yield exactly 500 distinct additional method variants", () => {
  const groups = additionalMethodGroups(catalog);
  const ids = groups.flatMap((group) => group.ids);
  assert.equal(groups.length, 50);
  assert.equal(ids.length, 500);
  assert.equal(new Set(ids).size, 500);
  assert.deepEqual(groups.map((group) => group.family.name).filter((name, index, all) =>
    all.indexOf(name) === index), catalog.families.map((family) => family.name));
});

test("group signals are causal, abstain before warmup and reset at missing ticks and splits", () => {
  const groups = additionalMethodGroups(catalog);
  const quotes = Float64Array.from(Array.from({ length: 500 }, (_, index) => 100 + index));
  const present = Uint8Array.from(quotes, () => 1);
  for (const group of groups.filter((item) => ["normalized-lag-momentum-300",
    "normalized-price-sma-distance-377", "normalized-tick-streak-2",
    "normalized-sma-spread-3-8", "relative-tick-impulse-5"].some((prefix) =>
    item.ids[0].startsWith(prefix)))) {
    const first = buildVariantGroupSignals(quotes, present, [400], group);
    quotes[499] = -1000;
    const changedFuture = buildVariantGroupSignals(quotes, present, [400], group);
    quotes[499] = 599;
    for (const id of group.ids) {
      assert.ok(first[id].every((value) => value === 0 || value === 1 || value === 2));
      assert.deepEqual(first[id].slice(0, 499), changedFuture[id].slice(0, 499));
      assert.equal(first[id][400], 0);
    }
  }
  present[200] = 0;
  const streak = groups.find((group) => group.ids[0].startsWith("normalized-tick-streak-2-"));
  const withGap = buildVariantGroupSignals(quotes, present, [400], streak);
  assert.equal(withGap[streak.ids[0]][200], 0);
  assert.equal(withGap[streak.ids[0]][201], 0);
});

test("all five families can signal a direction but never force a trade", () => {
  const groups = additionalMethodGroups(catalog);
  const quotes = Float64Array.from(Array.from({ length: 500 }, (_, index) =>
    100 + index + (index === 450 ? 15 : 0)));
  const present = Uint8Array.from(quotes, () => 1);
  for (const family of catalog.families) {
    const group = groups.find((item) => item.family.name === family.name);
    const signals = buildVariantGroupSignals(quotes, present, [], group);
    assert.equal(Object.keys(signals).length, 10);
    assert.equal(signals[group.ids[0]][0], 0);
    assert.ok(signals[group.ids[0]].some((value) => value === 1 || value === 2),
      `${family.name} produced no qualifying signal`);
    for (let index = 0; index < quotes.length; index += 1) {
      const trend = signals[group.ids[0]][index];
      const reverse = signals[group.ids[1]][index];
      assert.equal(reverse, trend === 1 ? 2 : trend === 2 ? 1 : 0);
    }
  }
});
