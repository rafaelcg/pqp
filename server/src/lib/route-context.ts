import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which route label the current async call stack is running inside, for
 * `db.queries.byRoute` (`lib/db-tx-metrics.ts`) — the per-route half of the
 * 2026-09-13 Vultr cutover's query budget work. `handleApi` (api/index.ts)
 * sets it once, per request, to the matched route's own path template
 * (`"GET /api/servers/:serverId/members"`, never the interpolated id — an
 * id-keyed label would grow without bound); every Postgres round trip that
 * happens anywhere in that request's call stack, including inside a service
 * function several layers down, is then countable against it with no
 * parameter threading.
 *
 * A WS handler, a cold job and anything at boot runs with no route set —
 * `currentRoute()` answers `"other"` for those rather than throwing, so
 * adding this cannot become a new way for either to fail.
 */
const storage = new AsyncLocalStorage<string>();

/** Run `fn` with `route` as the current route label for anything it awaits. */
export function runWithRoute<T>(route: string, fn: () => Promise<T>): Promise<T> {
  return storage.run(route, fn);
}

export function currentRoute(): string {
  return storage.getStore() ?? "other";
}
