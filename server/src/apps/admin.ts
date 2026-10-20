import type { PoolClient } from "pg";
import { z } from "zod";
import { getPool } from "../db.js";
import { HttpError } from "../lib/http.js";
import { isEnabled } from "../lib/flags.js";
import { logEvent } from "../lib/log.js";
import { publishAppsChanged } from "./changed.js";
import { endSessionRow } from "./sessions.js";

/**
 * THE OPERATOR'S SIDE OF THE APPS CATALOG (PLAN D2, D10, Phase 5): the reads
 * and writes behind the dashboard's Apps tab and `ADMIN_MACHINE_ROUTES`.
 *
 * What an operator can move, and what each move is allowed to do:
 *
 *  - `apps.status` / `apps.global_enabled`: an app can only be `live` or
 *    globally on while its CURRENT version has been reviewed and approved.
 *    That is checked against the version the app would end up on, so moving
 *    `current_version` to an unreviewed version of a live app is refused the
 *    same way. The refusal is a 409 `not-reviewed` and the dashboard shows it
 *    as the reason under a switch that was never enabled (mock 05 state 3).
 *  - `apps.community_unlocked`: the explicit safety decision for one app.
 *  - `server_apps.operator_enabled`: per server, true / false / null (null is
 *    "not decided", which is off). A public community needs the app's
 *    `community_unlocked` first (409 `community-locked`).
 *  - a version's review record.
 *
 * EVERY WRITE IS AUDITED IN THE SAME TRANSACTION (`app_admin_audit`: who, what,
 * before and after), one row per field that actually changed, none for a write
 * that changed nothing. After the commit a hint goes out on the cluster bus so
 * a sibling process drops any availability it cached (`./changed.ts`).
 *
 * "A LOCKED COMMUNITY" is `servers.is_community`, the public address. A listed
 * community always has one (a CHECK in the schema), so this covers both, and
 * it is the stricter of the two readings of D10's "listed community": a server
 * anybody with a link can join is a community for the purposes of the legal
 * category (docs/CONTENT_SAFETY.md), listed or not.
 */

export type AppAdminActor =
  | { kind: "dashboard" }
  | { kind: "moderator"; userId: string }
  | { kind: "owner"; userId: string };

export const APP_STATUSES = ["draft", "review", "live", "retired"] as const;
export const APP_REVIEW_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "withdrawn",
] as const;

const APP_ID = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const appIdSchema = z.string().regex(APP_ID);
const versionSchema = z.string().min(5).max(64);

export const setAppSchema = z
  .object({
    appId: appIdSchema,
    status: z.enum(APP_STATUSES).optional(),
    globalEnabled: z.boolean().optional(),
    communityUnlocked: z.boolean().optional(),
    currentVersion: versionSchema.optional(),
  })
  .refine(
    (body) =>
      body.status !== undefined ||
      body.globalEnabled !== undefined ||
      body.communityUnlocked !== undefined ||
      body.currentVersion !== undefined,
    { message: "Nothing to change" },
  );

/** The review checklist. `romPolicy` is only asked of an emulator app. */
export const reviewChecklistSchema = z.object({
  sandbox: z.boolean(),
  noNetwork: z.boolean(),
  license: z.boolean(),
  romPolicy: z.boolean().optional(),
  i18n: z.boolean(),
  presence: z.boolean(),
});
export type ReviewChecklist = z.infer<typeof reviewChecklistSchema>;

export const reviewAppVersionSchema = z.object({
  appId: appIdSchema,
  version: versionSchema,
  reviewStatus: z.enum(APP_REVIEW_STATUSES),
  checklist: reviewChecklistSchema,
  note: z.string().trim().max(2000).nullable().optional(),
});

export const setServerAppSchema = z.object({
  serverId: z.string().uuid(),
  appId: appIdSchema,
  /** `null` is "not decided", which is off. */
  operatorEnabled: z.boolean().nullable(),
});

export const APP_SERVERS_LIMIT = 25;

export interface AppServersQuery {
  appId: string;
  q: string;
  onlyOn: boolean;
  limit: number;
  offset: number;
}

/** `?appId=&q=&on=&limit=&offset=` into a query, throwing 400 on a bad id. */
export function appServersQuery(params: URLSearchParams): AppServersQuery {
  const appId = appIdSchema.safeParse(params.get("appId") ?? "");
  if (!appId.success) {
    throw new HttpError(400, "appId is required");
  }
  const on = (params.get("on") ?? "").toLowerCase();
  const limit = Number(params.get("limit"));
  const offset = Number(params.get("offset"));
  return {
    appId: appId.data,
    q: (params.get("q") ?? "").trim().slice(0, 80),
    onlyOn: on === "1" || on === "true",
    limit:
      Number.isInteger(limit) && limit >= 1
        ? Math.min(limit, 100)
        : APP_SERVERS_LIMIT,
    offset: Number.isInteger(offset) && offset >= 0 ? Math.min(offset, 100_000) : 0,
  };
}

