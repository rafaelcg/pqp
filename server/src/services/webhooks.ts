import { randomBytes, randomUUID } from "node:crypto";
import type { ExecuteWebhookBody } from "@pqp/shared";
import { getPool, type DbUser } from "../db.js";
import type { HydratedMessage } from "./messages.js";

/**
 * 32 random bytes, base64url — long enough that guessing one is not a
 * realistic attack, since it is the *only* credential an incoming execute
 * request carries. Never derived from anything else about the webhook,
 * unlike an invite code, which can afford to be short and memorable because
 * a wrong guess only joins a public server rather than posting as it.
 */
function generateWebhookToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * A webhook's pseudo-identity. `messages.author_id` is `NOT NULL`, and every
 * read path already assumes a joinable author row, so a webhook gets a real
 * `users` row rather than teaching each of those paths to handle a null
 * author. `clerk_id` is a synthetic value — nothing ever authenticates as
 * this row, so it only has to be unique, not real.
 */
async function createPseudoUser(
  name: string,
  avatarUrl: string | null,
): Promise<DbUser> {
  const result = await getPool().query<DbUser>(
    `INSERT INTO users (clerk_id, display_name, avatar_url, is_webhook)
     VALUES ($1, $2, $3, TRUE)
     RETURNING id, clerk_id, display_name, username, discriminator, avatar_url`,
    [`webhook:${randomUUID()}`, name, avatarUrl],
  );
  return result.rows[0]!;
}

export interface DbWebhook {
  id: string;
  channel_id: string;
  server_id: string;
  name: string;
  avatar_url: string | null;
  token: string;
  pseudo_user_id: string;
  created_at: Date;
}

const WEBHOOK_COLUMNS = `id, channel_id, server_id, name, avatar_url, token, pseudo_user_id, created_at`;

export async function createWebhook(
  channelId: string,
  serverId: string,
  name: string,
  avatarUrl: string | null,
  createdBy: string,
): Promise<DbWebhook> {
  const pseudoUser = await createPseudoUser(name, avatarUrl);
  const token = generateWebhookToken();
  const result = await getPool().query<DbWebhook>(
    `INSERT INTO webhooks (channel_id, server_id, name, avatar_url, token, pseudo_user_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${WEBHOOK_COLUMNS}`,
    [channelId, serverId, name, avatarUrl, token, pseudoUser.id, createdBy],
  );
  return result.rows[0]!;
}

export async function listWebhooksForChannel(
  channelId: string,
): Promise<DbWebhook[]> {
  const result = await getPool().query<DbWebhook>(
    `SELECT ${WEBHOOK_COLUMNS} FROM webhooks WHERE channel_id = $1 ORDER BY created_at ASC`,
    [channelId],
  );
  return result.rows;
}

/** For the authorization check on delete — which server does this webhook
 * belong to, before anything about it is changed. */
export async function getWebhook(webhookId: string): Promise<DbWebhook | null> {
  const result = await getPool().query<DbWebhook>(
    `SELECT ${WEBHOOK_COLUMNS} FROM webhooks WHERE id = $1`,
    [webhookId],
  );
  return result.rows[0] ?? null;
}

/**
 * Deletes the webhook row only — never the pseudo-user, and never the
 * messages it sent. Discord's own webhooks work the same way: revoking one
 * stops future posts without erasing what it already said.
 */
export async function deleteWebhook(webhookId: string): Promise<DbWebhook | null> {
  const result = await getPool().query<DbWebhook>(
    `DELETE FROM webhooks WHERE id = $1 RETURNING ${WEBHOOK_COLUMNS}`,
    [webhookId],
  );
  return result.rows[0] ?? null;
}

/**
 * The one lookup an incoming execute request is authorized by — id and
 * token both have to match. No Clerk session involved at all; see the
 * dedicated, unauthenticated route this backs in api/index.ts.
 */
export async function getWebhookForExecution(
  id: string,
  token: string,
): Promise<DbWebhook | null> {
  const result = await getPool().query<DbWebhook>(
    `SELECT ${WEBHOOK_COLUMNS} FROM webhooks WHERE id = $1 AND token = $2`,
    [id, token],
  );
  return result.rows[0] ?? null;
}

/**
 * Posts one message as the webhook's pseudo-user. Reactions/attachments/
 * link-embeds are always empty for a message that was never sent through
 * the normal compose path — nothing here claims an upload or unfurls a
 * link, matching how `createMessage` leaves the same fields empty for a
 * message no client has round-tripped through yet.
 */
export async function executeWebhook(
  webhook: DbWebhook,
  body: ExecuteWebhookBody,
): Promise<HydratedMessage> {
  const result = await getPool().query<{
    id: string;
    channel_id: string;
    author_id: string;
    body: string;
    created_at: Date;
    edited_at: Date | null;
    webhook_embeds: unknown;
    webhook_username: string | null;
    webhook_avatar_url: string | null;
  }>(
    `INSERT INTO messages (channel_id, author_id, body, webhook_embeds, webhook_username, webhook_avatar_url)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, channel_id, author_id, body, created_at, edited_at,
               webhook_embeds, webhook_username, webhook_avatar_url`,
    [
      webhook.channel_id,
      webhook.pseudo_user_id,
      body.content ?? "",
      body.embeds ? JSON.stringify(body.embeds) : null,
      body.username ?? null,
      body.avatar_url ?? null,
    ],
  );
  const row = result.rows[0]!;
  return {
    ...row,
    author_name: webhook.name,
    author_username: null,
    author_discriminator: null,
    author_avatar_url: webhook.avatar_url,
    author_is_webhook: true,
    reactions: [],
    attachments: [],
    embeds: [],
  };
}
