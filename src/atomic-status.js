import { rename } from "node:fs/promises";

const RETRYABLE_RENAME_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);

export async function renameStatusFileWithRetry(
  source,
  destination,
  {
    renameFile = rename,
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    maxAttempts = 8,
  } = {},
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await renameFile(source, destination);
      return;
    } catch (error) {
      if (!RETRYABLE_RENAME_ERRORS.has(error.code) || attempt === maxAttempts) {
        throw error;
      }
      await wait(Math.min(25 * 2 ** (attempt - 1), 800));
    }
  }
}
