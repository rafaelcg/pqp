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

const dbBreaker: DbBreaker = createDbBreaker({
  probe: () => getPool().query("SELECT 1"),
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
 * Makes every call through `target.query` — however it was reached, `pool`
 * or `registry.ts`'s own imports, anything holding this exact instance —
 * fail fast while the breaker is open, instead of joining pg-pool's queue
 * and waiting out `connectionTimeoutMillis` one caller at a time. The
 * wrapper only intercepts; a query issued while the breaker is closed or
 * half-open is entirely unmodified, same object, same promise.
 *
 * `no-explicit-any`-clean on purpose: `pg.Pool.query` is a large overloaded
 * signature (this codebase only ever uses the promise form, `query(text,
 * params?)`, never the callback form), so the wrapper forwards through
 * `unknown` and the assignment back onto `target.query` is asserted rather
 * than structurally checked. Call sites are unaffected — `pool.query<T>(...)`
 * still type-checks against `pg.Pool`'s own declared (generic) signature,
 * because TypeScript resolves that from `pool`'s static type, not from
 * whatever function object happens to be sitting there at runtime.
 */
function guardPoolQueries(target: pg.Pool): void {
  const original = target.query.bind(target) as unknown as (
    ...args: unknown[]
  ) => Promise<unknown>;
  const guarded = (...args: unknown[]): Promise<unknown> => {
    if (isDbBreakerEnabled() && dbBreaker.isOpen()) {
      dbBreaker.noteRejected();
      return Promise.reject(new DatabaseUnavailableError());
    }
    return original(...args);
  };
  target.query = guarded as unknown as pg.Pool["query"];
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