// --------------------------------------------------------------------- views

export interface ManifestSummary {
  /** The pt-BR string the manifest's `name` key points at, or the app id. */
  name: string;
  description: string | null;
  category: string | null;
  icon: string | null;
  platformApi: number | null;
  channelTypes: string[];
  players: unknown;
  requires: unknown;
  capabilities: unknown;
  content: unknown;
  sandbox: unknown;
  license: string | null;
  publisher: string | null;
}

export interface AppVersionView {
  version: string;
  source: string;
  isCurrent: boolean;
  reviewStatus: string;
  reviewChecklist: Record<string, unknown>;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
  manifest: ManifestSummary;
}

export interface AppAdminView {
  id: string;
  name: string;
  publisher: { id: string; displayName: string; kind: string };
  status: string;
  globalEnabled: boolean;
  communityUnlocked: boolean;
  currentVersion: string | null;
  /** Whether the CURRENT version is approved: what going live asks for. */
  currentApproved: boolean;
  /** Why the live and global switches cannot be turned on, or null. */
  goLiveBlocker: "not-reviewed" | null;
  category: string | null;
  /** Servers where the operator switch is on. */
  serversOn: number;
  /** Of those, how many the owner switched off again. */
  serversOwnerOff: number;
  liveSessions: number;
  versions: AppVersionView[];
  createdAt: string;
  updatedAt: string;
}

export interface AppAuditView {
  id: string;
  actorKind: string;
  actorUserId: string | null;
  action: string;
  appId: string;
  appVersion: string | null;
  serverId: string | null;
  serverName: string | null;
  before: unknown;
  after: unknown;
  sessionsEnded: number;
  at: string;
}

export interface AppAdminList {
  apps: AppAdminView[];
  /** Every server on this instance: the M of "N de M servidores". */
  serverCount: number;
  liveSessions: number;
  audit: AppAuditView[];
}

