import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  CreateOutgoingWebhookBody,
  OutgoingMessageCreatedPayload,
  OutgoingWebhook,
  OutgoingWebhookAuthHeaderName,
  UpdateOutgoingWebhookBody,
  UserStatus,
} from "@pqp/shared";
import {
  formatUserTag,
  OUTGOING_WEBHOOK_AUTH_HEADER_NAMES,
  OUTGOING_WEBHOOK_EVENT_TYPE,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { HttpError } from "../lib/http.js";
import { processRole, runsColdJobs } from "../lib/process-role.js";
import { notifyOutgoingWebhookEnqueued } from "./outgoing-webhook-poller.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import {
  parseHttpUrl,
  resolveSafeAddress,
  safePost,
  UnsafeUrlError,
} from "../lib/safe-fetch.js";
import {
  generateSigningSecret,
  secretHint,
  signatureHeader,
} from "../lib/webhook-sign.js";

/**
 * Outgoing channel webhooks.
 *
 * CLUSTER_BUS is the wrong layer: it is ephemeral WS fan-out and dies with
 * the process. Delivery lives in Postgres (`outgoing_webhook_deliveries`) so a
 * deploy that drops every socket still retries the POST. Chat send inserts a
 * row and returns; this file's worker is what actually talks to the URL.
 */

const PREVIOUS_SECRET_TTL_MS = 24 * 60 * 60_000;
const DELIVERY_TIMEOUT_MS = 15_000;
const CLAIM_LEASE_MS = 30_000;
const DELIVERED_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_DELIVERIES_PER_TICK = 8;
const MAX_LAST_ERROR = 500;

/** Immediate, then 5s, 30s, 2m, 10m, then dead. Index is attempt_count after this try. */
const BACKOFF_AFTER_ATTEMPT_MS = [5_000, 30_000, 120_000, 600_000];

const deliveryLimiter = createRateLimiter({
  capacity: 5,
  refillPerSecond: 5,
});

const AUTH_HEADER_SET = new Set<string>(OUTGOING_WEBHOOK_AUTH_HEADER_NAMES);

export function resetOutgoingWebhookRateLimit(): void {
  deliveryLimiter.reset();
}

export function outgoingWebhookFetchOptions(): {
  allowPrivate: boolean;
  requireHttps: boolean;
} {
  const production = process.env.NODE_ENV === "production";
  return {
    requireHttps: production,
    allowPrivate:
      !production && process.env.OUTGOING_WEBHOOKS_ALLOW_PRIVATE === "true",
  };
}

/**
 * Validate at create *and* every delivery. A URL that passed last week can
 * start resolving to loopback after a DNS change; pinning without re-checking
 * would turn that into an SSRF.
 */
export async function assertOutgoingWebhookUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = parseHttpUrl(raw);
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      throw new HttpError(400, error.message);
    }
    throw error;
  }
  const { allowPrivate, requireHttps } = outgoingWebhookFetchOptions();
  if (requireHttps && url.protocol !== "https:") {
    throw new HttpError(400, "Outgoing webhooks require HTTPS");
  }
  const resolved = await resolveSafeAddress(url.hostname, { allowPrivate });
  if (!resolved) {
    throw new HttpError(
      400,
      "That URL does not resolve to a public address",
    );
  }
}

function hintOf(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return secretHint(value);
}

interface OutgoingWebhookRow {
  id: string;
  server_id: string;
  name: string;
  url: string;
  channel_ids: string[];
  skip_user_ids: string[];
  signing_secret: string;
  signing_secret_previous: string | null;
  previous_secret_expires_at: Date | null;
  auth_header_name: string | null;
  auth_header_value: string | null;
  status: "active" | "disabled" | "failing";
  last_error: string | null;
  last_delivered_at: Date | null;
  disabled_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

const HOOK_COLUMNS = `id, server_id, name, url, channel_ids, skip_user_ids, signing_secret,
  signing_secret_previous, previous_secret_expires_at, auth_header_name,
  auth_header_value, status, last_error, last_delivered_at, disabled_reason,
  created_at, updated_at`;

async function skipUsersFor(ids: string[]): Promise<
  OutgoingWebhook["skipUsers"]
> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return [];
  }
  const result = await getPool().query<{
    id: string;
    display_name: string;
    username: string | null;
    discriminator: string | null;
  }>(
    `SELECT id, display_name, username, discriminator
       FROM users WHERE id = ANY($1::uuid[])`,
    [unique],
  );
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  return unique.flatMap((id) => {
    const row = byId.get(id);
    if (!row) {
      return [];
    }
    return [
      {
        id: row.id,
        displayName: row.display_name,
        tag: formatUserTag(row.username, row.discriminator),
      },
    ];
  });
}

