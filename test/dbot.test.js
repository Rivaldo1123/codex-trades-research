import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("every XML workspace is registered as an immutable disarmed archive", async () => {
  const registry = JSON.parse(await readFile(
    path.join(projectRoot, "dbot", "archive-registry.json"), "utf8"));
  assert.equal(registry.executionAuthorized, false);
  assert.equal(registry.deploymentGate, "WAIT_NO_QUALIFIED_CANDIDATE");
  for (const artifact of registry.artifacts) {
    const bytes = await readFile(path.join(projectRoot, "dbot", artifact.file));
    assert.equal(bytes.length, artifact.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  }
});

test("Deriv Bot XML keeps its fixed-stake demo guardrails", async () => {
  const xml = await readFile(
    path.join(projectRoot, "dbot", "Codex_DEMO_Guarded_SMA.xml"),
    "utf8",
  );
  assert.match(xml, /<field name="SYMBOL_LIST">1HZ100V<\/field>/);
  assert.match(xml, /<field name="DURATIONTYPE_LIST">t<\/field>/);
  assert.match(xml, /id="codex_duration">\s*<field name="NUM">5<\/field>/);
  assert.match(xml, /id="codex_amount">\s*<field name="NUM">1<\/field>/);
  assert.match(xml, /<field name="RESTARTONERROR">FALSE<\/field>/);
  assert.match(xml, /id="codex_four">\s*<field name="NUM">4<\/field>/);
  assert.match(xml, /<field name="PURCHASE_LIST">CALL<\/field>/);
  assert.match(xml, /<field name="PURCHASE_LIST">PUT<\/field>/);
  assert.equal((xml.match(/<block type="trade_again"/g) ?? []).length, 1);
  assert.doesNotMatch(xml, /<block type="[^\"]*martingale/i);
});

test("browser learning XML is one-shot and refuses weak Rise signals", async () => {
  const xml = await readFile(
    path.join(projectRoot, "dbot", "Codex_Browser_Learning_OneTick_Rise.xml"),
    "utf8",
  );
  assert.match(xml, /<field name="SYMBOL_LIST">1HZ100V<\/field>/);
  assert.match(xml, /id="browser_learning_duration">\s*<field name="NUM">1<\/field>/);
  assert.match(xml, /id="browser_learning_amount">\s*<field name="NUM">1<\/field>/);
  assert.match(xml, /id="browser_fast_ten">\s*<field name="NUM">10<\/field>/);
  assert.match(xml, /id="browser_slow_twenty">\s*<field name="NUM">20<\/field>/);
  assert.match(xml, /<field name="RESTARTONERROR">FALSE<\/field>/);
  assert.match(xml, /<field name="PURCHASE_LIST">CALL<\/field>/);
  assert.match(xml, /WAIT: the 10-tick SMA is not above the 20-tick SMA/);
  assert.equal((xml.match(/<block type="purchase"/g) ?? []).length, 1);
  assert.equal((xml.match(/<block type="trade_again"/g) ?? []).length, 0);
  assert.doesNotMatch(xml, /<block type="[^\"]*martingale/i);
});

test("saved Fall experiment XML is fixed-stake and disarmed", async () => {
  const xml = await readFile(
    path.join(projectRoot, "dbot", "Codex_Browser_Learning_OneTick_Fall.xml"),
    "utf8",
  );
  assert.match(xml, /<field name="SYMBOL_LIST">1HZ100V<\/field>/);
  assert.match(xml, /<field name="DURATIONTYPE_LIST">t<\/field>/);
  assert.match(xml, /<field name="NUM">1<\/field>/);
  assert.match(xml, /<field name="RESTARTONERROR">FALSE<\/field>/);
  assert.match(xml, /<field name="TIME_MACHINE_ENABLED">FALSE<\/field>/);
  assert.match(xml, /<field name="PURCHASE_LIST">PUT<\/field>/);
  assert.match(xml, /<block type="trade_again"[^>]*disabled="true"/);
  assert.doesNotMatch(xml, /<block type="[^\"]*martingale/i);
});

test("conditional Fall XML waits unless the fast SMA is below the slow SMA", async () => {
  const xml = await readFile(
    path.join(
      projectRoot,
      "dbot",
      "Codex_Browser_Learning_OneTick_Fall_Signal.xml",
    ),
    "utf8",
  );
  assert.match(xml, /id="browser_fall_duration">\s*<field name="NUM">1<\/field>/);
  assert.match(xml, /id="browser_fall_amount">\s*<field name="NUM">1<\/field>/);
  assert.match(xml, /id="browser_fall_fast_ten">\s*<field name="NUM">10<\/field>/);
  assert.match(xml, /id="browser_fall_slow_twenty">\s*<field name="NUM">20<\/field>/);
  assert.match(xml, /<field name="OP">LT<\/field>/);
  assert.match(xml, /<field name="PURCHASE_LIST">PUT<\/field>/);
  assert.equal((xml.match(/<block type="purchase"/g) ?? []).length, 1);
  assert.equal((xml.match(/<block type="trade_again"/g) ?? []).length, 0);
});

test("saved five-tick Rise experiment XML is fixed-stake and disarmed", async () => {
  const xml = await readFile(
    path.join(projectRoot, "dbot", "Codex_Browser_Learning_FiveTick_Rise.xml"),
    "utf8",
  );
  assert.match(xml, /<field name="SYMBOL_LIST">1HZ100V<\/field>/);
  assert.match(xml, /<field name="DURATIONTYPE_LIST">t<\/field>/);
  assert.match(xml, /<field name="NUM">5<\/field>/);
  assert.match(xml, /<field name="PURCHASE_LIST">CALL<\/field>/);
  assert.match(xml, /<block type="trade_again"[^>]*disabled="true"/);
  assert.match(xml, /<field name="RESTARTONERROR">FALSE<\/field>/);
});
