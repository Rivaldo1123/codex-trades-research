import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createBrowserLearningReport } from "../src/browser-learning.js";
import { validateDemoConfig } from "../src/deriv-demo.js";

test("fresh-checkout demo template is secret-free and disarmed", async () => {
  const templateText = await readFile(
    new URL("../config.demo.template.json", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(templateText, /(?:token|pat)\s*"?\s*:/i);
  const template = validateDemoConfig(JSON.parse(templateText));
  assert.equal(template.executionEnabled, false);
  assert.equal(template.realEndpointAllowed, false);
  assert.equal(template.risk.dailyLimitTimezone, "UTC");
});

test("missing browser evidence is an explicit non-eligible state", () => {
  const report = createBrowserLearningReport([]);
  assert.equal(report.evidenceAudit.status, "NO_VALID_SETTLEMENTS");
  assert.equal(report.totals.observations, 0);
});
