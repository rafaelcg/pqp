/**
 * Runs `work` over every item with at most `limit` in flight, and resolves when
 * all are done. A song with many in-mix takes loads its stems through this, so
 * opening one does not start dozens of downloads and decodes at once.
 */
export async function inPool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await work(item);
    }
  });
  await Promise.all(lanes);
}
