/**
 * `db.tx.byPath`: a small in-process counter, keyed by a short label, of how
 * many Postgres round trips each labelled call site has issued since boot.
 *
 * WHY THIS EXISTS. The 2026-09-12 watch party ran ~330 Postgres transactions
 * a second against 60-90 seated users and killed a shared-CPU database, and
 * nobody could say *which* query path was responsible — every candidate
 * (roster membership checks, registry seat writes, heartbeats, NOTIFY
 * fan-out) was a plausible story and none of them had a number. This is the
 * number. It is deliberately not a histogram or a timer: a count keyed by a
 * short label is cheap enough to wrap around a hot path with no measurable
 * overhead, and "which path fires the most" is the only question that
 * mattered that night.
 *
 * WHAT IT IS NOT. Not a replacement for real APM, not per-request, not
 * exported anywhere but `GET /api/admin/metrics`. Counts are cumulative since
 * boot (or since the last `resetDbTxMetrics()`, which only tests call), the
 * same convention `voice.roster` and `voice.cluster` already use on that
 * endpoint: a number that only grows is honest about what it is, and a rate
 * is for the caller to derive by polling twice.
 *
 * WHERE IT IS WIRED. Not every `pool.query` call in the codebase — that would
 * be a much larger, riskier diff for the same answer. Only the voice /
 * presence / registry call sites this investigation actually needed to see:
 * `registry.*` (server/src/voice/registry.ts), `users.canAccessChannel`
 * (server/src/services/users.ts), and `bus.publish*` (server/src/lib/
 * bus-postgres.ts). See each call site's label for what it counts.
 */

const counts = new Map<string, number>();

/** Record one Postgres round trip against a labelled call site. */
export function noteDbTx(label: string): void {
  counts.set(label, (counts.get(label) ?? 0) + 1);
}

/** Snapshot of every label counted so far, for `GET /api/admin/metrics`. */
export function dbTxByPath(): Record<string, number> {
  return Object.fromEntries(counts);
}

// ------------------------------------------------------- db.queries.total
//
// `db.tx.byPath` above counts a handful of call sites this file was written
// for. This half counts EVERY query the app issues through `getPool()`,
// wrapped once at the pool itself (`db.ts`'s `getPool`), which is what makes
// "did the 2026-09-13 cache work actually cut the call volume" a number
// instead of a guess. `byRoute` breaks that same total down by the HTTP
// route the query happened inside (`lib/route-context.ts`) — a WS handler, a
// cold job, or anything at boot has no route and is counted under "other".

let totalQueries = 0;
const queriesByRoute = new Map<string, number>();

/** Record one Postgres round trip, full stop — called from the pool wrapper
 *  in `db.ts`, not from individual call sites. */
export function noteDbQuery(route: string): void {
  totalQueries += 1;
  queriesByRoute.set(route, (queriesByRoute.get(route) ?? 0) + 1);
}

export function dbQueryTotal(): number {
  return totalQueries;
}

/** Snapshot of every route counted so far, for `GET /api/admin/metrics`. */
export function dbQueriesByRoute(): Record<string, number> {
  return Object.fromEntries(queriesByRoute);
}

/** Test seam. Also the only correct answer to a raw `TRUNCATE` of nothing —
 *  there is no table here, but a suite that wants a clean slate calls this. */
export function resetDbTxMetrics(): void {
  counts.clear();
  totalQueries = 0;
  queriesByRoute.clear();
}

/**
 * The minimal shape both `pg.Pool` and `pg.Client` satisfy structurally, so
 * this wrapper works around either — `registry.ts` and `users.ts` call
 * through `getPool()` (a `Pool`), `bus-postgres.ts` owns its own `pg.Client`
 * (it cannot use the pool, see that file) — and around a fake in a unit test
 * that has no Postgres at all.
 */
export interface Queryable {
  query<T extends object = never>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

/**
 * `pool.query(text, params)`, counted under `label`. One extra `Map.set` per
 * call; the query itself is unchanged.
 */
export function countedQuery<T extends object = never>(
  pool: Queryable,
  label: string,
  text: string,
  params?: unknown[],
): Promise<{ rows: T[]; rowCount?: number | null }> {
  noteDbTx(label);
  return pool.query<T>(text, params);
}
