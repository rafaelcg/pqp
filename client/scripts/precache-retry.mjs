/**
 * The retry loop behind `check-precache.mjs`, kept apart so a test can drive it
 * with a fake clock and a fake `fetch`.
 *
 * A fresh Pages deployment does not answer for every file at once. Two runs of
 * `deploy-web.yml` on 2026-10-12 failed on that and nothing else: the preview
 * check at 17:23Z (2 chunks 404, so production web stayed 4.5 h behind main)
 * and run 38312607504 at 21:47Z (13 of 131 entries 404 on the production URL
 * ~14 s after upload, every one 200 a minute later). Every file was in dist.
 *
 * So: check everything once, then re-check only the entries that failed, every
 * `intervalMs`, until `windowMs` has passed. An entry that still fails at the
 * end fails the gate, exactly as before; a 308 or 404 that persists is a real
 * defect (the 2026-09-30 incident) and stays red.
 */

/** Window and spacing defaults; `PRECACHE_RETRY_WINDOW_S` / `_INTERVAL_S` override. */
export const DEFAULT_WINDOW_MS = 120_000;
export const DEFAULT_INTERVAL_MS = 10_000;

/**
 * @param {object} options
 * @param {string[]} options.paths precache entries, relative to the origin
 * @param {(path: string) => Promise<number | string>} options.statusOf 200, another status, or an error code
 * @param {number} [options.windowMs] how long failing entries keep being re-checked
 * @param {number} [options.intervalMs] pause between re-checks
 * @param {number} [options.concurrency]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.now]
 * @param {(line: string) => void} [options.log]
 */
export async function checkWithRetry({
  paths,
  statusOf,
  windowMs = DEFAULT_WINDOW_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  concurrency = 8,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  log = () => {},
}) {
  const startedAt = now();

  /** Every path's status, at most `concurrency` requests at once. */
  async function check(batch) {
    const results = new Map();
    let next = 0;
    async function lane() {
      while (next < batch.length) {
        const path = batch[next++];
        results.set(path, await statusOf(path));
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, batch.length) }, lane),
    );
    return results;
  }

  const results = await check(paths);
  let pending = paths.filter((path) => results.get(path) !== 200);
  const firstFailures = pending.length;
  let attempts = 1;

  // Only the failing entries are asked again, and one shared pause covers all
  // of them: a deploy that is still propagating fails many files at once.
  while (pending.length > 0 && now() - startedAt + intervalMs <= windowMs) {
    log(
      `${pending.length} of ${paths.length} entries not 200 yet, re-checking in ${Math.round(intervalMs / 1000)}s`,
    );
    await sleep(intervalMs);
    const again = await check(pending);
    attempts += 1;
    for (const [path, status] of again) results.set(path, status);
    pending = pending.filter((path) => results.get(path) !== 200);
  }

  const failed = new Map(pending.map((path) => [path, results.get(path)]));
  return {
    failed,
    recovered: firstFailures - failed.size,
    attempts,
    elapsedMs: now() - startedAt,
    firstFailures,
  };
}