interface ManifestLike {
  name?: unknown;
  description?: unknown;
  category?: unknown;
  icon?: unknown;
  platformApi?: unknown;
  channelTypes?: unknown;
  players?: unknown;
  requires?: unknown;
  capabilities?: unknown;
  content?: unknown;
  sandbox?: unknown;
  license?: { spdx?: unknown } | null;
  publisher?: unknown;
  i18n?: Record<string, Record<string, unknown> | undefined>;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Looks a key up in the pt-BR strings without letting `constructor` through. */
function ptString(manifest: ManifestLike, key: unknown): string | null {
  const strings = manifest.i18n?.["pt-BR"];
  if (typeof key !== "string" || !strings || !Object.hasOwn(strings, key)) {
    return null;
  }
  return str(strings[key]);
}

/**
 * The manifest is validated before it is stored, so this only has to survive a
 * row written by hand: every read is defensive and nothing here throws.
 */
export function summarizeManifest(raw: unknown, fallbackName: string): ManifestSummary {
  const manifest: ManifestLike =
    raw && typeof raw === "object" ? (raw as ManifestLike) : {};
  return {
    name: ptString(manifest, manifest.name) ?? fallbackName,
    description: ptString(manifest, manifest.description),
    category: str(manifest.category),
    icon: str(manifest.icon),
    platformApi: typeof manifest.platformApi === "number" ? manifest.platformApi : null,
    channelTypes: Array.isArray(manifest.channelTypes)
      ? manifest.channelTypes.filter((t): t is string => typeof t === "string")
      : [],
    players: manifest.players ?? null,
    requires: manifest.requires ?? null,
    capabilities: manifest.capabilities ?? null,
    content: manifest.content ?? null,
    sandbox: manifest.sandbox ?? null,
    license: str(manifest.license?.spdx),
    publisher: str(manifest.publisher),
  };
}

interface Queryable {
  query: PoolClient["query"];
}

async function loadApps(db: Queryable, onlyId?: string): Promise<AppAdminView[]> {
  const filter = onlyId ? `WHERE a.id = $1` : "";
  const params = onlyId ? [onlyId] : [];
  const [apps, versions, on, sessions] = await Promise.all([
    db.query(
      `SELECT a.id, a.status, a.global_enabled, a.community_unlocked,
              a.current_version, a.created_at, a.updated_at,
              p.id AS publisher_id, p.display_name AS publisher_name, p.kind AS publisher_kind
         FROM apps a JOIN app_publishers p ON p.id = a.publisher_id
         ${filter}
        ORDER BY a.created_at ASC, a.id ASC`,
      params,
    ),
    db.query(
      `SELECT v.app_id, v.version, v.source, v.manifest, v.review_status,
              v.review_checklist, v.reviewed_by, v.reviewed_at, v.review_note,
              v.created_at
         FROM app_versions v
         ${onlyId ? `WHERE v.app_id = $1` : ""}
        ORDER BY v.created_at DESC, v.version DESC`,
      params,
    ),
    db.query(
      `SELECT sa.app_id,
              COUNT(*)::int AS servers_on,
              COUNT(*) FILTER (WHERE sa.owner_enabled = FALSE)::int AS owner_off
         FROM server_apps sa
        WHERE sa.operator_enabled IS TRUE
          ${onlyId ? `AND sa.app_id = $1` : ""}
        GROUP BY sa.app_id`,
      params,
    ),
    db.query(
      `SELECT app_id, COUNT(*)::int AS n FROM app_sessions
        WHERE status = 'live' ${onlyId ? `AND app_id = $1` : ""}
        GROUP BY app_id`,
      params,
    ),
  ]);

  const versionsByApp = new Map<string, AppVersionView[]>();
  const approvedCurrent = new Set<string>();
  const currentOf = new Map<string, string | null>(
    apps.rows.map((row: { id: string; current_version: string | null }) => [
      row.id,
      row.current_version,
    ]),
  );
  for (const row of versions.rows as Array<Record<string, unknown>>) {
    const appId = row.app_id as string;
    const isCurrent = currentOf.get(appId) === row.version;
    if (isCurrent && row.review_status === "approved") {
      approvedCurrent.add(appId);
    }
    const list = versionsByApp.get(appId) ?? [];
    list.push({
      version: row.version as string,
      source: row.source as string,
      isCurrent,
      reviewStatus: row.review_status as string,
      reviewChecklist: (row.review_checklist ?? {}) as Record<string, unknown>,
      reviewedBy: (row.reviewed_by as string | null) ?? null,
      reviewedAt: row.reviewed_at ? new Date(row.reviewed_at as string).toISOString() : null,
      reviewNote: (row.review_note as string | null) ?? null,
      createdAt: new Date(row.created_at as string).toISOString(),
      manifest: summarizeManifest(row.manifest, appId),
    });
    versionsByApp.set(appId, list);
  }
  const onByApp = new Map<string, { on: number; ownerOff: number }>(
    on.rows.map((row: { app_id: string; servers_on: number; owner_off: number }) => [
      row.app_id,
      { on: row.servers_on, ownerOff: row.owner_off },
    ]),
  );
  const sessionsByApp = new Map<string, number>(
    sessions.rows.map((row: { app_id: string; n: number }) => [row.app_id, row.n]),
  );

  return apps.rows.map((row: Record<string, unknown>) => {
    const id = row.id as string;
    const list = versionsByApp.get(id) ?? [];
    const current = list.find((v) => v.isCurrent) ?? list[0];
    const approved = approvedCurrent.has(id);
    return {
      id,
      name: current?.manifest.name ?? id,
      publisher: {
        id: row.publisher_id as string,
        displayName: row.publisher_name as string,
        kind: row.publisher_kind as string,
      },
      status: row.status as string,
      globalEnabled: row.global_enabled as boolean,
      communityUnlocked: row.community_unlocked as boolean,
      currentVersion: (row.current_version as string | null) ?? null,
      currentApproved: approved,
      goLiveBlocker: approved ? null : "not-reviewed",
      category: current?.manifest.category ?? null,
      serversOn: onByApp.get(id)?.on ?? 0,
      serversOwnerOff: onByApp.get(id)?.ownerOff ?? 0,
      liveSessions: sessionsByApp.get(id) ?? 0,
      versions: list,
      createdAt: new Date(row.created_at as string).toISOString(),
      updatedAt: new Date(row.updated_at as string).toISOString(),
    } satisfies AppAdminView;
  });
}

async function loadAudit(db: Queryable, limit = 20): Promise<AppAuditView[]> {
  const { rows } = await db.query(
    `SELECT t.id::text, t.actor_kind, t.actor_user_id, t.action, t.app_id,
            t.app_version, t.server_id, s.name AS server_name, t.before, t.after,
            t.sessions_ended, t.at
       FROM app_admin_audit t
       LEFT JOIN servers s ON s.id = t.server_id
      ORDER BY t.id DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((row: Record<string, unknown>) => ({
    id: row.id as string,
    actorKind: row.actor_kind as string,
    actorUserId: (row.actor_user_id as string | null) ?? null,
    action: row.action as string,
    appId: row.app_id as string,
    appVersion: (row.app_version as string | null) ?? null,
    serverId: (row.server_id as string | null) ?? null,
    serverName: (row.server_name as string | null) ?? null,
    before: row.before ?? null,
    after: row.after ?? null,
    sessionsEnded: row.sessions_ended as number,
    at: new Date(row.at as string).toISOString(),
  }));
}

/** `GET /api/admin/apps`. */
export async function listAppsForOperator(): Promise<AppAdminList> {
  const pool = getPool();
  const [apps, servers, audit] = await Promise.all([
    loadApps(pool),
    pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM servers`),
    loadAudit(pool),
  ]);
  return {
    apps,
    serverCount: Number(servers.rows[0]?.n ?? 0),
    liveSessions: apps.reduce((sum, app) => sum + app.liveSessions, 0),
    audit,
  };
}

