const API_BASE = "https://api.derivws.com";
const DEMO_WEBSOCKET_PATH = "/trading/v1/options/ws/demo";

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function accountId(account) {
  return account.account_id ?? account.id ?? account.loginid ?? null;
}

function accountType(account) {
  return String(
    account.account_type ?? account.type ?? account.environment ?? "",
  ).toLowerCase();
}

export function validateDemoConfig(config) {
  if (config.mode !== "demo-only") {
    throw new Error("Safety lock: demo config mode must be demo-only.");
  }
  if (config.realEndpointAllowed !== false) {
    throw new Error("Safety lock: realEndpointAllowed must remain false.");
  }
  if (config.risk?.martingale !== false) {
    throw new Error("Safety lock: martingale must remain disabled.");
  }
  if (typeof config.executionEnabled !== "boolean") {
    throw new Error("Safety lock: executionEnabled must be a boolean.");
  }
  if (!config.risk || config.risk.stakeDemoUsd !== 1) {
    throw new Error("Safety lock: the demo stake must remain exactly USD 1.");
  }
  if (config.risk.maxOpenContracts !== 1) {
    throw new Error("Safety lock: only one demo contract may be open at a time.");
  }
  if (
    !Number.isInteger(config.risk.maxTradesPerDay) ||
    config.risk.maxTradesPerDay < 1 ||
    config.risk.maxTradesPerDay > 4
  ) {
    throw new Error("Safety lock: demo trades per day must stay between 1 and 4.");
  }
  if (
    typeof config.risk.maxDailyLossDemoUsd !== "number" ||
    config.risk.maxDailyLossDemoUsd <= 0 ||
    config.risk.maxDailyLossDemoUsd > 5
  ) {
    throw new Error("Safety lock: maximum demo daily loss may not exceed USD 5.");
  }
  if (
    !Number.isInteger(config.risk.cooldownMinutes) ||
    config.risk.cooldownMinutes < 15
  ) {
    throw new Error("Safety lock: demo cooldown must be at least 15 minutes.");
  }
  if (
    config.risk.dailyLimitTimezone !== undefined &&
    config.risk.dailyLimitTimezone !== "UTC"
  ) {
    throw new Error("Safety lock: demo calendar-day limits use UTC.");
  }
  if (config.currency !== "USD") {
    throw new Error("Safety lock: this demo bot is configured only for USD.");
  }
  if (
    config.strategy?.contractDuration !== 5 ||
    config.strategy?.contractDurationUnit !== "t"
  ) {
    throw new Error("Safety lock: the initial demo contract must remain five ticks.");
  }
  if (config.learning?.automaticParameterChanges !== false) {
    throw new Error("Safety lock: automatic strategy mutation must remain disabled.");
  }
  requireNonEmptyString(config.appId, "Deriv app ID");
  return config;
}

export function validateCredentials(credentials) {
  const appId = requireNonEmptyString(credentials.appId, "Deriv app ID");
  const token = requireNonEmptyString(credentials.token, "Deriv PAT");
  if (/\s/.test(token)) {
    throw new Error("Deriv PAT must not contain whitespace.");
  }
  return { appId, token };
}

export function extractAccounts(payload) {
  const candidates = [
    payload?.data,
    payload?.data?.accounts,
    payload?.accounts,
  ];
  const accounts = candidates.find(Array.isArray);
  if (!accounts) {
    throw new Error("Deriv account response did not contain an accounts list.");
  }
  return accounts;
}

export function selectDemoAccount(accounts, requestedAccountId = null) {
  const demoAccounts = accounts.filter((account) => {
    const type = accountType(account);
    return type === "demo" || type === "virtual" || type.includes("demo");
  });

  if (demoAccounts.length === 0) {
    throw new Error("No Deriv demo Options account was returned.");
  }

  if (requestedAccountId) {
    const selected = demoAccounts.find(
      (account) => accountId(account) === requestedAccountId,
    );
    if (!selected) {
      throw new Error("Configured account is not a returned demo account.");
    }
    return selected;
  }

  return demoAccounts[0];
}

export function getAccountId(account) {
  return requireNonEmptyString(accountId(account), "Demo account ID");
}

export function validateDemoWebSocketUrl(value) {
  const url = new URL(requireNonEmptyString(value, "Demo WebSocket URL"));
  if (
    url.protocol !== "wss:" ||
    url.hostname !== "api.derivws.com" ||
    url.pathname !== DEMO_WEBSOCKET_PATH ||
    !url.searchParams.get("otp")
  ) {
    throw new Error(
      "Safety lock: Deriv returned a URL that is not the authenticated demo endpoint.",
    );
  }
  return url.toString();
}

async function readJson(response, action) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Deriv returned non-JSON data while trying to ${action}.`);
  }

  if (!response.ok) {
    const message =
      payload?.errors?.[0]?.message ??
      payload?.error?.message ??
      `HTTP ${response.status}`;
    throw new Error(`Could not ${action}: ${message}`);
  }
  return payload;
}

export async function getOptionsAccounts(credentials, fetchImpl = fetch) {
  const { appId, token } = validateCredentials(credentials);
  const response = await fetchImpl(`${API_BASE}/trading/v1/options/accounts`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Deriv-App-ID": appId,
    },
  });
  return extractAccounts(await readJson(response, "retrieve Options accounts"));
}

export async function getDemoWebSocketUrl(
  credentials,
  demoAccountId,
  fetchImpl = fetch,
) {
  const { appId, token } = validateCredentials(credentials);
  const id = encodeURIComponent(
    requireNonEmptyString(demoAccountId, "Demo account ID"),
  );
  const response = await fetchImpl(
    `${API_BASE}/trading/v1/options/accounts/${id}/otp`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Deriv-App-ID": appId,
      },
    },
  );
  const payload = await readJson(response, "obtain a demo WebSocket OTP");
  return validateDemoWebSocketUrl(payload?.data?.url ?? payload?.url);
}

export { API_BASE, DEMO_WEBSOCKET_PATH };