async function channelsFor(
  serverId: string,
  ids: string[],
): Promise<OutgoingWebhook["channels"]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return [];
  }
  const result = await getPool().query<{ id: string; name: string }>(
    `SELECT id, name FROM channels
      WHERE server_id = $1
        AND kind = 'server'
        AND type = 'text'
        AND id = ANY($2::uuid[])`,
    [serverId, unique],
  );
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  return unique.flatMap((id) => {
    const row = byId.get(id);
    return row ? [{ id: row.id, name: row.name }] : [];
  });
}

function channelsNamed(
  channels: OutgoingWebhook["channels"],
  ids: string[],
): OutgoingWebhook["channels"] {
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  return ids.flatMap((id) => {
    const channel = byId.get(id);
    return channel ? [channel] : [];
  });
}

export async function mapOutgoingWebhook(
  row: OutgoingWebhookRow,
  options: {
    includeSecret?: boolean;
    /** Already loaded for every hook in a list, so mapping does not query again. */
    channels?: OutgoingWebhook["channels"];
    /**
     * After a create or update has committed, a failed name lookup must not
     * turn that success into an error the client will retry.
     */
    bestEffortChannels?: boolean;
  } = {},
): Promise<OutgoingWebhook> {
  const skipUserIds = row.skip_user_ids ?? [];
  let channels = options.channels
    ? channelsNamed(options.channels, row.channel_ids)
    : undefined;
  if (!channels) {
    try {
      channels = await channelsFor(row.server_id, row.channel_ids);
    } catch (error) {
      if (!options.bestEffortChannels) {
        throw error;
      }
      channels = [];
    }
  }
  const mapped: OutgoingWebhook = {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    url: row.url,
    channelIds: row.channel_ids,
    channels,
    skipUserIds,
    skipUsers: await skipUsersFor(skipUserIds),
    secretHint: secretHint(row.signing_secret),
    authHeaderName: (row.auth_header_name as OutgoingWebhookAuthHeaderName | null)
      ?? null,
    authHeaderHint: hintOf(row.auth_header_value),
    status: row.status,
    lastError: row.last_error,
    lastDeliveredAt: row.last_delivered_at?.toISOString() ?? null,
    disabledReason: row.disabled_reason,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
  if (options.includeSecret) {
    mapped.signingSecret = row.signing_secret;
  }
  return mapped;
}

export type OutgoingWebhookChannelProblem = {
  id: string;
  name: string;
  type: string;
  /** `type` is not text. `server` is on this server but not a server text channel. */
  reason: "type" | "server";
};

type Sql = Pick<PoolClient, "query">;

/**
 * One bad id used to reject the whole selection with a sentence that named
 * nobody. A deleted channel has no FK out of `channel_ids`, so it stays
 * selected with no chip, and ticking `#debug` looks like `#debug` failed.
 */
export class OutgoingWebhookChannelsError extends HttpError {
  readonly code = "outgoing_webhook_channels";

  constructor(readonly channels: OutgoingWebhookChannelProblem[]) {
    super(400, channels.map(describeChannelProblem).join(" "));
    this.name = "OutgoingWebhookChannelsError";
  }
}

/**
 * A skip id added in this edit that is not a member now. Somebody ticked
 * them and they left before Save. Dropping the id quietly answered 200 for a
 * save that ignored part of what was asked, so the form closed as if it had
 * worked. Each id is listed, like a bad channel, so the form can say who.
 *
 * An id already on the hook never lands here: it is kept even after that
 * person leaves (see `validateSkipUserIds`).
 */
export class OutgoingWebhookSkipUsersError extends HttpError {
  readonly code = "outgoing_webhook_skip_users";

  constructor(readonly users: { id: string }[]) {
    super(
      400,
      users.length === 1
        ? "A skipped user is not a member of this server."
        : `${users.length} skipped users are not members of this server.`,
    );
    this.name = "OutgoingWebhookSkipUsersError";
  }
}

function describeChannelProblem(problem: OutgoingWebhookChannelProblem): string {
  const name = problem.name.replace(/^#/, "");
  if (problem.reason === "server") {
    return `#${name} is not a text channel in this server.`;
  }
  switch (problem.type) {
    case "voice":
      return `#${name} is a voice channel, not a text channel.`;
    case "thread":
      return `#${name} is a thread, not a text channel.`;
    case "category":
      return `#${name} is a category, not a text channel.`;
    case "watch_party":
      return `#${name} is a watch party channel, not a text channel.`;
    default:
      return `#${name} is not a text channel.`;
  }
}

async function validateTextChannelIds(
  serverId: string,
  channelIds: string[],
  db: Sql = getPool(),
  share = false,
): Promise<string[]> {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of channelIds) {
    const key = id.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(id);
  }
  if (unique.length === 0) {
    throw new HttpError(400, "Select at least one text channel");
  }
  // Server id is in the WHERE, not applied after the read. A manager of
  // this server must not learn the name of a channel on another server by
  // submitting its id. Those ids are dropped, the same as a deleted one.
  // FOR SHARE is only for create, which does not already hold the webhook
  // row. Update locks that row first; taking the channel lock second would
  // deadlock with delete, which deletes the channel and then updates the hook.
  const result = await db.query<{
    id: string;
    name: string;
    type: string;
    kind: string;
  }>(
    `SELECT id, name, type, kind
       FROM channels
      WHERE server_id = $1
        AND id = ANY($2::uuid[])
      ${share ? "FOR SHARE" : ""}`,
    [serverId, unique],
  );
  const byId = new Map(
    result.rows.map((row) => [row.id.toLowerCase(), row]),
  );
  const kept: string[] = [];
  const problems: OutgoingWebhookChannelProblem[] = [];
  for (const id of unique) {
    const row = byId.get(id.toLowerCase());
    if (!row) {
      continue;
    }
    if (row.kind === "server" && row.type === "text") {
      kept.push(row.id);
      continue;
    }
    problems.push({
      id,
      name: row.name,
      type: row.type,
      reason: row.type === "text" ? "server" : "type",
    });
  }
  if (problems.length > 0) {
    throw new OutgoingWebhookChannelsError(problems);
  }
  if (kept.length === 0) {
    throw new HttpError(400, "Select at least one text channel");
  }
  return kept;
}

/**
 * A deleted channel id is not a foreign key, so it would sit in
 * `channel_ids` and fail the next save. One statement: keep only ids that
 * are still server text channels on that hook's server. An id left behind
 * by an earlier delete does not count as a survivor. When nothing real
 * remains, leave the array alone (it cannot be empty) and disable the hook.
 */
export async function detachDeletedChannelsFromOutgoingWebhooks(
  client: Sql,
  channelIds: string[],
): Promise<void> {
  if (channelIds.length === 0) {
    return;
  }
  await client.query(
    `WITH locked AS (
       SELECT ow.id, ow.server_id, ow.channel_ids, ow.status
         FROM outgoing_webhooks ow
        WHERE ow.channel_ids && $1::uuid[]
        FOR UPDATE
     )
     UPDATE outgoing_webhooks AS w
        SET channel_ids = CASE
              WHEN cardinality(kept.ids) >= 1 THEN kept.ids
              ELSE w.channel_ids
            END,
            status = CASE
              WHEN cardinality(kept.ids) >= 1 THEN w.status
              ELSE 'disabled'
            END,
            disabled_reason = CASE
              WHEN cardinality(kept.ids) >= 1 THEN w.disabled_reason
              WHEN kept.status = 'disabled' THEN w.disabled_reason
              ELSE 'The last text channel was deleted'
            END,
            updated_at = NOW()
       FROM (
         SELECT locked.id,
                locked.status,
                ARRAY(
                  SELECT cid
                    FROM unnest(locked.channel_ids) WITH ORDINALITY AS u(cid, ord)
                   WHERE NOT (cid = ANY($1::uuid[]))
                     AND EXISTS (
                       SELECT 1 FROM channels c
                        WHERE c.id = cid
                          AND c.server_id = locked.server_id
                          AND c.kind = 'server'
                          AND c.type = 'text'
                     )
                   ORDER BY ord
                ) AS ids
           FROM locked
       ) AS kept
      WHERE w.id = kept.id`,
    [channelIds],
  );
}

async function validateSkipUserIds(
  serverId: string,
  userIds: string[] | undefined,
  db: Sql = getPool(),
  alreadyStored: readonly string[] = [],
): Promise<string[]> {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of userIds ?? []) {
    const key = id.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(id);
  }
  if (unique.length === 0) {
    return [];
  }
  const result = await db.query<{ user_id: string }>(
    `SELECT user_id FROM server_members
      WHERE server_id = $1 AND user_id = ANY($2::uuid[])`,
    [serverId, unique],
  );
  const members = new Map(
    result.rows.map((row) => [row.user_id.toLowerCase(), row.user_id]),
  );
  const stored = new Map(
    alreadyStored.map((id) => [id.toLowerCase(), id]),
  );
  // An id already on the hook stays, even if that person left. The next
  // edit must not forget them: if they rejoin, their messages still must
  // not fire the hook. Only a newly added id has to be a member now, and one
  // that is not is refused by name rather than dropped.
  const kept: string[] = [];
  const refused: string[] = [];
  for (const id of unique) {
    const key = id.toLowerCase();
    const keptId = members.get(key) ?? stored.get(key);
    if (keptId) {
      kept.push(keptId);
    } else {
      refused.push(id);
    }
  }
  if (refused.length > 0) {
    // Ids only, never names. An id that is not a member here could be
    // anybody's, and naming it would let a server admin look up the display
    // name of any account by probing UUIDs. The form picked these people
    // from its own member list, so it names them itself.
    throw new OutgoingWebhookSkipUsersError(refused.map((id) => ({ id })));
  }
  return kept;
}

