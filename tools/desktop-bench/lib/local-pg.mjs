// The guard between this tool and any database that is not a scratch one on
// this machine. `pg` takes a connection string's query options as overrides
// (`?host=db.example` wins over the URL's own host), so a URL that passes a
// hostname check can still connect elsewhere. This refuses any query string
// and hands `pg` explicit fields built from the pieces it checked, never the
// raw URL.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * @param {string} urlString
 * @param {{ benchDatabase?: boolean }} [options] benchDatabase: the database must be named pqp_bench*
 * @returns {{ host: string, port: number, user: string, password: string, database: string }}
 */
export function localPgConfig(urlString, { benchDatabase = false } = {}) {
  const url = new URL(urlString);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("desktop-bench: not a postgres URL");
  }
  if (url.search || url.hash) {
    throw new Error("desktop-bench refuses connection-string options (they can override the host)");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!LOOPBACK.has(host)) {
    throw new Error(`desktop-bench refuses a non-local database host: ${host}`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (benchDatabase && !/^pqp_bench/.test(database)) {
    throw new Error(`desktop-bench only touches databases named pqp_bench*, got "${database}"`);
  }
  return {
    host,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

/** Throws unless `apiUrl` is a loopback http URL: the seed uses a bearer anyone may present. */
export function assertLoopbackApi(apiUrl) {
  const url = new URL(apiUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!LOOPBACK.has(host)) throw new Error(`desktop-bench refuses a non-local API: ${host}`);
}
