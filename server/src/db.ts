import pg from "pg";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearPoolStats,
  noteRuntimeSample,
  registerPoolStats,
  registerDbBreakerStats,
} from "./lib/runtime.js";
import {
  createDbBreaker,
  DB_BREAKER_PROBE_INTERVAL_MS,
  type DbBreaker,
  type DbBreakerState,
  type DbBreakerStats,
} from "./lib/db-breaker.js";
import { HttpError } from "./lib/http.js";
import { logEvent } from "./lib/log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let pool: pg.Pool | null = null;

/**
 * The 503 a DB-dependent caller gets instead of queueing on a saturated or
 * unreachable pool for `connectionTimeoutMillis` (30s). It is an `HttpError`
 * so every existing `catch (error) { if (error instanceof HttpError) ... }`
 * in `api/index.ts` already answers *something* sane; the handful of central
 * catch points special-case this subclass first, to also set
 * `Retry-After: 5` and the exact `{ error: "database_unavailable" }` body
 * A3.1 asks for.
 */
export class DatabaseUnavailableError extends HttpError {
  constructor() {
    super(503, "database_unavailable");
    this.name = "DatabaseUnavailableError";
  }
}

/**
 * `DB_BREAKER=off` (or `false` / `0`) is the rollback switch — the breaker
 * still tracks state and logs it, but `guardPoolQueries` never fast-rejects
 * a query, so the process behaves exactly as it did before this shipped.
 * Default on.
 */
export function isDbBreakerEnabled(): boolean {
  const raw = process.env.DB_BREAKER;
  return raw !== "off" && raw !== "false" && raw !== "0";
}

/**
 * The breaker's own connection, deliberately NOT `getPool()`. Two reasons,
 * both from a first review of this change:
 *
 *  - If the probe drew from the app pool, it would have to go through
 *    `guardPoolQueries` below like every other query, and during `half-open`
 *    that guard MUST reject ordinary application queries while still letting
 *    the one recovery trial through — which needs some way to tell "this is
 *    the breaker's own probe" from "this is a request". A private, ungated
 *    connection sidesteps that distinction entirely: the guard can reject
 *    unconditionally whenever the breaker is not `closed`, full stop.
 *  - A stalled Postgres does not make a query fail instantly; `pg` has no
 *    query cancellation this version can use (no `AbortSignal` support), so
 *    a probe that times out client-side can still be running server-side.
 *    On the shared pool that is a checked-out connection an application
 *    request cannot use; on this dedicated one it only ever blocks the NEXT
 *    probe tick, which is bounded by `statement_timeout`/`query_timeout`
 *    below rather than accumulating pool pressure during the exact outage
 *    the breaker exists to contain.
 *
 * Lazily connected, dropped and reconnected on any error — a connection that
 * has seen an error is in an unknown state and must not be reused silently.
 */
let probeClient: pg.Client | null = null;

async function probeConnection(): Promise<void> {
  let client = probeClient;
  if (!client) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is required");
    }
    client = new pg.Client({
      connectionString,
      // Bounded independently of the app pool's own timeouts: this
      // connection exists only to answer "is Postgres reachable, right
      // now", so it must fail fast rather than inherit the pool's patience.
      connectionTimeoutMillis: 2_000,
      statement_timeout: 1_000,
      query_timeout: 1_000,
      ...pgSslConfig(),
    });
    client.on("error", (error) => {
      console.error("[db] breaker probe connection error:", error);
      if (probeClient === client) {
        probeClient = null;
      }
    });
    // Published BEFORE the connection attempt settles, not after — a Farol
    // pass caught that `abortProbeConnection` below could only ever reach a
    // client whose `connect()` had already resolved, so a probe stalled
    // DURING the connection handshake itself (Postgres accepted the TCP
    // connection but never finished its own startup exchange — exactly what
    // a saturated real server does, and a different failure shape than the
    // "refused" a closed port produces) had nothing published for the
    // timeout race to tear down. `client.end()` on a still-connecting
    // client is well-defined in `pg`: it closes the socket and the pending
    // `connect()` below rejects, which is exactly what "abandoned" needs to
    // mean here.
    probeClient = client;
    await client.connect();
  }
  try {
    await client.query("SELECT 1");
  } catch (error) {
    if (probeClient === client) {
      probeClient = null;
    }
    void client.end().catch(() => {});
    throw error;
  }
}

