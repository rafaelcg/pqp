import pg from "pg";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearPoolStats,
  noteRuntimeSample,
  registerPoolStats,
  registerPoolCheckoutStats,
  registerDbBreakerStats,
} from "./lib/runtime.js";
import {
  noteCheckout,
  noteCheckoutQuery,
  noteRelease,
  poolCheckoutStats,
  startStuckCheckoutSweeper,
  stopStuckCheckoutSweeper,
} from "./lib/pool-checkouts.js";
import { processRole } from "./lib/process-role.js";
import {
  createDbBreaker,
  DB_BREAKER_PROBE_INTERVAL_MS,
  type DbBreaker,
  type DbBreakerState,
  type DbBreakerStats,
} from "./lib/db-breaker.js";
import { HttpError } from "./lib/http.js";
import { logEvent } from "./lib/log.js";
import { noteDbQuery } from "./lib/db-tx-metrics.js";
import { currentRoute } from "./lib/route-context.js";

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
    try {
      await client.connect();
    } catch (error) {
      // A SECOND Farol pass caught the gap publishing early opened: a
      // `connect()` that rejects on its own (refused, not aborted by us)
      // left this exact same client sitting in `probeClient` with nothing
      // to un-publish it, so the NEXT tick would find a "connection" here,
      // skip creating a fresh one, and waste a probe running `SELECT 1`
      // against a client that was never actually connected — one tick's
      // delay before the `query`-time catch below would have caught it
      // anyway. Same cleanup as that catch, done here too, so a failed
      // `connect()` is exactly as terminal as a failed query.
      if (probeClient === client) {
        probeClient = null;
      }
      void client.end().catch(() => {});
      throw error;
    }
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

/**
 * Strips `--` line comments, `/* *\/` block comments, and single/double-quoted
 * regions (doubling a quote is SQL's own escape for one inside a literal,
 * e.g. `'it''s'`) out of a query string, leaving only the `;` characters
 * that could actually be statement separators. A first version of the
 * multi-statement check below scanned the RAW text for any `;`, and a
 * second Farol pass caught that this misclassified a perfectly ordinary
 * `ROLLBACK; -- because the breaker was open` — a trailing comment on the
 * SAME statement — as a bundled multi-statement string, sending that exact
 * ROLLBACK back through rejection while the breaker is open and
 * reintroducing the dirty-transaction bug this guard exists to prevent.
 * Not a general SQL parser — it does not need to be, only correct about
 * where a `;` can and cannot mean "another statement follows".
 */
function stripCommentsAndLiterals(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "-" && text[i + 1] === "-") {
      // A `--` comment ends at the line's end. A fourth Farol pass caught
      // that scanning only for `\n` treats a `\r`-only ("old Mac") line
      // ending as never terminating the comment, dropping everything after
      // it -- including any REAL statement-separating `;` -- rather than
      // stopping where Postgres's own lexer does.
      let end = -1;
      for (let k = i + 2; k < text.length; k++) {
        if (text[k] === "\n" || text[k] === "\r") {
          end = k;
          break;
        }
      }
      if (end === -1) {
        break;
      }
      i = end;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      // Postgres nests block comments (unlike C or the SQL standard) --
      // `/* /* */ */` is ONE comment, not one that ends at the first `*/`.
      // The same Farol pass caught that stopping there could leave the
      // outer comment's own tail un-stripped, which can carry a `;` that
      // wrongly disqualifies an ordinary ROLLBACK/COMMIT from
      // control-statement treatment -- rejecting exactly the cleanup
      // statement the dirty-transaction fix depends on going through.
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === "/" && text[j + 1] === "*") {
          depth += 1;
          j += 2;
          continue;
        }
        if (text[j] === "*" && text[j + 1] === "/") {
          depth -= 1;
          j += 2;
          continue;
        }
        j += 1;
      }
      if (depth > 0) {
        break;
      }
      i = j - 1;
      continue;
    }
    const quote = text[i];
    if (quote === "'" || quote === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === quote) {
          if (text[j + 1] === quote) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      i = j;
      continue;
    }
    result += text[i];
  }
  return result;
}

