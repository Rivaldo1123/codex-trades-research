import path from "node:path";
import { fileURLToPath } from "node:url";

import { captureRetrospectivePilotGaps } from "./retrospective-pilot-recovery.js";

if (process.argv.length !== 2) {
  console.error("This recovery is pinned to the completed v3 pilot; no overrides are accepted.");
  process.exitCode = 2;
} else {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  captureRetrospectivePilotGaps({ projectRoot }).then(({ report, reportPath }) => {
    console.log(JSON.stringify({ reportPath, state: report.state,
      recoveredRows: report.recoveredRows, stillMissingRows: report.stillMissingRows,
      ranges: report.ranges.map(({ firstEpoch, lastEpoch, recoveredRows, stillMissingRows }) =>
        ({ firstEpoch, lastEpoch, recoveredRows, stillMissingRows })) }, null, 2));
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