/** Test/shutdown hook: drop the probe's own connection. */
export async function closeDbBreakerProbe(): Promise<void> {
  const client = probeClient;
  probeClient = null;
  await client?.end().catch(() => {});
}

/**
 * `db-breaker.ts`'s `probeWithinBudget` calls this the instant a probe
 * misses `DB_BREAKER_LATENCY_BUDGET_MS`, before it gives up on it. A Farol
 * pass on this PR caught that the race alone only stopped COUNTING the
 * probe: `pg` has no query cancellation this version can use, so the
 * connection attempt or the `SELECT 1` kept running past the race, toward
 * `connectionTimeoutMillis`/`query_timeout` above (2s / 1s) — up to a
 * second and a half longer than the 750ms this process had already stopped
 * waiting on it. Ending the socket here, synchronously, means the NEXT tick
 * (`DB_BREAKER_PROBE_INTERVAL_MS` later) starts a fresh connection instead
 * of finding one still mid-attempt, and `probeConnectionActiveForTests`
 * below goes false right away rather than up to 1.5s later.
 *
 * Idempotent with `probeConnection`'s own catch block by construction: both
 * only touch `probeClient` if it's still the client they know about, so
 * whichever runs first wins and the second is a no-op.
 */
function abortProbeConnection(): void {
  const client = probeClient;
  if (!client) {
    return;
  }
  probeClient = null;
  void client.end().catch(() => {});
}

/** Test hook: is the breaker's probe connection currently open/connecting? */
export function probeConnectionActiveForTests(): boolean {
  return probeClient !== null;
}

const dbBreaker: DbBreaker = createDbBreaker({
  probe: probeConnection,
  abortProbe: abortProbeConnection,
  poolStats: () => currentDbBreakerPoolStats(),
  onStateChange: (next, previous) => {
    logEvent("db.breaker.stateChange", { from: previous, to: next });
  },
});

registerDbBreakerStats(() => dbBreaker.stats());

let dbBreakerSamplerTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the breaker's own `SELECT 1` timer. Separate from `services/ready.ts`'s
 * pool sampler (which only runs its Postgres probe when an external monitor
 * asks `/ready`): the breaker has to notice a dead database even when nobody
 * is polling anything. Idempotent; returns the stopper. Unref'd, same as
 * every other background timer in this process — it must never be the reason
 * `node` refuses to exit.
 */
export function startDbBreakerSampler(): () => void {
  if (dbBreakerSamplerTimer) {
    return () => stopDbBreakerSampler();
  }
  dbBreakerSamplerTimer = setInterval(() => {
    void dbBreaker.tick().catch(() => {
      // A sampler must never be the reason a request path throws.
    });
  }, DB_BREAKER_PROBE_INTERVAL_MS);
  dbBreakerSamplerTimer.unref?.();
  return () => stopDbBreakerSampler();
}

function stopDbBreakerSampler(): void {
  if (dbBreakerSamplerTimer) {
    clearInterval(dbBreakerSamplerTimer);
    dbBreakerSamplerTimer = null;
  }
}

export function dbBreakerState(): DbBreakerState {
  return dbBreaker.state();
}

export function dbBreakerStats(): DbBreakerStats {
  return dbBreaker.stats();
}

/** Test hook: forget every clock, streak and count, and stop the sampler. */
export function resetDbBreakerForTests(): void {
  stopDbBreakerSampler();
  dbBreaker.reset();
  void closeDbBreakerProbe();
}

/**
 * Test hook: jump the breaker straight to a state, for an HTTP-level test
 * that wants "the breaker is open" as a precondition without waiting on a
 * real failing probe and a real grace window first.
 */
export function forceDbBreakerStateForTests(state: DbBreakerState): void {
  dbBreaker.forceStateForTests(state);
}

