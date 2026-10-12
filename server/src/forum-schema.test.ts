import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The forum tables (schema.sql, "forum channels") against a real Postgres,
 * before any service reads them: the cascades and the checks the later PRs
 * rely on without re-testing. See packages/shared/src/forums.ts for what each
 * column means.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("./db.js");
const { upsertUser } = await import("./services/users.js");
const { createServer } = await import("./services/servers.js");

const q = <T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
) => getPool().query<T>(text, values);

const count = async (text: string, values: unknown[] = []) =>
  Number((await q<{ n: string }>(text, values)).rows[0]!.n);

describeDb("forum tables", () => {
  let authorId: string;
  let readerId: string;
  let serverId: string;
  let forumId: string;
  let postId: string;
  let openingId: string;
  let answerId: string;
  let tagId: string;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await q("TRUNCATE users, servers RESTART IDENTITY CASCADE");
    authorId = (await upsertUser({ clerkId: "forum_author", displayName: "Ana", avatarUrl: null }))
      .id;
    readerId = (await upsertUser({ clerkId: "forum_reader", displayName: "Bia", avatarUrl: null }))
      .id;
    serverId = (await createServer("Fórum", authorId)).server.id;
    forumId = (
      await q<{ id: string }>(
        `INSERT INTO channels (server_id, name, type) VALUES ($1, 'ajuda', 'forum') RETURNING id`,
        [serverId],
      )
    ).rows[0]!.id;
    postId = (
      await q<{ id: string }>(
        `INSERT INTO channels (server_id, name, type, parent_id)
         VALUES ($1, 'Notebook não liga', 'thread', $2) RETURNING id`,
        [serverId, forumId],
      )
    ).rows[0]!.id;
    openingId = (
      await q<{ id: string }>(
        `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, 'socorro') RETURNING id`,
        [postId, authorId],
      )
    ).rows[0]!.id;
    answerId = (
      await q<{ id: string }>(
        `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, 'tenta a fonte') RETURNING id`,
        [postId, readerId],
      )
    ).rows[0]!.id;
    await q(
      `INSERT INTO forum_posts (channel_id, forum_id, author_id, opening_message_id,
                                resolved_message_id, resolved_at, published_at, client_nonce)
       VALUES ($1, $2, $3, $4, $5, now(), now(), 'n1')`,
      [postId, forumId, authorId, openingId, answerId],
    );
    tagId = (
      await q<{ id: string }>(
        `INSERT INTO forum_tags (forum_id, name, emoji) VALUES ($1, 'Dúvida', '❓') RETURNING id`,
        [forumId],
      )
    ).rows[0]!.id;
    await q(`INSERT INTO forum_post_tags (post_id, tag_id) VALUES ($1, $2)`, [postId, tagId]);
    await q(`INSERT INTO forum_post_follows (post_id, user_id) VALUES ($1, $2), ($1, $3)`, [
      postId,
      authorId,
      readerId,
    ]);
    await q(`INSERT INTO forum_settings (forum_id, require_tag) VALUES ($1, TRUE)`, [forumId]);
  });

  it("deleting a post's channel takes its post row, tags and follows, not the forum's", async () => {
    await q(`DELETE FROM channels WHERE id = $1`, [postId]);
    expect(await count(`SELECT count(*) AS n FROM forum_posts`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM forum_post_tags`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM forum_post_follows`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM forum_tags`)).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM forum_settings`)).toBe(1);
  });

  it("deleting the forum takes its tags, settings and post rows", async () => {
    await q(`DELETE FROM channels WHERE id = $1`, [forumId]);
    expect(await count(`SELECT count(*) AS n FROM forum_tags`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM forum_settings`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM forum_posts`)).toBe(0);
  });

  it("a deleted account leaves the post (author NULL) and drops only its follow", async () => {
    // `servers.owner_id` cascades, so the author's own server goes with the
    // account; the post that must survive lives in somebody else's.
    const other = (await createServer("Outro", readerId)).server.id;
    const forum2 = (
      await q<{ id: string }>(
        `INSERT INTO channels (server_id, name, type) VALUES ($1, 'f2', 'forum') RETURNING id`,
        [other],
      )
    ).rows[0]!.id;
    const post2 = (
      await q<{ id: string }>(
        `INSERT INTO channels (server_id, name, type, parent_id) VALUES ($1, 'p2', 'thread', $2) RETURNING id`,
        [other, forum2],
      )
    ).rows[0]!.id;
    await q(`INSERT INTO forum_posts (channel_id, forum_id, author_id) VALUES ($1, $2, $3)`, [
      post2,
      forum2,
      authorId,
    ]);
    await q(`INSERT INTO forum_post_follows (post_id, user_id) VALUES ($1, $2), ($1, $3)`, [
      post2,
      authorId,
      readerId,
    ]);
    await q(`DELETE FROM users WHERE id = $1`, [authorId]);
    const row = await q<{ author_id: string | null }>(
      `SELECT author_id FROM forum_posts WHERE channel_id = $1`,
      [post2],
    );
    expect(row.rows[0]?.author_id).toBeNull();
    expect(
      await count(`SELECT count(*) AS n FROM forum_post_follows WHERE post_id = $1`, [post2]),
    ).toBe(1);
  });

  it("a deleted answer keeps its id on the post (no FK), so the post can say it was deleted", async () => {
    await q(`DELETE FROM messages WHERE id = $1`, [answerId]);
    const row = await q<{ resolved_message_id: string | null; resolved_at: Date | null }>(
      `SELECT resolved_message_id, resolved_at FROM forum_posts WHERE channel_id = $1`,
      [postId],
    );
    expect(row.rows[0]?.resolved_message_id).toBe(answerId);
    expect(row.rows[0]?.resolved_at).not.toBeNull();
  });

  it("a retried create collides on the nonce", async () => {
    const again = await q<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, parent_id)
       VALUES ($1, 'dup', 'thread', $2) RETURNING id`,
      [serverId, forumId],
    );
    await expect(
      q(
        `INSERT INTO forum_posts (channel_id, forum_id, author_id, client_nonce) VALUES ($1, $2, $3, 'n1')`,
        [again.rows[0]!.id, forumId, authorId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("refuses a duplicate tag name in one forum, case-insensitively, and an over-long one", async () => {
    await expect(
      q(`INSERT INTO forum_tags (forum_id, name) VALUES ($1, 'dúvida')`, [forumId]),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      q(`INSERT INTO forum_tags (forum_id, name) VALUES ($1, $2)`, [forumId, "x".repeat(21)]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("defaults the settings and refuses a sort that does not exist", async () => {
    await q(`DELETE FROM forum_settings`);
    const row = await q<{ require_tag: boolean; default_sort: string }>(
      `INSERT INTO forum_settings (forum_id) VALUES ($1) RETURNING require_tag, default_sort`,
      [forumId],
    );
    expect(row.rows[0]).toEqual({ require_tag: false, default_sort: "activity" });
    await expect(
      q(`UPDATE forum_settings SET default_sort = 'hot' WHERE forum_id = $1`, [forumId]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("a forum webhook's settings go with the webhook and bound the dedupe window", async () => {
    const pseudo = (
      await upsertUser({ clerkId: "forum_webhook_pseudo", displayName: "Feed", avatarUrl: null })
    ).id;
    const webhookId = (
      await q<{ id: string }>(
        `INSERT INTO webhooks (channel_id, server_id, name, token, pseudo_user_id)
         VALUES ($1, $2, 'rss', 'tok-forum', $3) RETURNING id`,
        [forumId, serverId, pseudo],
      )
    ).rows[0]!.id;
    const row = await q<{ default_tag_ids: string[]; dedupe_window_hours: number }>(
      `INSERT INTO webhook_forum_settings (webhook_id) VALUES ($1)
       RETURNING default_tag_ids, dedupe_window_hours`,
      [webhookId],
    );
    expect(row.rows[0]).toEqual({ default_tag_ids: [], dedupe_window_hours: 72 });
    await expect(
      q(`UPDATE webhook_forum_settings SET dedupe_window_hours = 721`),
    ).rejects.toMatchObject({ code: "23514" });
    await q(`DELETE FROM webhooks WHERE id = $1`, [webhookId]);
    expect(await count(`SELECT count(*) AS n FROM webhook_forum_settings`)).toBe(0);
  });
});