export interface AppServerRow {
  id: string;
  name: string;
  memberCount: number;
  isCommunity: boolean;
  isCommunityListed: boolean;
  /** What the operator decided for this app here: true, false or null. */
  operatorEnabled: boolean | null;
  /** The owner's switch: only ever false (off) or null. */
  ownerEnabled: boolean | null;
  /** The operator cannot switch it on: a public community, app not unlocked. */
  locked: boolean;
  /** The `apps` flag for this server, since nothing shows without it. */
  appsFlag: boolean;
  liveSessions: number;
}

export interface AppServersList {
  appId: string;
  servers: AppServerRow[];
  matched: number;
  /** Servers with the operator switch on, whatever the search says. */
  enabledCount: number;
  limit: number;
  offset: number;
  communityUnlocked: boolean;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `GET /api/admin/app-servers`. */
export async function listAppServersForOperator(
  query: AppServersQuery,
): Promise<AppServersList> {
  const pool = getPool();
  const app = await pool.query<{ community_unlocked: boolean }>(
    `SELECT community_unlocked FROM apps WHERE id = $1`,
    [query.appId],
  );
  if (app.rowCount === 0) {
    throw new HttpError(404, "App not found");
  }

  const where: string[] = [];
  const params: unknown[] = [query.appId];
  if (query.q) {
    if (UUID_TEXT.test(query.q)) {
      params.push(query.q.toLowerCase());
      where.push(`s.id = $${params.length}::uuid`);
    } else {
      params.push(`%${escapeLike(query.q)}%`);
      where.push(`s.name ILIKE $${params.length}`);
    }
  }
  if (query.onlyOn) {
    where.push(`sa.operator_enabled IS TRUE`);
  }
  const filter = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const join = `LEFT JOIN server_apps sa ON sa.server_id = s.id AND sa.app_id = $1`;

  const [rows, matched, enabled] = await Promise.all([
    pool.query(
      // THE PAGE IS PICKED FIRST, from `servers` and this app's switch alone,
      // ordered by what is on and then by name; only the rows of that page are
      // then counted (members, live sessions of this app). Ordering by size
      // would need every server's member count before a page could be cut, which
      // is work proportional to the whole instance on every request for a
      // 25-row answer.
      `WITH page AS (
         SELECT s.id, s.name, s.is_community, s.is_community_listed,
                sa.operator_enabled, sa.owner_enabled
           FROM servers s ${join}
           ${filter}
          ORDER BY (sa.operator_enabled IS TRUE) DESC, s.name ASC, s.id ASC
          LIMIT ${query.limit} OFFSET ${query.offset}
       )
       SELECT page.*,
              (SELECT COUNT(*)::int FROM server_members m WHERE m.server_id = page.id) AS member_count,
              (SELECT COUNT(*)::int FROM app_sessions x
                WHERE x.server_id = page.id AND x.app_id = $1 AND x.status = 'live') AS live_sessions
         FROM page
        ORDER BY (page.operator_enabled IS TRUE) DESC, page.name ASC, page.id ASC`,
      params,
    ),
    pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM servers s ${join} ${filter}`,
      params,
    ),
    pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM server_apps
        WHERE app_id = $1 AND operator_enabled IS TRUE`,
      [query.appId],
    ),
  ]);

