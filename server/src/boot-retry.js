// ClearPathFBA — boot retry/backoff helper for serverless cold starts.
//
// A suspended Neon compute (autosuspend ~5 min idle) rejects the first
// connect/query with ECONNRESET and takes seconds to wake. The serverless
// entry must retry the boot with a delay between attempts so Neon has time to
// come back, while failing fast on each individual attempt (the pool's
// connectionTimeoutMillis/query_timeout cap any hang).
//
// Pure function with no app imports so it can be unit-tested in isolation
// (inject a fake failing bootstrap + fake sleep).
export function createBootWithRetry({ retries, delayMs, bootstrapFn, sleep, onFail }) {
 const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
 return async function bootWithRetry() {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt += 1) {
   try {
    return await bootstrapFn();
   } catch (err) {
    lastErr = err;
    if (onFail) onFail(attempt + 1, retries, err);
    if (attempt + 1 < retries) await wait(delayMs);
   }
  }
  throw lastErr;
 };
}
