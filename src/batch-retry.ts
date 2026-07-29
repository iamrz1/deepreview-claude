import { isRateLimitError } from "./review-helpers.ts";

const BATCH_CONCURRENCY = 2;
const BATCH_DELAY_MS = 1000;
const RATE_LIMIT_DELAY_MS = 60_000;
const RATE_LIMIT_JITTER_MS = 10_000;
const MAX_RATE_LIMIT_RETRIES = 2;

export interface BatchOptions {
  concurrency?: number;
  delayMs?: number;
}

/** Process items in batches with concurrency and inter-batch delay. */
export async function mapBatch<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  opts: BatchOptions = {},
): Promise<R[]> {
  const concurrency = opts.concurrency ?? BATCH_CONCURRENCY;
  const delayMs = opts.delayMs ?? BATCH_DELAY_MS;
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    if (i > 0) await Bun.sleep(delayMs);
    results.push(...(await Promise.all(items.slice(i, i + concurrency).map(fn))));
  }
  return results;
}

/** Retry an async operation with rate-limit-aware backoff. Returns true on success. */
export async function withRateLimitRetry(
  fn: () => Promise<void>,
  label: string,
  maxRetries: number = MAX_RATE_LIMIT_RETRIES,
): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err: unknown) {
    if (!isRateLimitError(err)) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`FAIL: ${label} — ${message}`);
      return false;
    }
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      console.warn(`Rate limited on ${label}. Waiting 60s (retry ${attempt + 1}/${maxRetries})...`);
      await Bun.sleep(RATE_LIMIT_DELAY_MS + Math.floor(Math.random() * RATE_LIMIT_JITTER_MS));
      try {
        await fn();
        return true;
      } catch (retryErr: unknown) {
        if (!isRateLimitError(retryErr)) {
          const message = retryErr instanceof Error ? retryErr.message : String(retryErr);
          console.error(`FAIL: ${label} — ${message}`);
          return false;
        }
      }
    }
    console.error(`FAIL: ${label} — rate limited after retries`);
    return false;
  }
}