  const unlocked = app.rows[0]!.community_unlocked;
  return {
    appId: query.appId,
    servers: rows.rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      name: row.name as string,
      memberCount: row.member_count as number,
      isCommunity: row.is_community as boolean,
      isCommunityListed: row.is_community_listed as boolean,
      operatorEnabled: (row.operator_enabled as boolean | null) ?? null,
      ownerEnabled: (row.owner_enabled as boolean | null) ?? null,
      locked: (row.is_community as boolean) && !unlocked,
      appsFlag: isEnabled("apps", { serverId: row.id as string }),
      liveSessions: row.live_sessions as number,
    })),
    matched: Number(matched.rows[0]?.n ?? 0),
    enabledCount: Number(enabled.rows[0]?.n ?? 0),
    limit: query.limit,
    offset: query.offset,
    communityUnlocked: unlocked,
  };
}

// -------------------------------------------------------------------- writes

export interface AuditInput {
  action:
    | "status"
    | "global"
    | "operator-server"
    | "owner-server"
    | "community-unlock"
    | "review"
    | "current-version"
    | "disable-everywhere";
  appId: string;
  appVersion?: string | null;
  serverId?: string | null;
  before: unknown;
  after: unknown;
  sessionsEnded?: number;
}

/** One `app_admin_audit` row, inside the caller's transaction. */
export async function writeAppAudit(
  client: Queryable,
  actor: AppAdminActor,
  input: AuditInput,
): Promise<string> {
  const written = await client.query<{ id: string }>(
    `INSERT INTO app_admin_audit
       (actor_kind, actor_user_id, action, app_id, app_version, server_id,
        before, after, sessions_ended)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
     RETURNING id::text`,
    [
      actor.kind,
      actorUserId(actor),
      input.action,
      input.appId,
      input.appVersion ?? null,
      input.serverId ?? null,
      JSON.stringify(input.before ?? null),
      JSON.stringify(input.after ?? null),
      input.sessionsEnded ?? 0,
    ],
  );
  return written.rows[0]!.id;
}

/** The count a write learns only after it ended the sessions, written back on its audit row. */
export async function recordSessionsEnded(auditId: string, count: number): Promise<void> {
  await getPool().query(`UPDATE app_admin_audit SET sessions_ended = $2 WHERE id = $1::bigint`, [
    auditId,
    count,
  ]);
}

/**
 * Ends every live session of an app (in one server, or everywhere) with
 * `app-disabled`, through the one place a session ends (`endSessionRow`: the
 * state cleared, `app-ended` to the people inside, the channel's card gone, on
 * every machine). It reads again until nothing is live, up to three rounds,
 * because a start that passed its availability check an instant before the
 * switch landed inserts its row just after the first read. `progress` counts
 * what ended so far, so a caller that fails half way can still record it.
 */
export async function endLiveSessions(
  appId: string,
  serverId: string | null,
  endedBy: string | null,
  progress: { ended: number },
): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    const live = await getPool().query<{ id: string }>(
      serverId === null
        ? `SELECT id FROM app_sessions WHERE app_id = $1 AND status = 'live'`
        : `SELECT id FROM app_sessions WHERE app_id = $1 AND status = 'live' AND server_id = $2`,
      serverId === null ? [appId] : [appId, serverId],
    );
    if (live.rows.length === 0) {
      return;
    }
    for (const row of live.rows) {
      const result = await endSessionRow(row.id, "app-disabled", endedBy);
      if (result.ended) {
        progress.ended += 1;
      }
    }
  }
}

/** The account behind a write, or NULL for the dashboard's token, which has none. */
export function actorUserId(actor: AppAdminActor): string | null {
  return actor.kind === "dashboard" ? null : actor.userId;
}

export async function inAppsTransaction<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export interface AppWriteResult {
  /** `null` only when the change committed and the read back after it failed. */
  app: AppAdminView | null;
  /** The audit rows this write added: 0 when nothing changed. */
  changed: number;
}

interface AppRow {
  id: string;
  status: string;
  global_enabled: boolean;
  community_unlocked: boolean;
  current_version: string | null;
}

/** Takes the row lock every write to one app starts with. */
async function lockApp(client: PoolClient, appId: string): Promise<AppRow> {
  const { rows } = await client.query<AppRow>(
    `SELECT id, status, global_enabled, community_unlocked, current_version
       FROM apps WHERE id = $1 FOR UPDATE`,
    [appId],
  );
  if (rows.length === 0) {
    throw new HttpError(404, "App not found");
  }
  return rows[0]!;
}

async function reviewStatusOf(
  client: PoolClient,
  appId: string,
  version: string | null,
): Promise<string | null> {
  if (version === null) {
    return null;
  }
  const { rows } = await client.query<{ review_status: string }>(
    `SELECT review_status FROM app_versions WHERE app_id = $1 AND version = $2`,
    [appId, version],
  );
  return rows[0]?.review_status ?? null;
}

