/**
 * Runs `fn` over `items`, at most `limit` in flight at once, in whatever
 * order they settle -- a plain worker-pool, no library. Exists because
 * `Promise.all(items.map(fn))` starts every request in the same tick, and
 * for a per-channel network check (`useWatchPartyHistoryAvailability`) that
 * is an unbounded burst the moment a server has more than a couple of
 * eligible channels.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
