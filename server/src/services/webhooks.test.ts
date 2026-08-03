import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The webhook pseudo-identity is the part worth proving against a real
 * Postgres: that it survives the webhook being deleted, that it never
 * collects a username (which is what keeps it out of search and @mention
 * resolution — see the schema comment on `users.is_webhook`), and that
 * per-execution name/avatar overrides apply without mutating anything
 * shared with the next execution.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const {
  createWebhook,
  deleteWebhook,
  executeWebhook,
  getWebhook,
  getWebhookForExecution,
  listWebhooksForChannel,
} = await import("./webhooks.js");
const { mapMessage } = await import("./messages.js");

describeDb("webhooks", () => {
  let ownerId: string;
  let serverId: string;
  let channelId: string;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(
      `TRUNCATE users, servers, channels, messages, webhooks RESTART IDENTITY CASCADE`,
    );
    const owner = await upsertUser({
      clerkId: "clerk_webhook_owner",
      displayName: "Webhook Owner",
      avatarUrl: null,
    });
    ownerId = owner.id;
    const server = await getPool().query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('Webhook Test', $1) RETURNING id`,
      [ownerId],
    );
    serverId = server.rows[0]!.id;
    const channel = await getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position) VALUES ($1, 'general', 'text', 0) RETURNING id`,
      [serverId],
    );
    channelId = channel.rows[0]!.id;
  });

  it("creates a pseudo-user with no username, so it never surfaces in search or @mentions", async () => {
    const webhook = await createWebhook(
      channelId,
      serverId,
      "Build Bot",
      null,
      ownerId,
    );
    const pseudoUser = await getPool().query<{
      username: string | null;
      discriminator: string | null;
      is_webhook: boolean;
    }>(`SELECT username, discriminator, is_webhook FROM users WHERE id = $1`, [
      (
        await getPool().query<{ pseudo_user_id: string }>(
          `SELECT pseudo_user_id FROM webhooks WHERE id = $1`,
          [webhook.id],
        )
      ).rows[0]!.pseudo_user_id,
    ]);
    expect(pseudoUser.rows[0]).toMatchObject({
      username: null,
      discriminator: null,
      is_webhook: true,
    });
  });

  it("lists webhooks for a channel and finds one by id", async () => {
    await createWebhook(channelId, serverId, "Bot One", null, ownerId);
    await createWebhook(channelId, serverId, "Bot Two", null, ownerId);
    const list = await listWebhooksForChannel(channelId);
    expect(list.map((w) => w.name).sort()).toEqual(["Bot One", "Bot Two"]);

    const found = await getWebhook(list[0]!.id);
    expect(found?.id).toBe(list[0]!.id);
    expect(await getWebhook("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("executes a webhook, and the resulting message is authored by its pseudo-identity", async () => {
    const webhook = await createWebhook(
      channelId,
      serverId,
      "Build Bot",
      "https://example.com/bot.png",
      ownerId,
    );
    const message = await executeWebhook(webhook, { content: "build passed" });
    const mapped = mapMessage(message);

    expect(mapped).toMatchObject({
      body: "build passed",
      authorName: "Build Bot",
      authorAvatarUrl: "https://example.com/bot.png",
      isWebhook: true,
      webhookEmbeds: [],
    });
  });

  it("applies a per-execution name/avatar override without affecting the webhook's own default", async () => {
    const webhook = await createWebhook(
      channelId,
      serverId,
      "Build Bot",
      null,
      ownerId,
    );
    const overridden = await executeWebhook(webhook, {
      content: "deployed",
      username: "Deploy Bot",
      avatar_url: "https://example.com/deploy.png",
    });
    expect(mapMessage(overridden)).toMatchObject({
      authorName: "Deploy Bot",
      authorAvatarUrl: "https://example.com/deploy.png",
    });

    // The webhook's own configured name is untouched by that override.
    const plain = await executeWebhook(webhook, { content: "next build" });
    expect(mapMessage(plain)).toMatchObject({ authorName: "Build Bot" });
  });

  it("stores the embeds a payload supplied", async () => {
    const webhook = await createWebhook(channelId, serverId, "Bot", null, ownerId);
    const message = await executeWebhook(webhook, {
      embeds: [{ title: "Deploy succeeded", color: 0x00ff00 }],
    });
    expect(mapMessage(message).webhookEmbeds).toMatchObject([
      { title: "Deploy succeeded", color: 0x00ff00 },
    ]);
  });

  it("authorizes execution by id AND token together, not either alone", async () => {
    const webhook = await createWebhook(channelId, serverId, "Bot", null, ownerId);
    expect(await getWebhookForExecution(webhook.id, webhook.token)).not.toBeNull();
    expect(await getWebhookForExecution(webhook.id, "wrong-token")).toBeNull();
    expect(
      await getWebhookForExecution("00000000-0000-4000-8000-000000000000", webhook.token),
    ).toBeNull();
  });

  it("deleting a webhook removes the row but keeps its pseudo-user and past messages", async () => {
    const webhook = await createWebhook(channelId, serverId, "Bot", null, ownerId);
    const message = await executeWebhook(webhook, { content: "before deletion" });

    await deleteWebhook(webhook.id);

    expect(await getWebhook(webhook.id)).toBeNull();
    expect(await getWebhookForExecution(webhook.id, webhook.token)).toBeNull();

    const stillThere = await getPool().query(`SELECT id FROM messages WHERE id = $1`, [
      message.id,
    ]);
    expect(stillThere.rows).toHaveLength(1);
  });
});