/** `PUT /api/admin/apps`. */
export async function operatorSetApp(
  input: z.infer<typeof setAppSchema>,
  actor: AppAdminActor,
): Promise<AppWriteResult> {
  const changedRows = await inAppsTransaction(async (client) => {
    const before = await lockApp(client, input.appId);
    const next = {
      status: input.status ?? before.status,
      global_enabled: input.globalEnabled ?? before.global_enabled,
      community_unlocked: input.communityUnlocked ?? before.community_unlocked,
      current_version: input.currentVersion ?? before.current_version,
    };

    if (input.currentVersion !== undefined) {
      const known = await reviewStatusOf(client, input.appId, input.currentVersion);
      if (known === null) {
        throw new HttpError(404, "Version not found");
      }
    }

    // Going live, or on for everybody, is allowed only on an approved version,
    // and the version that counts is the one the app would END UP on.
    const standsOnVersion = next.status === "live" || next.global_enabled;
    const movesIt =
      next.status !== before.status ||
      next.global_enabled !== before.global_enabled ||
      next.current_version !== before.current_version;
    if (standsOnVersion && movesIt) {
      const review = await reviewStatusOf(client, input.appId, next.current_version);
      if (review !== "approved") {
        throw new HttpError(409, "not-reviewed");
      }
    }

    const audits: AuditInput[] = [];
    if (next.status !== before.status) {
      audits.push({
        action: "status",
        appId: input.appId,
        before: { status: before.status },
        after: { status: next.status },
      });
    }
    if (next.global_enabled !== before.global_enabled) {
      audits.push({
        action: "global",
        appId: input.appId,
        before: { globalEnabled: before.global_enabled },
        after: { globalEnabled: next.global_enabled },
      });
    }
    if (next.community_unlocked !== before.community_unlocked) {
      audits.push({
        action: "community-unlock",
        appId: input.appId,
        before: { communityUnlocked: before.community_unlocked },
        after: { communityUnlocked: next.community_unlocked },
      });
    }
    if (next.current_version !== before.current_version) {
      audits.push({
        action: "current-version",
        appId: input.appId,
        appVersion: next.current_version,
        before: { currentVersion: before.current_version },
        after: { currentVersion: next.current_version },
      });
    }
    if (audits.length > 0) {
      await client.query(
        `UPDATE apps
            SET status = $2, global_enabled = $3, community_unlocked = $4,
                current_version = $5, updated_at = NOW()
          WHERE id = $1`,
        [
          input.appId,
          next.status,
          next.global_enabled,
          next.community_unlocked,
          next.current_version,
        ],
      );
      for (const audit of audits) {
        await writeAppAudit(client, actor, audit);
      }
    }
    return audits.length;
  });

  if (changedRows > 0) {
    logEvent("apps.admin.set", { appId: input.appId, actor: actor.kind, changed: changedRows });
    publishAppsChanged({ appId: input.appId, serverId: null });
  }
  return { app: await loadOne(input.appId), changed: changedRows };
}

/** What an approval asks of the checklist: every line, the ROM line only for an emulator. */
function checklistGaps(checklist: ReviewChecklist, category: string | null): string[] {
  const gaps: string[] = [];
  for (const key of ["sandbox", "noNetwork", "license", "i18n", "presence"] as const) {
    if (checklist[key] !== true) {
      gaps.push(key);
    }
  }
  if (category === "emulator" && checklist.romPolicy !== true) {
    gaps.push("romPolicy");
  }
  return gaps;
}

