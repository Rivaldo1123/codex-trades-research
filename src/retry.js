const DEFAULT_DELAYS_MS = [5_000, 15_000, 30_000];

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function retryRateLimited(
  operation,
  {
    delaysMs = DEFAULT_DELAYS_MS,
    onRetry = () => {},
    sleep = wait,
  } = {},
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const rateLimited = /rate\s*limit/i.test(error?.message ?? "");
      if (!rateLimited || attempt >= delaysMs.length) {
        throw error;
      }

      const delayMs = delaysMs[attempt];
      onRetry({ attempt: attempt + 1, delayMs, error });
      await sleep(delayMs);
    }
  }
}

export { DEFAULT_DELAYS_MS };