function normalizeAuth(
  name: string | null | undefined,
  value: string | null | undefined,
): { name: string | null; value: string | null } {
  if (name == null && value == null) {
    return { name: null, value: null };
  }
  if (!name || !value) {
    throw new HttpError(400, "Auth header name and value must be set together");
  }
  if (!AUTH_HEADER_SET.has(name)) {
    throw new HttpError(400, "That auth header is not allowed");
  }
  return { name, value };
}

/**
 * Is this server currently able to wake an external bot?
 *
 * Used only to paint `is_character` members as online on the member list when
 * they have no socket. A stored "always online" flag would stay green after
 * the hook died, which is the failure mode `status.ts` exists to prevent.
 * `active` is the only healthy status; `failing` and `disabled` mean the
 * wake is not landing.
 */
export async function serverHasActiveOutgoingWebhook(
  serverId: string,
): Promise<boolean> {
  const result = await getPool().query<{ listening: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM outgoing_webhooks
        WHERE server_id = $1 AND status = 'active'
     ) AS listening`,
    [serverId],
  );
  return result.rows[0]?.listening === true;
}

/**
 * Socket status wins. A character with no socket is online only while this
 * server has an `active` outgoing hook. Humans are never rewritten.
 */
export function statusWithCharacterHook(
  status: UserStatus,
  isCharacter: boolean,
  hookListening: boolean,
): UserStatus {
  if (isCharacter && status === "offline" && hookListening) {
    return "online";
  }
  return status;
}

export async function listOutgoingWebhooks(
  serverId: string,
): Promise<OutgoingWebhook[]> {
  const result = await getPool().query<OutgoingWebhookRow>(
    `SELECT ${HOOK_COLUMNS} FROM outgoing_webhooks
      WHERE server_id = $1
      ORDER BY created_at ASC`,
    [serverId],
  );
  const channels = await channelsFor(
    serverId,
    result.rows.flatMap((row) => row.channel_ids),
  );
  return Promise.all(
    result.rows.map((row) => mapOutgoingWebhook(row, { channels })),
  );
}

export async function getOutgoingWebhookRow(
  id: string,
): Promise<OutgoingWebhookRow | null> {
  const result = await getPool().query<OutgoingWebhookRow>(
    `SELECT ${HOOK_COLUMNS} FROM outgoing_webhooks WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function createOutgoingWebhook(
  serverId: string,
  createdBy: string,
  body: CreateOutgoingWebhookBody,
): Promise<OutgoingWebhook> {
  await assertOutgoingWebhookUrl(body.url);
  const skipUserIds = await validateSkipUserIds(serverId, body.skipUserIds);
  const auth = normalizeAuth(
    body.authHeaderName ?? null,
    body.authHeaderValue ?? null,
  );
  const signingSecret = generateSigningSecret();
  const client = await getPool().connect();
  let row: OutgoingWebhookRow | undefined;
  try {
    await client.query("BEGIN");
    // Share-lock the channels so a delete cannot commit between this check
    // and the insert, then fail to see the new row in its cleanup.
    const channelIds = await validateTextChannelIds(
      serverId,
      body.channelIds,
      client,
      true,
    );
    const result = await client.query<OutgoingWebhookRow>(
      `INSERT INTO outgoing_webhooks (
         server_id, name, url, channel_ids, skip_user_ids, signing_secret,
         auth_header_name, auth_header_value, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${HOOK_COLUMNS}`,
      [
        serverId,
        body.name.trim(),
        body.url.trim(),
        channelIds,
        skipUserIds,
        signingSecret,
        auth.name,
        auth.value,
        createdBy,
      ],
    );
    await client.query("COMMIT");
    row = result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return mapOutgoingWebhook(row!, {
    includeSecret: true,
    bestEffortChannels: true,
  });
}

export async function updateOutgoingWebhook(
  id: string,
  body: UpdateOutgoingWebhookBody,
): Promise<OutgoingWebhook | null> {
  if (body.url !== undefined) {
    await assertOutgoingWebhookUrl(body.url.trim());
  }
  // Lock the hook before re-reading its channels. A delete that commits
  // first is visible here, so this write cannot put a removed id back.
  // A delete that is still in flight waits on this row, then strips the id
  // from whatever this write stored. Channel rows are not locked here:
  // delete takes those first and this row second.
  const client = await getPool().connect();
  let saved: OutgoingWebhookRow | undefined;
  try {
    await client.query("BEGIN");
    const locked = await client.query<OutgoingWebhookRow>(
      `SELECT ${HOOK_COLUMNS} FROM outgoing_webhooks WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const existing = locked.rows[0];
    if (!existing) {
      await client.query("COMMIT");
      return null;
    }
    const name = body.name?.trim() ?? existing.name;
    const url = body.url?.trim() ?? existing.url;
    const channelIds =
      body.channelIds !== undefined || body.status === "active"
        ? await validateTextChannelIds(
            existing.server_id,
            body.channelIds ?? existing.channel_ids,
            client,
          )
        : existing.channel_ids;
    const skipUserIds =
      body.skipUserIds !== undefined
        ? await validateSkipUserIds(
            existing.server_id,
            body.skipUserIds,
            client,
            existing.skip_user_ids ?? [],
          )
        : (existing.skip_user_ids ?? []);

    let authName = existing.auth_header_name;
    let authValue = existing.auth_header_value;
    if (body.authHeaderName !== undefined || body.authHeaderValue !== undefined) {
      const auth = normalizeAuth(
        body.authHeaderName !== undefined
          ? body.authHeaderName
          : existing.auth_header_name,
        body.authHeaderValue !== undefined
          ? body.authHeaderValue
          : existing.auth_header_value,
      );
      authName = auth.name;
      authValue = auth.value;
    }

    let status = existing.status;
    let disabledReason = existing.disabled_reason;
    if (body.status === "disabled") {
      status = "disabled";
      disabledReason = disabledReason ?? "disabled by a manager";
    } else if (body.status === "active") {
      status = "active";
      disabledReason = null;
    }

    const result = await client.query<OutgoingWebhookRow>(
      `UPDATE outgoing_webhooks
          SET name = $2,
              url = $3,
              channel_ids = $4,
              skip_user_ids = $5,
              auth_header_name = $6,
              auth_header_value = $7,
              status = $8,
              disabled_reason = $9,
              updated_at = NOW()
        WHERE id = $1
        RETURNING ${HOOK_COLUMNS}`,
      [
        id,
        name,
        url,
        channelIds,
        skipUserIds,
        authName,
        authValue,
        status,
        disabledReason,
      ],
    );
    await client.query("COMMIT");
    saved = result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return saved
    ? mapOutgoingWebhook(saved, { bestEffortChannels: true })
    : null;
}

export async function deleteOutgoingWebhook(id: string): Promise<boolean> {
  const result = await getPool().query(
    `DELETE FROM outgoing_webhooks WHERE id = $1`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function rotateOutgoingWebhookSecret(
  id: string,
): Promise<OutgoingWebhook | null> {
  const existing = await getOutgoingWebhookRow(id);
  if (!existing) {
    return null;
  }
  const next = generateSigningSecret();
  const result = await getPool().query<OutgoingWebhookRow>(
    `UPDATE outgoing_webhooks
        SET signing_secret_previous = signing_secret,
            previous_secret_expires_at = NOW() + ($2 * INTERVAL '1 millisecond'),
            signing_secret = $3,
            updated_at = NOW()
      WHERE id = $1
      RETURNING ${HOOK_COLUMNS}`,
    [id, PREVIOUS_SECRET_TTL_MS, next],
  );
  return result.rows[0]
    ? mapOutgoingWebhook(result.rows[0], {
        includeSecret: true,
        bestEffortChannels: true,
      })
    : null;
}

/**
 * Deterministic JSON: key order is part of the signed bytes. `JSON.stringify`
 * on a freshly built object (not a JSONB round-trip) keeps that order.
 */
export function serializeMessageCreatedPayload(
  payload: OutgoingMessageCreatedPayload,
): string {
  return JSON.stringify({
    type: payload.type,
    id: payload.id,
    createdAt: payload.createdAt,
    timestamp: payload.timestamp,
    serverId: payload.serverId,
    serverName: payload.serverName,
    channelId: payload.channelId,
    channelName: payload.channelName,
    messageId: payload.messageId,
    author: {
      id: payload.author.id,
      username: payload.author.username,
      tag: payload.author.tag,
      displayName: payload.author.displayName,
      isBot: payload.author.isBot,
    },
    body: payload.body,
    replyToId: payload.replyToId,
  });
}

function clipError(message: string): string {
  return message.length > MAX_LAST_ERROR
    ? message.slice(0, MAX_LAST_ERROR)
    : message;
}

/**
 * After `createMessage` commits. Inserts outbox rows; never waits on HTTP.
 * Incoming-webhook authors, character accounts, and users marked `is_bot`
 * are skipped for every hook. A helper that is still a normal user (Caio)
 * is listed on the hook's `skip_user_ids`. Looked up from `users` here
 * because the WS `DbUser` often lacks `is_webhook`.
 */
export async function enqueueOutgoingMessageCreated(input: {
  channelId: string;
  messageId: string;
  authorId: string;
  body: string;
  createdAt: Date;
  replyToId: string | null;
}): Promise<number> {
  if (!input.body.trim()) {
    return 0;
  }

  const channel = await getPool().query<{
    id: string;
    server_id: string | null;
    name: string;
    type: string;
    kind: string;
    parent_id: string | null;
  }>(
    `SELECT id, server_id, name, type, kind, parent_id
       FROM channels WHERE id = $1`,
    [input.channelId],
  );
  const row = channel.rows[0];
  if (!row || row.kind !== "server" || !row.server_id) {
    return 0;
  }
  if (row.type !== "text" && row.type !== "thread") {
    return 0;
  }

  const matchIds = [row.id];
  if (row.type === "thread" && row.parent_id) {
    matchIds.push(row.parent_id);
  }

  const hooks = await getPool().query<{ id: string; skip_user_ids: string[] }>(
    `SELECT id, skip_user_ids FROM outgoing_webhooks
      WHERE server_id = $1
        AND status <> 'disabled'
        AND channel_ids && $2::uuid[]`,
    [row.server_id, matchIds],
  );
  if (hooks.rows.length === 0) {
    return 0;
  }

  const author = await getPool().query<{
    id: string;
    display_name: string;
    username: string | null;
    discriminator: string | null;
    is_webhook: boolean | null;
    is_character: boolean | null;
    is_bot: boolean | null;
  }>(
    `SELECT id, display_name, username, discriminator,
            is_webhook, is_character, is_bot
       FROM users WHERE id = $1`,
    [input.authorId],
  );
  const user = author.rows[0];
  if (!user) {
    return 0;
  }
  if (user.is_webhook || user.is_character || user.is_bot) {
    return 0;
  }

  const server = await getPool().query<{ name: string }>(
    `SELECT name FROM servers WHERE id = $1`,
    [row.server_id],
  );
  const serverName = server.rows[0]?.name ?? "";
  const createdAt = input.createdAt.toISOString();

  let inserted = 0;
  for (const hook of hooks.rows) {
    if ((hook.skip_user_ids ?? []).includes(input.authorId)) {
      continue;
    }
    const deliveryId = randomUUID();
    const payload: OutgoingMessageCreatedPayload = {
      type: OUTGOING_WEBHOOK_EVENT_TYPE,
      id: deliveryId,
      createdAt,
      timestamp: createdAt,
      serverId: row.server_id,
      serverName,
      channelId: row.id,
      channelName: row.name,
      messageId: input.messageId,
      author: {
        id: user.id,
        username: user.username,
        tag: formatUserTag(user.username, user.discriminator),
        displayName: user.display_name,
        isBot: Boolean(user.is_bot),
      },
      body: input.body,
      replyToId: input.replyToId,
    };
    const result = await getPool().query(
      `INSERT INTO outgoing_webhook_deliveries (
         id, outgoing_webhook_id, event_type, payload, message_id, status, next_attempt_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5, 'pending', NOW())
       ON CONFLICT (outgoing_webhook_id, message_id) DO NOTHING`,
      [
        deliveryId,
        hook.id,
        OUTGOING_WEBHOOK_EVENT_TYPE,
        payload,
        input.messageId,
      ],
    );
    inserted += result.rowCount ?? 0;
  }

  if (inserted > 0) {
    void deliverDueOutgoingWebhooks().catch((error: unknown) => {
      console.error("[outgoing-webhooks] delivery kick failed:", error);
    });
    // The in-process kick above is the fast path on the common, single-
    // machine deployment (`WORKER_MODE` unset), and it fully covers it: this
    // same process runs `outgoing-webhook-poller.ts`'s adaptive loop too, so
    // a NOTIFY to itself would be pure overhead — an extra query for every
    // enqueue with nothing on the other end that the kick above did not
    // already do. It only earns its cost in a split deployment, where the
    // process enqueuing (the API) is not the one polling (`pqp-worker`,
    // `WORKER_MODE=worker`) and has no loop of its own to notify.
    if (!runsColdJobs(processRole())) {
      void notifyOutgoingWebhookEnqueued(getPool());
    }
  }
  return inserted;
}

interface DeliveryRow {
  id: string;
  outgoing_webhook_id: string;
  payload: OutgoingMessageCreatedPayload;
  attempt_count: number;
}

function backoffMs(attemptCount: number): number | null {
  const base = BACKOFF_AFTER_ATTEMPT_MS[attemptCount - 1];
  if (base === undefined) {
    return null;
  }
  const jitter = Math.floor(Math.random() * base * 0.2);
  return base + jitter;
}

function parseRetryAfter(
  value: string | string[] | undefined,
  now: number,
): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) {
    return null;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds, 24 * 3600) * 1000;
  }
  const when = Date.parse(raw);
  if (Number.isNaN(when)) {
    return null;
  }
  return Math.max(0, when - now);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function markDelivery(
  id: string,
  fields: {
    status: "pending" | "delivered" | "dead";
    nextAttemptAt?: Date;
    lastStatusCode?: number | null;
    lastError?: string | null;
  },
): Promise<void> {
  await getPool().query(
    `UPDATE outgoing_webhook_deliveries
        SET status = $2,
            next_attempt_at = COALESCE($3, next_attempt_at),
            last_status_code = COALESCE($4, last_status_code),
            last_error = $5,
            updated_at = NOW()
      WHERE id = $1`,
    [
      id,
      fields.status,
      fields.nextAttemptAt ?? null,
      fields.lastStatusCode ?? null,
      fields.lastError ?? null,
    ],
  );
}

async function touchWebhook(
  id: string,
  fields: {
    status?: "active" | "disabled" | "failing";
    lastError?: string | null;
    lastDeliveredAt?: Date | null;
    disabledReason?: string | null;
  },
): Promise<void> {
  await getPool().query(
    `UPDATE outgoing_webhooks
        SET status = COALESCE($2, status),
            last_error = $3,
            last_delivered_at = COALESCE($4, last_delivered_at),
            disabled_reason = COALESCE($5, disabled_reason),
            updated_at = NOW()
      WHERE id = $1`,
    [
      id,
      fields.status ?? null,
      fields.lastError === undefined ? null : fields.lastError,
      fields.lastDeliveredAt ?? null,
      fields.disabledReason ?? null,
    ],
  );
}

let delivering = false;

/**
 * Claim due outbox rows with SKIP LOCKED so two API processes cannot POST the
 * same delivery. Rate-limited per webhook (~5/sec) in memory: the bus is the
 * wrong place for a token bucket.
 */
export async function deliverDueOutgoingWebhooks(): Promise<number> {
  if (delivering) {
    return 0;
  }
  delivering = true;
  try {
    const claimed = await getPool().query<DeliveryRow>(
      `WITH next AS (
         SELECT id
           FROM outgoing_webhook_deliveries
          WHERE status IN ('pending', 'delivering')
            AND next_attempt_at <= NOW()
          ORDER BY next_attempt_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE outgoing_webhook_deliveries d
          SET status = 'delivering',
              attempt_count = d.attempt_count + 1,
              next_attempt_at = NOW() + ($2 * INTERVAL '1 millisecond'),
              updated_at = NOW()
         FROM next
        WHERE d.id = next.id
       RETURNING d.id, d.outgoing_webhook_id, d.payload, d.attempt_count`,
      [MAX_DELIVERIES_PER_TICK, CLAIM_LEASE_MS],
    );

    let delivered = 0;
    for (const row of claimed.rows) {
      const ok = await deliverOne(row);
      if (ok) {
        delivered += 1;
      }
    }
    return delivered;
  } finally {
    delivering = false;
  }
}

async function deliverOne(row: DeliveryRow): Promise<boolean> {
  const hook = await getOutgoingWebhookRow(row.outgoing_webhook_id);
  if (!hook || hook.status === "disabled") {
    await markDelivery(row.id, {
      status: "dead",
      lastError: clipError("Webhook is disabled"),
    });
    return false;
  }

  if (!deliveryLimiter.take(hook.id)) {
    const retrySec = deliveryLimiter.retryAfter(hook.id);
    await getPool().query(
      `UPDATE outgoing_webhook_deliveries
          SET status = 'pending',
              attempt_count = GREATEST(attempt_count - 1, 0),
              next_attempt_at = NOW() + ($2 * INTERVAL '1 second'),
              updated_at = NOW()
        WHERE id = $1`,
      [row.id, Math.max(1, retrySec)],
    );
    return false;
  }

  const payload = row.payload;
  const body = serializeMessageCreatedPayload(payload);
  // Send time, not messages.created_at. Standard Webhooks receivers reject
  // a timestamp outside a ~5 minute window, so a retry or a post-restart
  // backlog must be signed with now.
  const unixTs = String(Math.floor(Date.now() / 1000));
  const secrets = [hook.signing_secret];
  if (
    hook.signing_secret_previous &&
    hook.previous_secret_expires_at &&
    hook.previous_secret_expires_at.getTime() > Date.now()
  ) {
    secrets.push(hook.signing_secret_previous);
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "webhook-id": row.id,
    "webhook-timestamp": unixTs,
    "webhook-signature": signatureHeader(secrets, row.id, unixTs, body),
    "user-agent": "pqp-webhooks/1.0 (+https://pqp.gg)",
  };
  if (hook.auth_header_name && hook.auth_header_value) {
    headers[hook.auth_header_name] = hook.auth_header_value;
  }

  const fetchOpts = outgoingWebhookFetchOptions();
  try {
    await assertOutgoingWebhookUrl(hook.url);
    const result = await safePost(hook.url, {
      body,
      headers,
      timeoutMs: DELIVERY_TIMEOUT_MS,
      allowPrivate: fetchOpts.allowPrivate,
      requireHttps: fetchOpts.requireHttps,
    });
    const status = result.statusCode;

    if (status >= 200 && status < 300) {
      await markDelivery(row.id, {
        status: "delivered",
        lastStatusCode: status,
        lastError: null,
      });
      await getPool().query(
        `UPDATE outgoing_webhooks
            SET status = CASE WHEN status = 'disabled' THEN status ELSE 'active' END,
                last_error = NULL,
                last_delivered_at = NOW(),
                updated_at = NOW()
          WHERE id = $1`,
        [hook.id],
      );
      return true;
    }

    if (status === 410) {
      await markDelivery(row.id, {
        status: "dead",
        lastStatusCode: status,
        lastError: clipError("HTTP 410 Gone"),
      });
      await touchWebhook(hook.id, {
        status: "disabled",
        lastError: clipError("HTTP 410 Gone"),
        disabledReason: "endpoint returned 410 Gone",
      });
      return false;
    }

    const retryable = isRetryableStatus(status);
    const retryAfter = parseRetryAfter(result.headers["retry-after"], Date.now());
    await failAttempt(row, hook.id, {
      retryable,
      statusCode: status,
      error: `HTTP ${status}`,
      retryAfterMs: retryAfter,
    });
    return false;
  } catch (error) {
    const message =
      error instanceof UnsafeUrlError || error instanceof Error
        ? error.message
        : "Delivery failed";
    const retryable =
      !(error instanceof UnsafeUrlError) &&
      !(error instanceof HttpError);
    await failAttempt(row, hook.id, {
      retryable,
      statusCode: null,
      error: message,
    });
    return false;
  }
}

async function failAttempt(
  row: DeliveryRow,
  webhookId: string,
  info: {
    retryable: boolean;
    statusCode: number | null;
    error: string;
    retryAfterMs?: number | null;
  },
): Promise<void> {
  const delay = info.retryable ? backoffMs(row.attempt_count) : null;
  if (delay === null) {
    await markDelivery(row.id, {
      status: "dead",
      lastStatusCode: info.statusCode,
      lastError: clipError(info.error),
    });
    await getPool().query(
      `UPDATE outgoing_webhooks
          SET status = CASE WHEN status = 'disabled' THEN status ELSE 'failing' END,
              last_error = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [webhookId, clipError(info.error)],
    );
    return;
  }
  const wait = Math.max(delay, info.retryAfterMs ?? 0);
  await markDelivery(row.id, {
    status: "pending",
    nextAttemptAt: new Date(Date.now() + wait),
    lastStatusCode: info.statusCode,
    lastError: clipError(info.error),
  });
  await getPool().query(
    `UPDATE outgoing_webhooks
        SET status = CASE WHEN status = 'disabled' THEN status ELSE 'failing' END,
            last_error = $2,
            updated_at = NOW()
      WHERE id = $1 AND status <> 'disabled'`,
    [webhookId, clipError(info.error)],
  );
}

export async function pruneDeliveredOutgoingWebhooks(): Promise<number> {
  const result = await getPool().query(
    `DELETE FROM outgoing_webhook_deliveries
      WHERE status = 'delivered'
        AND updated_at < NOW() - ($1 * INTERVAL '1 millisecond')`,
    [DELIVERED_RETENTION_MS],
  );
  await getPool().query(
    `UPDATE outgoing_webhooks
        SET signing_secret_previous = NULL,
            previous_secret_expires_at = NULL,
            updated_at = NOW()
      WHERE previous_secret_expires_at IS NOT NULL
        AND previous_secret_expires_at < NOW()`,
  );
  return result.rowCount ?? 0;
}