/**
 * Test hook: run exactly one of the breaker's own sampling ticks (sample the
 * pool, probe Postgres when the state calls for it, step the state machine)
 * against the real singleton, without waiting for `DB_BREAKER_PROBE_INTERVAL_MS`
 * on a real timer. Real wall-clock time still passes for the probe's own
 * race against `DB_BREAKER_LATENCY_BUDGET_MS`, unlike `db-breaker.test.ts`'s
 * fully-faked clock — this hook exists specifically for tests that need the
 * real `probeConnection`/`abortProbeConnection` wiring, not an approximation
 * of it.
 */
export async function tickDbBreakerForTests(): Promise<void> {
  await dbBreaker.tick();
}

/**
 * Every query issued through the pool this process holds, while the breaker
 * is open, counts against the same threshold — so this reads the pool the
 * breaker itself watches, not a second bookkeeping path.
 */
function currentDbBreakerPoolStats(): { waiting: number } | null {
  if (!pool) {
    return null;
  }
  return { waiting: pool.waitingCount };
}

/**
 * Whether the pool wrapper should fast-reject right now: the breaker is
 * enabled and not `closed`.
 *
 * NOT `isOpen()`. A first review of this change correctly flagged that
 * checking `isOpen()` alone let every ordinary request through during
 * `half-open`, which is supposed to be a single recovery TRIAL — with the
 * pool wrapper unguarded there, a still-broken database would let a whole
 * burst of application queries queue or hang again the moment the cooldown
 * elapsed, instead of only the breaker's own probe. That is safe to do
 * unconditionally now that the probe runs on its own connection
 * (`probeConnection` above) rather than through this pool at all: nothing
 * that reaches `guardPoolQueries`'s wrapped methods is ever the breaker
 * checking itself, so `half-open` can reject everything here with no risk
 * of the breaker rejecting its own recovery attempt.
 */
function shouldRejectDbCall(): boolean {
  return isDbBreakerEnabled() && dbBreaker.state() !== "closed";
}

/**
 * Makes every call through `target.query`, `target.connect()` and the
 * `PoolClient.query` of whatever `connect()` hands back — however it was
 * reached, `pool` or `registry.ts`'s own imports, a one-off query or a
 * transaction acquired for `BEGIN`/`COMMIT` — fail fast while the breaker is
 * open or half-open, instead of joining pg-pool's queue and waiting out
 * `connectionTimeoutMillis` one caller at a time.
 *
 * BOTH HALVES MATTER. A first review of this change found that only
 * `target.query` was wrapped: every transactional write in this codebase
 * (`server/src/services/*.ts`, `getPool().connect()` then `client.query(...)`
 * for `BEGIN`/`COMMIT`) went straight around it, so exactly the writes this
 * change was meant to protect — the ones most likely to be mid-flight when a
 * pool empties — still queued or hung. `connect()` itself is guarded too,
 * not just the client it returns: checking out a connection from a
 * saturated or dead pool is the failure this whole change exists to avoid,
 * and letting `connect()` through only to reject the first `query()` on the
 * client it returned would still pay that cost.
 *
 * The wrapper only intercepts; a call issued while the breaker is closed is
 * entirely unmodified, same object, same promise.
 *
 * `no-explicit-any`-clean on purpose: `pg.Pool.query` and `PoolClient.query`
 * are large overloaded signatures (this codebase only ever uses the promise
 * form, `query(text, params?)`, never the callback form), so the wrapper
 * forwards through `unknown` and the assignment back onto the object's
 * `query`/`connect` property is asserted rather than structurally checked.
 * Call sites are unaffected — `pool.query<T>(...)` still type-checks against
 * `pg.Pool`'s own declared (generic) signature, because TypeScript resolves
 * that from the variable's static type, not from whatever function object
 * happens to be sitting there at runtime.
 */
/**
 * `pg-pool` reuses the same `PoolClient` object across checkouts whenever an
 * idle one is available (`pg-pool/index.js`'s `_pulseQueue` hands an
 * `IdleItem`'s client straight to `_acquireClient` rather than minting a
 * fresh one) — a second review of this change flagged that `guardedConnect`
 * re-wrapping `client.query` on every checkout, with no way to tell "already
 * guarded" from "fresh", nests a new closure around the last one each time a
 * long-lived process reuses the same client, growing without bound over the
 * life of the pool. This set is what makes `guardQueryMethod` idempotent per
 * object: the pool itself and every `PoolClient` are wrapped exactly once,
 * ever, however many times a client is checked out and released. A
 * `WeakSet`, not a flag on the object, so it never fights whatever `pg`
 * itself does with the object's own properties.
 */