/**
 * Postgres's simple query protocol treats a `;` outside any comment or
 * quoted region as a statement separator, so
 * `client.query("BEGIN; DELETE FROM users; COMMIT")` is ONE call carrying
 * THREE statements. A Farol pass caught that classifying by first keyword
 * alone would read that whole string as `"begin"` and let the guard wave
 * the bundled `DELETE` through unrejected along with it. Nothing in this
 * codebase issues a query this way today (every call site here is one
 * statement per `client.query`), but the guard itself must not assume that
 * stays true — a single trailing `;` is normal and allowed; a real `;`
 * anywhere else means this is not the single control statement it looks
 * like at a glance.
 */
function isSingleStatement(text: string): boolean {
  const stripped = stripCommentsAndLiterals(text).trim();
  const withoutTrailingSemicolon = stripped.endsWith(";")
    ? stripped.slice(0, -1)
    : stripped;
  return !withoutTrailingSemicolon.includes(";");
}

type TransactionControlKind = "begin" | "end" | "mid" | null;

function transactionControlKind(args: unknown[]): TransactionControlKind {
  const text = queryTextOf(args);
  if (!text || !isSingleStatement(text)) {
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

/**
 * `original(...args)` is typed as returning a `Promise`, but that is this
 * module's own convenience cast (see the big comment above `guardQueryMethod`'s
 * sibling `guardPoolQueries`) — `pg.Pool.query`/`PoolClient.query` also has a
 * callback overload that returns a plain `Query` object with no `.then`.
 * Nothing in this codebase uses that overload today, but a Farol pass on
 * this exact function caught that calling `.then` unconditionally on the
 * result would still be a crash waiting for whichever call site uses it
 * first, for a class of query (transaction control) this guard now runs
 * DIFFERENT code on. Falling back to a plain pass-through for a non-thenable
 * result means such a call still WORKS — same as it always did — it simply
 * does not get transaction-state tracking, which requires sequencing this
 * guard cannot get from a callback-style call anyway.
 */
function isThenable(value: unknown): value is Promise<unknown> {
  return (
    !!value &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Clients with a `BEGIN` that has not yet been closed by a `COMMIT`/`ROLLBACK`. */
const openTransactionClients = new WeakSet<object>();
/**
 * Clients that must be destroyed on release rather than returned to the idle
 * list, mapped to WHY, so the line the destruction logs names the cause
 * instead of asserting the only one this map originally had.
 */
const poisonedClients = new WeakMap<object, string>();

function poisonClient(client: object, reason: string): void {
  if (!poisonedClients.has(client)) {
    poisonedClients.set(client, reason);
  }
}

/**
 * Whether an error means this connection can never be trusted again, and if
 * so, which kind.
 *
 * THE DISTINCTION THIS FILE TURNS ON. A Postgres error that arrived as an
 * ErrorResponse followed by a ReadyForQuery is a connection that RESYNCHRONISED:
 * the server and this client agree about where they are in the protocol, and
 * the connection is immediately reusable. `57014 canceling statement due to
 * statement timeout` is exactly that, which is why it is deliberately NOT in
 * the list below: destroying a connection Postgres cleanly cancelled would
 * churn the whole pool during a slow-query storm and buy nothing, since there
 * is nothing wrong with it.
 *
 * `query_timeout` is the opposite case and the reason this function exists. It
 * is a client-side timer, not a cancellation: pg has no query cancellation
 * this version can use, so when it fires, the statement may still be running
 * server-side and the response it is waiting for may still arrive later, out
 * of band, onto a socket somebody else is by then using. The client's protocol
 * state is unknown. That is precisely the staging failure (a reply lost in a
 * proxy), and a client in that state that a caller's ordinary
 * `finally { client.release() }` hands back as idle is a pool slot as dead as
 * it was before this change, now with the pool believing it is free.
 *
 * Connection-level errors are here for the same reason: the socket is gone or
 * the backend was terminated, so whatever the driver thinks about the
 * connection is no longer true.
 */
export function isPoisoningQueryError(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const message =
    typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : "";
  // pg's own read-timeout error carries no `code`; the message is the only
  // handle it gives (`Query read timeout`, client.js). Matched loosely so a
  // wording change upstream degrades to "not poisoned" rather than to a
  // crash, and pinned by `isPoisoningQueryError`'s own test.
  if (/query read timeout/i.test(message)) {
    return "query-read-timeout";
  }
  if (
    /connection terminated|client has encountered a connection error|client was closed|terminating connection|server closed the connection/i.test(
      message,
    )
  ) {
    return "connection-lost";
  }
  const code = (error as { code?: unknown }).code;
  if (
    typeof code === "string" &&
    // Socket-level (Node) and connection-level (Postgres class 08, plus the
    // 57P0x "your backend is going away" family).
    [
      "ECONNRESET",
      "EPIPE",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ENOTCONN",
      "08000",
      "08003",
      "08006",
      "08P01",
      "57P01",
      "57P02",
      "57P03",
    ].includes(code)
  ) {
    return "connection-lost";
  }
  return null;
}

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
        poisonClient(target, "breaker-rejected-mid-transaction");
      }
      return Promise.reject(new DatabaseUnavailableError());
    }
    const result = original(...args);
    // Not tracked at all when the call used pg's callback overload instead
    // of the promise one (see `isThenable`'s comment) — nothing in this
    // codebase does that, and a call this guard cannot sequence is a call
    // it cannot safely track transaction state for anyway.
    if (kind === "begin" && isThenable(result)) {
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
    if (kind === "end" && isThenable(result)) {
      return result.then(
        (value) => {
          openTransactionClients.delete(target);
          return value;
        },
        (error: unknown) => {
          // The transaction's fate is now unknown — Postgres refused or
          // never heard the statement meant to resolve it one way or the
          // other. Never hand this connection back out as if it were clean.
          poisonClient(target, "transaction-end-failed");
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
    const reason = poisonedClients.get(client);
    if (reason !== undefined) {
      poisonedClients.delete(client);
      openTransactionClients.delete(client);
      // One line per destroyed connection. Bounded by `PG_POOL_MAX` per
      // outage burst, and during an incident it is the difference between
      // "the pool is churning" and knowing which of the three causes is
      // doing it. `db.pool.clientDestroyed` belongs at zero.
      logEvent("db.pool.clientDestroyed", { reason });
      originalRelease(
        err instanceof Error
          ? err
          : new Error(
              `This client is not safe to reuse (${reason}); destroying it instead of returning a possibly-dirty connection to the pool.`,
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

/**
 * How long a statement issued through the main pool may take before this
 * process stops waiting for it.
 *
 * WHY THIS EXISTS, in numbers. A reconnect storm on staging on 2026-09-17 (800
 * voice seats dropping and rejoining at once) left both API processes at
 * `total: 22 / idle: 0 / busy: 22 / waiting: 15`, `pressure: "saturated"`, the
 * circuit breaker open, for many minutes, with two sockets still connected,
 * while `pg_stat_activity` showed all 45 API backends `idle` in `ClientRead`,
 * some for over 250 seconds, the oldest backend 756 seconds old. Postgres had
 * finished every one of those queries. The replies never arrived (staging talks
 * to its database through Fly's flycast proxy, which evidently dropped TCP
 * streams under the burst), and this pool had `connectionTimeoutMillis` and
 * `idleTimeoutMillis` and nothing at all that bounded *waiting for a reply*. A
 * query whose answer is lost therefore pinned a pool slot forever: the pool
 * exhausted, the breaker opened on the timeouts, and nothing recovered without
 * a restart.
 *
 * Production talks to a Vultr managed Postgres directly, so the trigger is
 * probably staging-specific. The failure mode is not: any lost reply, from any
 * cause, does this.
 *
 * FIFTEEN SECONDS is far longer than any request-path query in this codebase
 * (the slowest measured ones are tens of milliseconds) and short enough that a
 * pool of 70 cannot be emptied for long by queries that will never answer.
 * `0` disables the bound entirely, which is the rollback switch.
 */
export const DEFAULT_PG_QUERY_TIMEOUT_MS = 15_000;

/**
 * The same bound on `pqp-worker`, which is a different workload: every job in
 * `jobs.ts` runs there (`docs/plans/COLD_PATHS.md`), and while each of them is
 * written to claim bounded work (retention deletes 500 rows per statement,
 * the sweeps filter on `expires_at` and `SKIP LOCKED`), a first sweep against
 * a long backlog, or a bucket listing against a cold table, can legitimately
 * take much longer than a request ever may. Two minutes is generous for all of
 * them and still finite, which is the only property that matters here.
 */
export const DEFAULT_PG_WORKER_QUERY_TIMEOUT_MS = 120_000;

/**
 * Postgres's own `statement_timeout` is set this far BELOW the client-side
 * `query_timeout`, deliberately.
 *
 * The two bound different failures and only one of them is clean. A statement
 * that is genuinely slow should be cancelled by Postgres: the server sends an
 * ErrorResponse and a ReadyForQuery, the caller gets a real `57014 canceling
 * statement due to statement timeout`, and the connection is immediately
 * reusable. `query_timeout` is this process giving up on a socket it can no
 * longer trust: pg has no query cancellation this version can use, so the
 * statement may still be running server-side and the connection's state is
 * unknown afterwards. Giving Postgres a one-second head start means the
 * ordinary case takes the clean door and `query_timeout` fires only for the
 * failure it was added for: a reply that is never coming.
 */
const STATEMENT_TIMEOUT_HEAD_START_MS = 1_000;

/**
 * TCP keepalive on every pooled connection, so the kernel notices a peer that
 * stopped answering instead of leaving a socket open forever.
 *
 * Ten seconds of idle before the first probe. This is a backstop, not the fix:
 * the probe interval and retry count are the operating system's (on Linux,
 * nine probes 75 s apart), so a dead peer is detected in minutes, not seconds.
 * `query_timeout` above is what bounds the damage; this is what eventually
 * cleans up the socket underneath it.
 */
const PG_KEEPALIVE_INITIAL_DELAY_MS = 10_000;

/**
 * `PG_QUERY_TIMEOUT_MS`, or `PG_WORKER_QUERY_TIMEOUT_MS` on the batch worker.
 *
 * The worker reads its own variable first and falls back to the shared one
 * before its own default, so a deployment that sets one value across every
 * process still gets what it asked for, and one that sets neither gets the two
 * different defaults above. `0` means "no bound", for a rollback. An
 * unparseable value logs and uses the default: the failure mode of a typo must
 * never be an unbounded pool.
 */
export function resolvePgQueryTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const isWorker = processRole(env) === "worker";
  const fallback = isWorker
    ? DEFAULT_PG_WORKER_QUERY_TIMEOUT_MS
    : DEFAULT_PG_QUERY_TIMEOUT_MS;
  const raw = isWorker
    ? (env.PG_WORKER_QUERY_TIMEOUT_MS ?? env.PG_QUERY_TIMEOUT_MS)
    : env.PG_QUERY_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `[db] unusable query timeout ${JSON.stringify(raw)}; using ${fallback}ms.`,
    );
    return fallback;
  }
  return Math.floor(parsed);
}

/**
 * The timeouts a `pg.Pool` is created with, or `{}` when they are disabled.
 * Separate from `getPool` so a test can assert the shape without a database.
 */
export function pgTimeoutConfig(
  env: NodeJS.ProcessEnv = process.env,
): { statement_timeout?: number; query_timeout?: number } {
  const timeout = resolvePgQueryTimeoutMs(env);
  if (timeout <= 0) {
    return {};
  }
  return {
    statement_timeout: timeout,
    query_timeout: timeout + STATEMENT_TIMEOUT_HEAD_START_MS,
  };
}

/**
 * Watches every query a checked-out client runs, for two things.
 *
 *  1. The statement text, so `db.pool.stuckClient` can say WHICH query is
 *     sitting on a pool slot rather than only that one is.
 *  2. Whether the query ended in a way that makes this connection unsafe to
 *     reuse (`isPoisoningQueryError`), in which case the client is poisoned
 *     and `guardClientRelease` destroys it however cleanly its borrower
 *     releases it.
 *
 * THE SECOND ONE IS THE POINT, and a first version of this change shipped
 * without it. `query_timeout` rejecting a promise does not cancel the
 * statement and does not make the `PoolClient` unusable in pg's eyes. On the
 * `pool.query()` path that is survivable by accident, because pg-pool calls
 * `client.release(err)` itself on any error and a truthy `err` makes it
 * destroy the client. The EXPLICIT checkout path has no such accident: every
 * transaction in `server/src/services/*.ts` does `getPool().connect()` and
 * `finally { client.release() }` with no argument, because the caller has no
 * way to know the connection is compromised. pg-pool then puts a client that
 * is still waiting on a response that will never come back into the idle list
 * and hands it to the next request, which queues behind that missing response
 * and times out too. That is the staging failure reproducing itself through
 * the very pool this change was meant to protect, and it is the path that
 * stranded the pool on 2026-09-17.
 *
 * Installed from the pool's own `acquire` event rather than from
 * `guardedConnect`, and this is the part that is easy to get wrong.
 * `pool.query()` reaches its client through pg-pool's *callback* form of
 * `connect()`, which resolves `guardedConnect`'s own `await` to `undefined`
 * (the client goes to the callback instead), so wrapping done there covers
 * `getPool().connect()` and misses every single-statement query in the
 * codebase, which is most of them. `acquire` fires for both paths, before
 * either one hands the client to its caller.
 *
 * Idempotent per client object for exactly the reason `guardQueryMethod` is:
 * pg-pool hands the same `PoolClient` back out on every checkout, so a wrapper
 * installed per checkout would nest one layer deeper each time, forever.
 */
const observedClients = new WeakSet<object>();

function observeClientQueries(client: object): void {
  const target = client as { query?: (...args: unknown[]) => unknown };
  if (typeof target.query !== "function" || observedClients.has(client)) {
    return;
  }
  observedClients.add(client);
  const original = target.query.bind(target) as (...args: unknown[]) => unknown;
  target.query = (...args: unknown[]) => {
    noteCheckoutQuery(client, queryTextOf(args));
    const result = original(...args);
    // pg's callback overload returns a `Query`, not a promise, and `pool.query`
    // uses exactly that form. Nothing to observe there, and nothing that needs
    // observing: pg-pool passes the error to `release` itself on that path.
    if (!isThenable(result)) {
      return result;
    }
    return result.then(undefined, (error: unknown) => {
      const reason = isPoisoningQueryError(error);
      if (reason) {
        poisonClient(client, reason);
      }
      // Rethrown unchanged: the caller's own error handling is none of this
      // wrapper's business, and it must see the same error it always saw.
      throw error;
    });
  };
}

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is required");
    }
    const max = Number(process.env.PG_POOL_MAX ?? 10);
    // Resolved ONCE, here, and reused for the diagnostic below rather than
    // read again on every sweep: the pool's own bound is fixed at creation, so
    // a threshold that could drift away from it would describe a timeout this
    // process is not actually applying, and `processRole` logs on an
    // unrecognised `WORKER_MODE`, which, read every five seconds, would be a
    // warning per tick forever.
    const timeouts = pgTimeoutConfig();
    const created = new pg.Pool({
      connectionString,
      max,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // See the three comment blocks above: a bound on waiting for a reply,
      // Postgres's own bound a second earlier, and a kernel-level backstop for
      // a peer that has gone away entirely.
      ...timeouts,
      keepAlive: true,
      keepAliveInitialDelayMillis: PG_KEEPALIVE_INITIAL_DELAY_MS,
      ...pgSslConfig(),
    });
    pool = created;
    // `db.queries.total` / `db.queries.byRoute` (`lib/db-tx-metrics.ts`):
    // every query this pool ever runs, counted once, against whichever
    // route's `runWithRoute` (`lib/route-context.ts`) the call happens to be
    // running inside. Wrapped here rather than left to individual call
    // sites' own `countedQuery` calls (which only ever covered a handful of
    // hot paths) because "how many queries did the 2026-09-13 cache work
    // actually remove" needs the true total, not a count of the call sites
    // somebody remembered to instrument. One extra `Map.set` per query.
    //
    // Wrapped BEFORE `guardPoolQueries` below, deliberately: the breaker
    // guard has to be the OUTER layer, so a call it fast-rejects never
    // reaches this counter. `db.queries.total` promises "every Postgres
    // round trip this process has run since boot" — a call the breaker
    // turned away never became one, and counting it anyway would make the
    // 2026-09-13 cache-work delta this metric exists to prove look smaller
    // than it really is on exactly the days the breaker is doing its job.
    const rawQuery = created.query.bind(created) as (
      ...args: unknown[]
    ) => unknown;
    created.query = ((...args: unknown[]) => {
      noteDbQuery(currentRoute());
      return rawQuery(...args);
    }) as typeof created.query;
    // A3.1: fail fast on every query while the breaker is open, rather than
    // let each caller discover a dead database by queueing on this pool.
    // Wrapping AFTER the metrics assignment above so this becomes the
    // OUTERMOST layer around `created.query` — see the comment there.
    guardPoolQueries(created);
    // Idle-client errors (Postgres restart, network blip) are emitted on the
    // pool; without a listener they crash the process.
    created.on("error", (error) => {
      console.error("[db] idle client error:", error);
    });

    // Checkout ages, for `runtime.pool.longestCheckoutMs` /
    // `checkedOutOver10s` and for `db.pool.stuckClient`. See
    // `lib/pool-checkouts.ts` for what these answer that `busy` cannot.
    //
    // Three listeners, because a checkout ends in three ways and all of them
    // have to delete the entry: an ordinary `release`, and a `remove` for a
    // client pg-pool destroys (`release(err)`, `maxUses`, the idle timeout,
    // `end()`). `acquire` fires inside `_acquireClient` BEFORE the client
    // reaches either `pool.query`'s internal callback or `connect()`'s
    // promise, which is why `observeClientQueries` goes on here too.
    created.on("acquire", (client) => {
      noteCheckout(client);
      observeClientQueries(client);
    });
    created.on("release", (_err, client) => noteRelease(client));
    created.on("remove", (client) => noteRelease(client));
    registerPoolCheckoutStats(() => poolCheckoutStats());
    // When the timeout is disabled the diagnostic keeps the default
    // threshold: a rollback switch that removes the bound should not also
    // remove the warning that it is needed.
    const stuckThresholdMs =
      timeouts.statement_timeout ?? DEFAULT_PG_QUERY_TIMEOUT_MS;
    startStuckCheckoutSweeper(() => stuckThresholdMs);

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
  stopStuckCheckoutSweeper();
  await current?.end().catch(() => {});
  await closeDbBreakerProbe();
}

/**
 * Boot DDL is the one thing in this process that may legitimately take
 * minutes, and it runs before the server listens.
 *
 * `CREATE UNIQUE INDEX CONCURRENTLY` on `messages` (below) is unbounded by
 * construction: it scans the whole table twice, and how long that takes is a
 * property of how much history the instance has, not of anything this code
 * controls. `schema.sql` is the same shape: a long DDL blob whose cost grows
 * with the data. Applying the request-path `statement_timeout` to either would
 * mean a deploy that fails to boot on exactly the busiest instance, which is
 * the worst possible place to learn it, so both run on a connection with the
 * bound lifted.
 *
 * Both halves of the bound have to be lifted and they lift differently.
 * `statement_timeout` is a session setting, so `SET` clears it for this
 * connection; `query_timeout` is a client-side timer pg reads per query, so it
 * is overridden per statement (`0` there is falsy and would fall back to the
 * pool's value), hence a large number rather than none, which is also a better
 * answer than "wait forever" if boot really is wedged.
 *
 * The connection is ALWAYS destroyed rather than released, success or failure:
 * a session-level `SET` must never ride back into the pool on a reused client
 * and quietly un-bound an ordinary request an hour later.
 */
const BOOT_DDL_QUERY_TIMEOUT_MS = 30 * 60_000;

async function withBootDdlClient<T>(
  run: (
    query: (text: string, params?: unknown[]) => Promise<pg.QueryResult>,
  ) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  const query = (text: string, params?: unknown[]) =>
    client.query({
      text,
      values: params,
      query_timeout: BOOT_DDL_QUERY_TIMEOUT_MS,
    } as pg.QueryConfig) as Promise<pg.QueryResult>;
  try {
    await query("SET statement_timeout = 0");
    return await run(query);
  } finally {
    client.release(
      new Error(
        "boot DDL connection: statement_timeout was lifted on it, so it is destroyed rather than returned to the pool.",
      ),
    );
  }
}

export async function initDb(): Promise<void> {
  const schema = readFileSync(join(__dirname, "schema.sql"), "utf8");
  await withBootDdlClient(async (query) => {
    await query(schema);
    await ensureConcurrentIndexes(query);
  });
}

/**
 * Indexes that must not be built inside schema.sql's transaction.
 *
 * A regular CREATE INDEX takes a lock that blocks writes to the table for
 * the length of the build, and `messages` is the one table with real
 * history behind it. CONCURRENTLY builds without that lock but cannot run
 * inside a transaction block, so it runs here, one statement per query
 * (autocommit), still before the server starts listening.
 *
 * A build that was interrupted leaves an INVALID index behind, which
 * `IF NOT EXISTS` would happily keep; it is dropped and rebuilt instead.
 */
const CONCURRENT_INDEXES: ReadonlyArray<{ name: string; definition: string }> = [
  {
    // Idempotent sends: see the `messages.nonce` comment in schema.sql.
    name: "idx_messages_nonce",
    definition:
      "ON messages (channel_id, author_id, nonce) WHERE nonce IS NOT NULL",
  },
];

async function ensureConcurrentIndexes(
  query: (text: string, params?: unknown[]) => Promise<pg.QueryResult>,
): Promise<void> {
  for (const index of CONCURRENT_INDEXES) {
    const state = (await query(
      `SELECT i.indisvalid FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = $1`,
      [index.name],
    )) as pg.QueryResult<{ indisvalid: boolean }>;
    const row = state.rows[0];
    if (row?.indisvalid) {
      continue;
    }
    if (row) {
      await query(`DROP INDEX CONCURRENTLY IF EXISTS ${index.name}`);
    }
    await query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${index.name} ${index.definition}`,
    );
  }
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
  community_tagline?: string | null;
  community_about?: string | null;
  community_links?: unknown;
  community_slug?: string | null;
  community_featured_url?: string | null;
  community_featured_key?: string | null;
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
