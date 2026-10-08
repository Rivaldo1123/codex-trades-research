import { createHash } from "node:crypto";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalHash(value) {
  return sha256(JSON.stringify(canonicalize(value)));
}

export function hashDemoAccountId(accountId) {
  if (typeof accountId !== "string" || accountId.trim() === "") {
    throw new Error("Demo account identity is required.");
  }
  return sha256(`deriv-demo-account-v1\0${accountId.trim()}`);
}

export function demoStrategyIdentity(config) {
  return canonicalHash({
    identitySchema: "demo-strategy-configuration-v2",
    currency: config.currency,
    executionEnabled: config.executionEnabled,
    learning: {
      automaticParameterChanges: config.learning?.automaticParameterChanges,
    },
    mode: config.mode,
    promotionGate: config.promotionGate ?? null,
    realEndpointAllowed: config.realEndpointAllowed,
    risk: config.risk,
    strategy: config.strategy,
    symbol: config.symbol,
  });
}