const guardedQueryTargets = new WeakSet<object>();

/**
 * A Farol pass on this PR found the sharpest bug in this whole file:
 * `guardQueryMethod` rejected EVERY query on an open client, `BEGIN` and
 * `COMMIT`/`ROLLBACK` included. A client mid-transaction that has already
 * issued a write, hits the breaker on its next statement, and lands in the
 * ordinary `catch { ROLLBACK } finally { client.release() }` shape every
 * service in this codebase uses (`server/src/services/*.ts`) gets that
 * `ROLLBACK` rejected TOO — by this guard, synthetically, nothing to do with
 * whether Postgres itself is reachable — so the rollback never reaches
 * Postgres, the client is released as if clean, and pg-pool hands the SAME
 * connection to a later, unrelated request with an open transaction still
 * sitting on it. `BEGIN` on a connection already inside a transaction is a
 * warning, not a reset, so that later request's own writes land inside the
 * earlier request's transaction and its `COMMIT` commits both — writes a
 * caller was told had failed, silently persisted under somebody else's
 * request. Two changes fix this, together:
 *
 *  - Transaction-control statements (`BEGIN`, `COMMIT`, `ROLLBACK`, and
 *    `SAVEPOINT`/`RELEASE` even though nothing in this codebase issues those
 *    today) are NEVER rejected by this guard, breaker state notwithstanding.
 *    If Postgres is genuinely unreachable they fail on their own, at the
 *    driver level, which is a real error the caller's existing catch already
 *    has to handle — this guard must not manufacture an ADDITIONAL way for
 *    exactly the cleanup statement to fail.
 *  - Every `PoolClient` this module hands out is tracked while it has an
 *    open transaction (`BEGIN` succeeded, no `COMMIT`/`ROLLBACK` has
 *    succeeded since). If the guard rejects a query on such a client — the
 *    exact case above — the client is marked poisoned, and `guardClientRelease`
 *    below forces `release(err)` on it regardless of what the caller passes,
 *    so pg-pool destroys the connection instead of returning a dirty one to
 *    its idle list. A `ROLLBACK`/`COMMIT` that itself fails (a real
 *    connection error, Postgres truly gone) poisons the client the same way,
 *    for the same reason: its outcome is unknown, and unknown is not clean.
 */
const TRANSACTION_BEGIN = /^\s*(BEGIN\b|START\s+TRANSACTION\b)/i;
const TRANSACTION_END = /^\s*(COMMIT\b|END\b|ROLLBACK\b)(?!\s+TO\b)/i;
const TRANSACTION_MID = /^\s*(SAVEPOINT\b|RELEASE\b)/i;

function queryTextOf(args: unknown[]): string | null {
  const first = args[0];
  if (typeof first === "string") {
    return first;
  }
  if (
    first &&
    typeof first === "object" &&
    "text" in first &&
    typeof (first as { text: unknown }).text === "string"
  ) {
    return (first as { text: string }).text;
  }
  return null;
}

type TransactionControlKind = "begin" | "end" | "mid" | null;

function transactionControlKind(args: unknown[]): TransactionControlKind {
  const text = queryTextOf(args);
  if (!text) {
    return null;
  }
  if (TRANSACTION_BEGIN.test(text)) {
    return "begin";
  }
  if (TRANSACTION_END.test(text)) {
    return "end";
  }
  if (TRANSACTION_MID.test(text)) {
    return "mid";
  }
  return null;
}

/** Clients with a `BEGIN` that has not yet been closed by a `COMMIT`/`ROLLBACK`. */
const openTransactionClients = new WeakSet<object>();
/** Clients a rejected query poisoned mid-transaction — must be destroyed, never reused. */
const poisonedClients = new WeakSet<object>();

