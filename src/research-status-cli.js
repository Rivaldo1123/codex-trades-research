import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildResearchStatus } from "./research-status.js";

if (process.argv.length !== 2) {
  throw new Error("Usage: node src/research-status-cli.js");
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
console.log(JSON.stringify(await buildResearchStatus({ projectRoot }), null, 2));
