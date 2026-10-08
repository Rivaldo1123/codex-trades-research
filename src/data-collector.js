import { setTimeout as delay } from "node:timers/promises";

import {
  appendTickChunk,
  coverageIntervals,
  filterUncoveredTicks,
  readManifest,
  summarizeManifest,
} from "./data-store.js";
import { retryRateLimited } from "./retry.js";

function chooseHistoricalEnd(manifest, cutoffEpoch) {
  const intervals = coverageIntervals(manifest.chunks);
  if (intervals.length === 0) {
    return "latest";
  }

  if (intervals.length > 1) {
    return intervals.at(-1).firstEpoch - 1;
  }

  const oldest = intervals[0].firstEpoch;
  return oldest > cutoffEpoch ? oldest - 1 : null;
}

export async function collectTickHistory({ client, config, projectRoot }) {
  let manifest = await readManifest(projectRoot, config.symbol);
  let pagesFetched = 0;
  let rowsReceived = 0;
  let rowsStored = 0;
  let chunksStored = 0;
  let newestObservedEpoch = summarizeManifest(manifest).lastEpoch;

  const fetchPage = async (end, start) => {
    if (pagesFetched > 0 && config.requestDelayMs > 0) {
      await delay(config.requestDelayMs);
    }
    const ticks = await retryRateLimited(
      () => client.getTicksHistory(config.symbol, { count: config.pageSize, end, start }),
      {
        onRetry: ({ attempt, delayMs }) => {
          console.warn(
            `Deriv rate limit reached. Tick-history retry ${attempt} in ${delayMs / 1000} seconds.`,
          );
        },
      },
    );
    pagesFetched += 1;
    rowsReceived += ticks.length;
    newestObservedEpoch = Math.max(
      newestObservedEpoch ?? 0,
      ticks.at(-1)?.epoch ?? 0,
    );

    const uncovered = filterUncoveredTicks(ticks, manifest.chunks);
    if (uncovered.length === 0) {
      return 0;
    }
    const result = await appendTickChunk(projectRoot, config.symbol, uncovered);
    manifest = result.manifest;
    rowsStored += uncovered.length;
    chunksStored += result.chunk ? 1 : 0;
    return uncovered.length;
  };

  // Always touch the newest page first so an offline collector catches up before
  // spending the rest of its request budget on older history.
  await fetchPage("latest");
  const anchorEpoch = newestObservedEpoch ?? Math.floor(Date.now() / 1000);
  const cutoffEpoch = anchorEpoch - config.targetHistoryDays * 86_400;

  while (pagesFetched < config.historyPagesPerRun) {
    const end = chooseHistoricalEnd(manifest, cutoffEpoch);
    if (end === null) {
      break;
    }
    const stored = await fetchPage(end, cutoffEpoch);
    if (stored === 0) {
      break;
    }
  }

  return {
    archive: summarizeManifest(manifest),
    chunksStored,
    cutoffEpoch,
    pagesFetched,
    rowsReceived,
    rowsStored,
    symbol: config.symbol,
  };
}