function guardQueryMethod(
  target: { query: (...args: unknown[]) => unknown },
): void {
  if (guardedQueryTargets.has(target)) {
    return;
  }
  guardedQueryTargets.add(target);
  const original = target.query.bind(target) as (
    ...args: unknown[]
  ) => Promise<unknown>;
  const guarded = (...args: unknown[]): Promise<unknown> => {
    const kind = transactionControlKind(args);
    if (kind === null && shouldRejectDbCall()) {
      dbBreaker.noteRejected();
      if (openTransactionClients.has(target)) {
        poisonedClients.add(target);
      }
      return Promise.reject(new DatabaseUnavailableError());
    }
    const result = original(...args);
    if (kind === "begin") {
      return result.then(
        (value) => {
          openTransactionClients.add(target);
          return value;
        },
        (error: unknown) => {
          // A `BEGIN` that itself failed never opened a transaction.
          throw error;
        },
      );
    }
    if (kind === "end") {
      return result.then(
        (value) => {
          openTransactionClients.delete(target);
          return value;
        },
        (error: unknown) => {
          // The transaction's fate is now unknown — Postgres refused or
          // never heard the statement meant to resolve it one way or the
          // other. Never hand this connection back out as if it were clean.
          poisonedClients.add(target);
          throw error;
        },
      );
    }
    return result;
  };
  (target as { query: unknown }).query = guarded;
}

/**
 * Wraps `PoolClient.release` so a client `guardQueryMethod` poisoned mid-transaction
 * is destroyed rather than returned to pg-pool's idle list, regardless of what
 * the caller's own `finally { client.release() }` passes — the caller has no
 * way to know the guard rejected its `ROLLBACK`, so it cannot be the one
 * deciding whether this connection is safe to reuse.
 *
 * NOT idempotency-guarded like `guardQueryMethod` — deliberately, and for the
 * opposite reason. `pg-pool` reassigns `client.release` to a brand new
 * closure on EVERY checkout (`this._releaseOnce(client, idleListener)` in
 * `pg-pool/index.js`'s `connect()`, right before handing the client back),
 * unlike `client.query`, which persists across checkouts and is exactly why
 * THAT guard needs a `WeakSet` to stay idempotent. A `WeakSet` here would
 * guard the wrong thing: the first checkout's wrapper would survive being
 * recorded as "already guarded" while pg-pool quietly threw it away and
 * installed a fresh, unwrapped `release` underneath for every checkout
 * after the first — which is exactly how an early version of this fix
 * passed on a client's FIRST checkout and silently stopped working on its
 * second. Called fresh from `guardedConnect` on every checkout instead, to
 * wrap whatever pg-pool just installed, every time.
 */
function guardClientRelease(client: pg.PoolClient): void {
  const originalRelease = client.release.bind(client);
  (client as unknown as { release: (err?: Error | boolean) => void }).release = (
    err?: Error | boolean,
  ) => {
    if (poisonedClients.has(client)) {
      poisonedClients.delete(client);
      openTransactionClients.delete(client);
      originalRelease(
        err instanceof Error
          ? err
          : new Error(
              "A DB-breaker rejection landed mid-transaction on this client; destroying it instead of returning a possibly-dirty connection to the pool.",
            ),
      );
      return;
    }
    originalRelease(err);
  };
}

function guardPoolQueries(target: pg.Pool): void {
  guardQueryMethod(target as unknown as { query: (...args: unknown[]) => unknown });

  const originalConnect = target.connect.bind(target) as (
    ...args: unknown[]
  ) => Promise<pg.PoolClient>;
  const guardedConnect = async (...args: unknown[]): Promise<pg.PoolClient> => {
    if (shouldRejectDbCall()) {
      dbBreaker.noteRejected();
      throw new DatabaseUnavailableError();
    }
    const client = await originalConnect(...args);
    // Guarded once per checkout. A client returned by `connect()` is reused
    // across every query in its transaction, so this covers `BEGIN`,
    // whatever runs between it and `COMMIT`/`ROLLBACK`, and both of those.
    // Defensive on `client` itself: the callback overload of `pg.Pool.connect`
    // resolves this wrapper's `await` to `undefined` rather than a client
    // (the callback receives it instead), and this codebase's own call sites
    // never use that form, but this guard must never be the thing that turns
    // an already-unusual result into a crash of its own.
    if (client) {
      guardQueryMethod(client as unknown as { query: (...args: unknown[]) => unknown });
      guardClientRelease(client);
    }
    return client;
  };
  (target as unknown as { connect: unknown }).connect = guardedConnect;
}

