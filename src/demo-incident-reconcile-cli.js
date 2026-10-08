import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getAccountId,
  getDemoWebSocketUrl,
  getOptionsAccounts,
  selectDemoAccount,
  validateDemoConfig,
} from "./deriv-demo.js";
import { hashDemoAccountId } from "./demo-identities.js";
import { collectDemoIncidentEvidence } from "./demo-incident-reconcile.js";
import { DerivDemoClient } from "./demo-ws-client.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function epoch(value, label, { now = false } = {}) {
  const date = now && value === "now" ? new Date() : new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be an ISO-8601 timestamp${now ? ' or "now"' : ""}.`);
  }
  return Math.floor(date.getTime() / 1_000);
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(projectRoot, relativePath), "utf8"));
}

async function main() {
  const fromValue = argumentValue("--from");
  const toValue = argumentValue("--to") ?? "now";
  const outputValue = argumentValue("--output");
  if (!fromValue || !outputValue) {
    throw new Error(
      "Usage: node src/demo-incident-reconcile-cli.js --from ISO --to ISO|now --output data/demo/incidents/FILE.json",
    );
  }
  const outputPath = path.resolve(projectRoot, outputValue);
  const allowedRoot = path.resolve(projectRoot, "data", "demo", "incidents");
  if (outputPath !== allowedRoot && !outputPath.startsWith(`${allowedRoot}${path.sep}`)) {
    throw new Error("Incident evidence must remain under data/demo/incidents/.");
  }
  const config = validateDemoConfig(await readJson("config.demo.json"));
  const secrets = await readJson("secrets.local.json");
  const credentials = { appId: config.appId, token: secrets.pat };
  const account = selectDemoAccount(
    await getOptionsAccounts(credentials),
    config.accountId,
  );
  const accountId = getAccountId(account);
  const endpoint = await getDemoWebSocketUrl(credentials, accountId);
  const client = new DerivDemoClient(endpoint);
  try {
    await client.connect();
    const evidence = await collectDemoIncidentEvidence({
      accountFingerprint: hashDemoAccountId(accountId),
      client,
      dateFrom: epoch(fromValue, "--from"),
      dateTo: epoch(toValue, "--to", { now: true }),
    });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
    console.log(JSON.stringify({
      classification: evidence.classification,
      incidentDisposition: evidence.incidentDisposition,
      outputPath,
      summary: evidence.summary,
    }, null, 2));
    if (evidence.classification === "UNRESOLVED_OR_OPEN") process.exitCode = 2;
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