/** `PUT /api/admin/app-review`. */
export async function operatorReviewAppVersion(
  input: z.infer<typeof reviewAppVersionSchema>,
  actor: AppAdminActor,
): Promise<AppWriteResult> {
  const changed = await inAppsTransaction(async (client) => {
    const app = await lockApp(client, input.appId);
    const { rows } = await client.query<{
      manifest: unknown;
      review_status: string;
      review_checklist: unknown;
      review_note: string | null;
    }>(
      `SELECT manifest, review_status, review_checklist, review_note
         FROM app_versions WHERE app_id = $1 AND version = $2 FOR UPDATE`,
      [input.appId, input.version],
    );
    const version = rows[0];
    if (!version) {
      throw new HttpError(404, "Version not found");
    }

    if (input.reviewStatus === "approved") {
      const category = summarizeManifest(version.manifest, input.appId).category;
      if (checklistGaps(input.checklist, category).length > 0) {
        throw new HttpError(409, "checklist-incomplete");
      }
    }
    // The version a live or global app stands on cannot lose its approval from
    // under it: move `currentVersion` (or switch the app off) first.
    if (
      input.reviewStatus !== "approved" &&
      app.current_version === input.version &&
      (app.status === "live" || app.global_enabled)
    ) {
      throw new HttpError(409, "version-in-use");
    }

    const note = input.note?.length ? input.note : null;
    const checklist = input.checklist;
    const same =
      version.review_status === input.reviewStatus &&
      version.review_note === note &&
      JSON.stringify(sortKeys(version.review_checklist)) ===
        JSON.stringify(sortKeys(checklist));
    if (same) {
      return 0;
    }
    await client.query(
      `UPDATE app_versions
          SET review_status = $3, review_checklist = $4::jsonb,
              review_note = $5, reviewed_by = $6, reviewed_at = NOW()
        WHERE app_id = $1 AND version = $2`,
      [
        input.appId,
        input.version,
        input.reviewStatus,
        JSON.stringify(checklist),
        note,
        actor.kind === "moderator" ? `moderator:${actor.userId}` : "dashboard",
      ],
    );
    await writeAppAudit(client, actor, {
      action: "review",
      appId: input.appId,
      appVersion: input.version,
      before: {
        reviewStatus: version.review_status,
        checklist: version.review_checklist,
        note: version.review_note,
      },
      after: { reviewStatus: input.reviewStatus, checklist, note },
    });
    return 1;
  });

  if (changed > 0) {
    logEvent("apps.admin.review", {
      appId: input.appId,
      version: input.version,
      reviewStatus: input.reviewStatus,
      actor: actor.kind,
    });
    publishAppsChanged({ appId: input.appId, serverId: null });
  }
  return { app: await loadOne(input.appId), changed };
}

function sortKeys(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
  );
}

export interface ServerAppWriteResult {
  serverId: string;
  appId: string;
  operatorEnabled: boolean | null;
  ownerEnabled: boolean | null;
  changed: boolean;
  /** Live sessions ended because the switch went from on to off. */
  sessionsEnded: number;
}

/** `PUT /api/admin/server-apps`. */
export async function operatorSetServerApp(
  input: z.infer<typeof setServerAppSchema>,
  actor: AppAdminActor,
): Promise<ServerAppWriteResult> {
  const result = await inAppsTransaction(async (client) => {
    let auditId: string | null = null;
    const app = await lockApp(client, input.appId);
    const server = await client.query<{ is_community: boolean }>(
      `SELECT is_community FROM servers WHERE id = $1`,
      [input.serverId],
    );
    if (server.rowCount === 0) {
      throw new HttpError(404, "Server not found");
    }
    if (
      input.operatorEnabled === true &&
      server.rows[0]!.is_community &&
      !app.community_unlocked
    ) {
      throw new HttpError(409, "community-locked");
    }

    const current = await client.query<{
      operator_enabled: boolean | null;
      owner_enabled: boolean | null;
    }>(
      `SELECT operator_enabled, owner_enabled FROM server_apps
        WHERE server_id = $1 AND app_id = $2 FOR UPDATE`,
      [input.serverId, input.appId],
    );
    const before = current.rows[0]?.operator_enabled ?? null;
    const owner = current.rows[0]?.owner_enabled ?? null;
    const changed = before !== input.operatorEnabled;
    if (changed) {
      await client.query(
        `INSERT INTO server_apps (server_id, app_id, operator_enabled, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (server_id, app_id) DO UPDATE
           SET operator_enabled = EXCLUDED.operator_enabled, updated_at = NOW()`,
        [input.serverId, input.appId, input.operatorEnabled],
      );
      auditId = await writeAppAudit(client, actor, {
        action: "operator-server",
        appId: input.appId,
        serverId: input.serverId,
        before: { operatorEnabled: before },
        after: { operatorEnabled: input.operatorEnabled },
      });
    }
    return { changed, owner, auditId, wasOn: before === true };
  });

  const progress = { ended: 0 };
  if (result.changed) {
    logEvent("apps.admin.server", {
      appId: input.appId,
      serverId: input.serverId,
      operatorEnabled: input.operatorEnabled,
      actor: actor.kind,
    });
    publishAppsChanged({ appId: input.appId, serverId: input.serverId });
    // Taking an app away from a server ends what is running there, the way the
    // owner's switch and "Desligar em todos" do: a session that outlives the
    // switch that allowed it is a switch that does not mean what it says.
    if (result.wasOn && input.operatorEnabled !== true) {
      try {
        await endLiveSessions(input.appId, input.serverId, actorUserId(actor), progress);
      } finally {
        if (result.auditId) {
          await recordSessionsEnded(result.auditId, progress.ended).catch(() => {});
        }
      }
    }
  }
  return {
    serverId: input.serverId,
    appId: input.appId,
    operatorEnabled: input.operatorEnabled,
    ownerEnabled: result.owner,
    changed: result.changed,
    sessionsEnded: progress.ended,
  };
}