/**
 * Opt into TLS when the host needs it (most managed Postgres over public
 * networking). Left off by default so local/dev works without certs.
 *
 * Shared rather than inlined because the cluster bus holds a connection
 * *outside* the pool (LISTEN needs a session of its own), and a bus that
 * disagreed with the pool about TLS would simply fail to connect on every
 * managed host.
 */
export function pgSslConfig(): { ssl?: { rejectUnauthorized: boolean } } {
  const useSsl =
    process.env.DATABASE_SSL === "true" || process.env.PGSSLMODE === "require";
  return useSsl ? { ssl: { rejectUnauthorized: false } } : {};
}

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is required");
    }
    const max = Number(process.env.PG_POOL_MAX ?? 10);
    const created = new pg.Pool({
      connectionString,
      max,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ...pgSslConfig(),
    });
    pool = created;
    // A3.1: fail fast on every query while the breaker is open, rather than
    // let each caller discover a dead database by queueing on this pool.
    guardPoolQueries(created);
    // Idle-client errors (Postgres restart, network blip) are emitted on the
    // pool; without a listener they crash the process.
    created.on("error", (error) => {
      console.error("[db] idle client error:", error);
    });

    // Saturation, for the operator dashboard's `runtime` block. All four are
    // plain property reads, so exposing them costs nothing and adds no query;
    // `max` is closed over rather than read back off the pool so this does not
    // depend on a pg internal. See lib/runtime.ts.
    registerPoolStats(() => ({
      max,
      total: created.totalCount,
      idle: created.idleCount,
      waiting: created.waitingCount,
    }));
    // A checkout is the only moment the queue is observable from outside pg:
    // there is no event for *joining* the queue, and a 30-second poll would
    // miss a stampede that forms and drains between two reads (a deploy makes
    // every connected client reconnect at once, and one person opening the app
    // costs on the order of a hundred checkouts). The listener is four number
    // comparisons and never touches the network.
    created.on("acquire", noteRuntimeSample);
  }
  return pool;
}

export async function closePool(): Promise<void> {
  const current = pool;
  pool = null;
  // Before the await: nothing should be able to read counters off a pool that
  // is being torn down.
  clearPoolStats();
  await current?.end().catch(() => {});
  await closeDbBreakerProbe();
}

export async function initDb(): Promise<void> {
  const schema = readFileSync(join(__dirname, "schema.sql"), "utf8");
  await getPool().query(schema);
}

export interface DbUser {
  id: string;
  clerk_id: string;
  display_name: string;
  username: string | null;
  discriminator: string | null;
  avatar_url: string | null;
  /**
   * The object-storage key behind `avatar_url`, set only when the picture was
   * uploaded here. Null for a Clerk image, a preset, or a typed URL — see the
   * column comment in schema.sql. Optional because several reads select a
   * narrower column list; treat an absent value as "unknown", not as "none".
   */
  avatar_key?: string | null;
  /** Domains of verified emails only — see `verifiedEmailDomains` in auth/clerk.ts. */
  email_domains?: string[];
  /**
   * True for an operator-provisioned member of the house cast — see
   * services/characters.ts and the `users.is_character` comment in schema.sql.
   *
   * Optional because several reads select a narrower column list, and an absent
   * value must read as "not a character": the flag only ever *removes*
   * capability (no DMs, no friend requests, no voice, no self-deletion), so
   * failing to see it degrades to the ordinary user's behaviour rather than to
   * a character's, which is the safe direction for a person and the loud one
   * for a character.
   */
  is_character?: boolean;
  /**
   * The account's public handle — the `rafa` in `pqp.gg/@rafa` — or null.
   *
   * A SECOND name, and not a replacement for `username`: `username` is unique
   * only when paired with `discriminator`, so it can never address a URL on its
   * own. See the `users.handle` block in schema.sql. Optional here for the same
   * reason as `is_character`: several reads select a narrower column list, and
   * an absent value must read as "unknown", never as "this account has none".
   */
  handle?: string | null;
  /** When the handle last moved; drives the 30-day rename cooldown. */
  handle_changed_at?: Date | string | null;
  /**
   * The strip across the top of `pqp.gg/@rafa`. `banner_url` is what the public
   * profile payload carries; `banner_key` is the storage key and is read only
   * by the banner routes and by the swap that has to orphan the old object.
   *
   * Optional for the same reason every field above it is: several reads select
   * a narrower column list, and an absent value must read as "unknown" rather
   * than as "this account has none" — a null written from an absent value is
   * how a picture disappears on an unrelated save.
   */
  banner_url?: string | null;
  banner_key?: string | null;
  /**
   * O recado, the line this account wrote under its own name, or null when it
   * has none. Optional for the same reason as everything above it: several
   * reads select a narrower column list, and an absent value must read as
   * "unknown" rather than as "this account has none", because a null written
   * from an absent value is how somebody's status disappears on an unrelated
   * save. See the `users.custom_status` block in schema.sql.
   */
  custom_status?: string | null;
  /** When the account was created. Month-truncated before it reaches a page. */
  created_at?: Date | string | null;
  /**
   * First-touch acquisition: the campaign parameters on the URL the person
   * first landed with, written once and never overwritten. See the
   * `acquisition` block in schema.sql. NOT in DB_USER_COLUMNS on purpose: no
   * user payload carries these, and the only reader is the operator report in
   * services/acquisition.ts, which selects them by name. Optional here so the
   * narrower reads type-check; an absent value means "not selected", never
   * "unattributed".
   */
  acquisition_source?: string | null;
  acquisition_medium?: string | null;
  acquisition_campaign?: string | null;
  acquisition_gclid?: string | null;
  acquisition_ref?: string | null;
  acquisition_landing?: string | null;
  acquisition_at?: Date | string | null;
}

