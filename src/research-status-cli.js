import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildResearchStatus, strictExitCode } from "./research-status.js";

function parseArgs(args) {
  if (args.length === 0) return { strictMode: null };
  if (args.length === 1 && args[0] === "--strict") return { strictMode: "public" };
  if (args.length === 1 && ["--strict=public", "--strict=reproduction"].includes(args[0])) {
    return { strictMode: args[0].split("=")[1] };
  }
  throw new Error(
    "Usage: node src/research-status-cli.js [--strict|--strict=public|--strict=reproduction]",
  );
}

const { strictMode } = parseArgs(process.argv.slice(2));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const status = await buildResearchStatus({
  projectRoot,
  recomputeDevelopment: strictMode === "reproduction",
});
console.log(JSON.stringify(status, null, 2));
if (strictMode) process.exitCode = strictExitCode(status, strictMode);
