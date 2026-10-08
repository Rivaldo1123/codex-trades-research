import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { DerivPublicClient, PUBLIC_ENDPOINT } from "./deriv-public.js";

export const PROBE_SYMBOLS = Object.freeze(["R_50", "1HZ10V", "R_100"]);
export const PROBE_CONTRACT_TYPES = Object.freeze(["CALL", "PUT"]);

export function publicProposalRequest(symbol, contractType) {
  if (!PROBE_SYMBOLS.includes(symbol) || !PROBE_CONTRACT_TYPES.includes(contractType)) {
    throw new Error("Public payout probe symbol or contract type is not preselected.");
  }
  return {
    proposal: 1,
    amount: 1,
    basis: "stake",
    contract_type: contractType,
    currency: "USD",
    duration: 5,
    duration_unit: "t",
    underlying_symbol: symbol,
  };
}

export function summarizePublicProposal(symbol, contractType, message) {
  const proposal = message?.proposal;
  const askPrice = Number(proposal?.ask_price);
  const payout = Number(proposal?.payout);
  const spot = Number(proposal?.spot);
  const spotTime = Number(proposal?.spot_time);
  if (message?.msg_type !== "proposal" || !Number.isFinite(askPrice) ||
      !Number.isFinite(payout) || !Number.isFinite(spot) ||
      !Number.isInteger(spotTime) || askPrice <= 0 || payout <= askPrice) {
    throw new Error(`Invalid public proposal for ${symbol} ${contractType}.`);
  }
  return { symbol, contractType, stakeUsd: askPrice, payoutUsd: payout,
    netProfitOnWinPerDollarStake: (payout - askPrice) / askPrice,
    quoteSpot: spot, quoteEpoch: spotTime };
}

export async function runPublicPayoutProbe({ projectRoot, clientFactory = () =>
  new DerivPublicClient(), wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const config = JSON.parse(await readFile(path.join(projectRoot, "config.data.json"), "utf8"));
  if (config.mode !== "public-data-only" || config.endpoint !== PUBLIC_ENDPOINT ||
      config.symbol !== "1HZ100V") {
    throw new Error("Public-only safety lock changed; payout probe refused.");
  }
  const client = clientFactory();
  if (client.endpoint !== PUBLIC_ENDPOINT) throw new Error("Payout probe requires public endpoint.");
  const quotes = [];
  try {
    await client.connect();
    for (const symbol of PROBE_SYMBOLS) {
      for (const contractType of PROBE_CONTRACT_TYPES) {
        const payload = publicProposalRequest(symbol, contractType);
        let message;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            message = await client.request(payload, "proposal", 30_000);
            break;
          } catch (error) {
            if (!/RateLimit/.test(String(error)) || attempt === 2) throw error;
            await wait(5_000 * (attempt + 1));
          }
        }
        quotes.push(summarizePublicProposal(symbol, contractType, message));
        await wait(1_500);
      }
    }
  } finally {
    client.close();
  }
  const report = {
    kind: "public-indicative-payout-probe",
    generatedAtUtc: new Date().toISOString(),
    endpoint: PUBLIC_ENDPOINT,
    mode: "public-data-only",
    durationTicks: 5,
    quoteCount: quotes.length,
    quotes,
    limitations: [
      "No account, token, proposal purchase, or Bot Builder Run was used.",
      "Public proposals are indicative snapshots, not account-specific executable fills.",
      "Payout and Bot Builder entry timing may change; these snapshots cannot prove profitability.",
    ],
    botBuilderRunPermission: false,
    demoOrderPermission: false,
    realOrderPermission: false,
  };
  const reportDirectory = path.join(projectRoot, "data", "reports");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = path.join(reportDirectory,
    `public-payout-probe-${Date.now()}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return { report, reportPath };
}