export interface DbServer {
  id: string;
  name: string;
  owner_id: string;
  created_at: Date;
  message_retention_days: number | null;
  sso_email_domain: string | null;
  /**
   * The server's own pictures. `*_url` is what every payload carries; `*_key`
   * is the storage key and is read only by `server-images.ts` and by the delete
   * path that has to orphan the objects. Optional on the type because
   * `SERVER_COLUMNS` deliberately does not select the keys.
   */
  icon_url: string | null;
  banner_url: string | null;
  icon_key?: string | null;
  banner_key?: string | null;
  is_community?: boolean;
  community_home_enabled?: boolean;
  /** Only present on reads that join the viewer's `server_members` row. */
  show_on_profile?: boolean;
  role?: "owner" | "admin" | "member";
}

export interface DbChannel {
  id: string;
  server_id: string;
  name: string;
  type: "text" | "voice" | "category" | "thread" | "watch_party";
  position: number;
  is_private: boolean;
  topic: string | null;
  image_url: string | null;
  parent_id: string | null;
  slowmode_seconds: number;
  /** NULL means automatic; see voice/transport-policy.ts. */
  voice_transport: "mesh" | "livekit" | null;
}

export interface DbMessage {
  id: string;
  channel_id: string;
  author_id: string;
  body: string;
  created_at: Date;
  edited_at?: Date | null;
  author_name?: string;
  author_username?: string | null;
  author_discriminator?: string | null;
  author_avatar_url?: string | null;
  reply_to_id?: string | null;
  /** Joined from the parent message; absent when this row is not a reply. */
  reply_author_id?: string | null;
  reply_author_name?: string | null;
  reply_body?: string | null;
  pinned_at?: Date | null;
  pinned_by?: string | null;
  /** Joined from `pinned_by`; absent or null when the pinner has since left. */
  pinned_by_name?: string | null;
  /** Joined from `author_id`; true when the author is a webhook's pseudo-identity. */
  author_is_webhook?: boolean;
  /** Joined from `author_id`; true when the author is the AutoMod pseudo-user. */
  author_is_automod?: boolean;
  webhook_embeds?: unknown;
  webhook_username?: string | null;
  webhook_avatar_url?: string | null;
  mention_everyone?: boolean;
  mention_here?: boolean;
  chance?: unknown;
}

export interface DbInvite {
  id: string;
  server_id: string;
  code: string;
  created_by: string;
  max_uses: number | null;
  uses: number;
  expires_at: Date | null;
  created_at: Date;
  server_name?: string;
}

export type MemberRole = "owner" | "admin" | "member";
