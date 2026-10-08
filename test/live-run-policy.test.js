import assert from "node:assert/strict";
import test from "node:test";

import { liveRunPolicy } from "../src/live-run-policy.js";

test("forward-only collection never requests retrospective catch-up", () => {
  assert.deepEqual(liveRunPolicy(true), {
    forwardOnly: true,
    startupCatchup: false,
    reconnectCatchup: false,
    shutdownCatchup: false,
    requireWholeArchiveContiguous: false,
  });
});

test("legacy collection retains its historical catch-up and archive gate", () => {
  assert.deepEqual(liveRunPolicy(false), {
    forwardOnly: false,
    startupCatchup: true,
    reconnectCatchup: true,
    shutdownCatchup: true,
    requireWholeArchiveContiguous: true,
  });
});
