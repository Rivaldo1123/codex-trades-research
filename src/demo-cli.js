import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  getAccountId,
  getDemoWebSocketUrl,
  getOptionsAccounts,
  selectDemoAccount,
  validateDemoConfig,
} from "./deriv-demo.js";
import {
  createDemoPlan,
  hashDemoStrategyConfig,
  tradeDemoOnce,
} from "./demo-bot.js";
import { verifyDemoDeploymentEligibility } from "./demo-deployment-gate.js";
import {
  createLearningReport,
  readTradeEvents,
  writeLearningReport,
} from "./demo-learning.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function readJson(relativePath) {
  return JSON.parse(
    await readFile(path.join(projectRoot, relativePath), "utf8"),
  );
}

async function main() {
  const command = process.argv[2] ?? "status";
  const config = validateDemoConfig(
    await readJson("config.demo.json").catch((error) => {
      if (error.code === "ENOENT") {
        throw new Error(
          "WAIT: demo execution is not initialized. Copy config.demo.template.json to config.demo.json, keep executionEnabled=false, and add local evidence before considering any demo run.",
        );
      }
      throw error;
    }),
  );

  if (command === "learn") {
    const journalPath = path.join(projectRoot, config.learning.journalPath);
    const reportPath = path.join(projectRoot, config.learning.reportPath);
    const report = createLearningReport(await readTradeEvents(journalPath));
    await writeLearningReport(reportPath, report);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  let deploymentGate;
  try {
    const eligible = await verifyDemoDeploymentEligibility({
      config,
      projectRoot,
      strategyHash: hashDemoStrategyConfig(config),
    });
    deploymentGate = {
      candidateId: eligible.candidateId,
      executionAuthorized: true,
      state: "QUALIFIED_FOR_CONTROLLED_DEMO_VALIDATION",
    };
  } catch (error) {
    deploymentGate = {
      executionAuthorized: false,
      reason: error.message,
      state: "BLOCKED",
    };
  }

  const secrets = await readJson("secrets.local.json").catch((error) => {
    if (error.code === "ENOENT") {
      throw new Error(
        "Demo PAT is not configured. Run `node src/setup-server.js`, then use the local setup page.",
      );
    }
    throw error;
  });

  const credentials = { appId: config.appId, token: secrets.pat };

  if (command === "plan") {
    const plan = await createDemoPlan({ config, credentials });
    console.log(
      JSON.stringify(
        {
          ...plan,
          disclaimer:
            "Demo experiment only. The baseline has not demonstrated a reliable edge.",
          executionEnabled: config.executionEnabled,
          deploymentGate,
          realEndpointAllowed: config.realEndpointAllowed,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "trade-once") {
    if (!process.argv.includes("--confirm-demo")) {
      throw new Error(
        "Refusing to place a demo order without the explicit --confirm-demo flag.",
      );
    }
    const result = await tradeDemoOnce({
      config,
      credentials,
      projectRoot,
    });
    console.log(
      JSON.stringify(
        {
          ...result,
          disclaimer:
            "Virtual-funds result only. It is not evidence of real-money profitability.",
          mode: config.mode,
          realEndpointAllowed: config.realEndpointAllowed,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command !== "status") {
    throw new Error(`Unknown demo command: ${command}`);
  }

  const accounts = await getOptionsAccounts(credentials);
  const account = selectDemoAccount(accounts, config.accountId);
  const id = getAccountId(account);
  const websocketUrl = new URL(
    await getDemoWebSocketUrl(credentials, id),
  );

  console.log(
    JSON.stringify(
      {
        accountIdSuffix: id.slice(-4),
        demoEndpointVerified: websocketUrl.pathname,
        executionEnabled: config.executionEnabled,
        deploymentGate,
        mode: config.mode,
        realEndpointAllowed: config.realEndpointAllowed,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