export const disableEverywhereSchema = z.object({ appId: appIdSchema });
export const endSessionSchema = z.object({ sessionId: z.string().uuid() });

export interface DisableEverywhereResult {
  app: AppAdminView | null;
  sessionsEnded: number;
}

/**
 * `POST /api/admin/app-disable-everywhere`: the master switch off and every live
 * session of the app ended with `app-disabled`. The switch goes first, in its
 * own transaction with its audit row, so no new session can start while the
 * old ones are being ended; the audit row's `sessions_ended` is written back
 * with what really ended (even when ending stopped half way, which an operator
 * re-running it finishes: ending is idempotent). It never touches the per
 * server switches: turning the master back on brings the same servers back.
 */
export async function operatorDisableEverywhere(
  input: z.infer<typeof disableEverywhereSchema>,
  actor: AppAdminActor,
): Promise<DisableEverywhereResult> {
  const written = await inAppsTransaction(async (client) => {
    const app = await lockApp(client, input.appId);
    const on = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM server_apps WHERE app_id = $1 AND operator_enabled IS TRUE`,
      [input.appId],
    );
    if (app.global_enabled) {
      await client.query(
        `UPDATE apps SET global_enabled = FALSE, updated_at = NOW() WHERE id = $1`,
        [input.appId],
      );
    }
    const auditId = await writeAppAudit(client, actor, {
      action: "disable-everywhere",
      appId: input.appId,
      before: { globalEnabled: app.global_enabled, serversOn: on.rows[0]?.n ?? 0 },
      after: { globalEnabled: false },
    });
    return { auditId };
  });
  publishAppsChanged({ appId: input.appId, serverId: null });

  const progress = { ended: 0 };
  try {
    await endLiveSessions(input.appId, null, actorUserId(actor), progress);
  } finally {
    await recordSessionsEnded(written.auditId, progress.ended).catch(() => {});
    logEvent("apps.admin.disableEverywhere", {
      appId: input.appId,
      sessionsEnded: progress.ended,
      actor: actor.kind,
    });
  }
  return { app: await loadOne(input.appId), sessionsEnded: progress.ended };
}

export interface OperatorEndSessionResult {
  sessionId: string;
  appId: string;
  serverId: string;
  channelId: string;
  /** False when it was already over: nothing was written and nobody was told. */
  ended: boolean;
}

/**
 * `POST /api/admin/app-session-end`: the operator ends one session, reason
 * `operator`. Not behind the server's `apps` flag (an operator ends a session
 * on a server that has since turned the flag off) and idempotent. The session
 * row itself carries the record: `end_reason` and `ended_by` (the moderator's
 * id, NULL for the dashboard's token, which has no account).
 */
export async function operatorEndSession(
  input: z.infer<typeof endSessionSchema>,
  actor: AppAdminActor,
): Promise<OperatorEndSessionResult> {
  const found = await getPool().query<{ app_id: string; server_id: string; channel_id: string }>(
    `SELECT app_id, server_id, channel_id FROM app_sessions WHERE id = $1`,
    [input.sessionId],
  );
  const row = found.rows[0];
  if (!row) {
    throw new HttpError(404, "Session not found");
  }
  const result = await endSessionRow(input.sessionId, "operator", actorUserId(actor));
  if (result.ended) {
    logEvent("apps.admin.sessionEnded", { sessionId: input.sessionId, appId: row.app_id, actor: actor.kind });
  }
  return {
    sessionId: input.sessionId,
    appId: row.app_id,
    serverId: row.server_id,
    channelId: row.channel_id,
    ended: result.ended,
  };
}

/**
 * The app as it stands after a write that has already COMMITTED. A failure to
 * read it back must not turn the answer into an error: the change is durable
 * and audited, and a retry would find nothing to change, so the operator would
 * be told it failed and never learn it worked. It answers `null` instead, the
 * way a flag write falls back when its follow-up read fails, and the dashboard
 * re-reads the list anyway.
 */
async function loadOne(appId: string): Promise<AppAdminView | null> {
  try {
    const [app] = await loadApps(getPool(), appId);
    return app ?? null;
  } catch (error) {
    logEvent("apps.admin.readBackFailed", {
      appId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
