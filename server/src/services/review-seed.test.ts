import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findBaselineViolation, Permission } from "@pqp/shared";
import type { BusFrame } from "../lib/bus.js";

/**
 * The App Review demo space script, against a real Postgres.
 *
 * What is pinned, in the order it matters to the person running it on the
 * production box:
 *
 *   * a dry run writes NOTHING, to any table;
 *   * `--apply` makes a private server (no public address, not listed), an
 *     owner, a second member who can post, three channels, messages, reactions
 *     and an invite;
 *   * running it again changes nothing, and finishes a run that died half way;
 *   * Report and Block work against the seeded friend;
 *   * `--leave-others` leaves memberships and nothing else, and refuses an owner;
 *   * `--cleanup` removes only what the script made;
 *   * all of it again with the flags production sets (`CLUSTER_BUS=postgres`,
 *     `VOICE_REGISTRY=postgres`), including that the audience invalidation
 *     actually reaches ANOTHER instance, which is the one thing the script's
 *     bus exists for.
 *
 * TEST_DATABASE_URL wins, and the suite skips without a database.
 */

const CANDIDATE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

/**
 * This suite TRUNCATEs `users` with CASCADE. It runs only against a database on
 * this machine (a dev copy, or CI's throwaway service container); a URL that
 * points anywhere else, such as a production DATABASE_URL left in the
 * environment, skips it instead of emptying it.
 */
function isLocalDatabase(url: string | undefined): url is string {
  if (!url) {
    return false;
  }
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"];
  try {
    const parsed = new URL(url);
    if (!local.includes(parsed.hostname)) {
      return false;
    }
    // The driver lets `?host=` (and `?hostaddr=`) override the authority, so
    // the URL's hostname alone does not say where the connection goes. Any
    // such parameter must itself be local, and a URL that carries more than
    // one is refused outright.
    const overrides = [
      ...parsed.searchParams.getAll("host"),
      ...parsed.searchParams.getAll("hostaddr"),
    ];
    if (overrides.length > 1) {
      return false;
    }
    return overrides.every((value) => local.includes(value));
  } catch {
    return false;
  }
}

const DATABASE_URL = isLocalDatabase(CANDIDATE_URL) ? CANDIDATE_URL : undefined;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { createServer, listChannels, getServer } = await import("./servers.js");
const { createMessage } = await import("./messages.js");
const { blockUser, listBlocks } = await import("./blocks.js");
const { createReport } = await import("./reports.js");
const { listRoles } = await import("./roles.js");
const { memberHasPermission } = await import("./permissions.js");
const { createPostgresBusTransport } = await import("../lib/bus-postgres.js");
const { listFriendships, sendFriendRequest, acceptFriendRequest } = await import("./friends.js");
const { listConversations, hideConversation, openConversation } = await import("./dms.js");
const { checkBaselineText, getBaselineStatus, invalidateAutomodCache, setBaselineEnabled } =
  await import("./automod.js");
const {
  REVIEW_BLOCKME_LABEL,
  REVIEW_BLOCKME_NAME,
  REVIEW_DM_MESSAGES,
  REVIEW_FRIEND_LABEL,
  REVIEW_FRIEND_NAME,
  REVIEW_MESSAGES,
  REVIEW_NONCE_PREFIX,
  REVIEW_REACTIONS,
  REVIEW_SERVER_NAME,
  ReviewSeedError,
  runReviewSeed,
} = await import("./review-seed.js");
const { describeDatabase, parseArgs } = await import(
  "../scripts/seed-review-community.js"
);

const DEMO_CLERK_ID = "user_test_demo_reviewer";

async function table(name: string): Promise<number> {
  const result = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${name}`,
  );
  return result.rows[0]!.n;
}

/** Row counts of every table the script could possibly write. */
async function snapshot(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of [
    "users",
    "servers",
    "server_members",
    "channels",
    "messages",
    "message_reactions",
    "server_invites",
    "roles",
    "character_accounts",
    "user_blocks",
    "reports",
    "friendships",
    "dm_pairs",
    "channel_members",
    "server_text_filter_settings",
  ]) {
    out[name] = await table(name);
  }
  return out;
}

function suite(label: string): void {
  describeDb(label, () => {
    let demoId: string;

    beforeAll(async () => {
      await initDb();
    });

    afterAll(async () => {
      await closePool();
    });

    beforeEach(async () => {
      await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
      demoId = (
        await upsertUser({
          clerkId: DEMO_CLERK_ID,
          displayName: "AppStore Reviewer",
          avatarUrl: null,
        })
      ).id;
    });

    const run = (extra: Record<string, unknown> = {}) =>
      runReviewSeed({ clerkId: DEMO_CLERK_ID, ...extra });

    it("a dry run changes nothing, anywhere", async () => {
      const before = await snapshot();
      const lines: string[] = [];
      const report = await run({ log: (line: string) => lines.push(line) });
      expect(await snapshot()).toEqual(before);
      expect(report.apply).toBe(false);
      expect(report.serverId).toBeNull();
      expect(report.actions.some((a) => a.kind === "create")).toBe(true);
      expect(lines.join("\n")).toContain(REVIEW_SERVER_NAME);

      // ...and a dry run on top of a finished seed also changes nothing.
      await run({ apply: true });
      const seeded = await snapshot();
      await run();
      expect(await snapshot()).toEqual(seeded);
    });

    it("builds a private server with an owner, a friend, channels, messages and an invite", async () => {
      const report = await run({ apply: true });
      expect(report.serverId).toBeTruthy();
      const serverId = report.serverId!;

      const server = await getServer(serverId);
      expect(server?.name).toBe(REVIEW_SERVER_NAME);
      expect(server?.owner_id).toBe(demoId);

      // Nothing public, nothing listed: this must never touch the instance's
      // legal category (docs/CONTENT_SAFETY.md, "Communities").
      const flags = await getPool().query(
        `SELECT is_community, is_community_listed, community_slug FROM servers WHERE id = $1`,
        [serverId],
      );
      expect(flags.rows[0]).toMatchObject({
        is_community: false,
        is_community_listed: false,
        community_slug: null,
      });
      expect(
        (await getPool().query(`SELECT 1 FROM servers WHERE is_community OR is_community_listed`))
          .rowCount,
      ).toBe(0);

      // Real cargos, from createServer.
      expect((await listRoles(serverId)).length).toBeGreaterThan(0);
      const roles = await getPool().query(
        `SELECT role FROM server_members WHERE server_id = $1 AND user_id = $2`,
        [serverId, demoId],
      );
      expect(roles.rows[0]?.role).toBe("owner");

      // Channels: #geral, #ajuda (text) and Lobby (voice), and no #general left.
      const channels = await listChannels(serverId, demoId);
      expect(channels.map((c) => `${c.type}:${c.name}`).sort()).toEqual([
        "text:ajuda",
        "text:geral",
        "voice:Lobby",
      ]);

      // The friend: a member, flagged, and nobody can sign in as it.
      const friendId = report.friendUserId!;
      expect(friendId).toBeTruthy();
      const friend = await getPool().query(
        `SELECT u.display_name, u.is_character, u.is_webhook, u.dm_privacy,
                ca.label, ca.revoked_at, sm.role
           FROM users u
           JOIN character_accounts ca ON ca.user_id = u.id
           JOIN server_members sm ON sm.user_id = u.id AND sm.server_id = $2
          WHERE u.id = $1`,
        [friendId, serverId],
      );
      expect(friend.rows[0]).toMatchObject({
        display_name: REVIEW_FRIEND_NAME,
        is_character: true,
        is_webhook: false,
        dm_privacy: "nobody",
        label: REVIEW_FRIEND_LABEL,
        role: "member",
      });
      expect(friend.rows[0]!.revoked_at).not.toBeNull();
      // Both can post where they are (the friend's messages are written by the
      // script, but the member row has to be one the real checks accept).
      for (const geral of channels.filter((c) => c.name === "geral")) {
        expect(
          await memberHasPermission(serverId, friendId, Permission.SEND_MESSAGES, geral.id),
        ).toBe(true);
        expect(
          await memberHasPermission(serverId, demoId, Permission.SEND_MESSAGES, geral.id),
        ).toBe(true);
      }

      // Messages: one per seed entry, both authors, replies wired, bilingual.
      const messages = await getPool().query<{
        body: string;
        author_id: string;
        reply_to_id: string | null;
        nonce: string;
        channel: string;
      }>(
        `SELECT m.body, m.author_id, m.reply_to_id, m.nonce, c.name AS channel
           FROM messages m JOIN channels c ON c.id = m.channel_id
          WHERE c.server_id = $1 ORDER BY m.created_at, m.id`,
        [serverId],
      );
      expect(messages.rowCount).toBe(REVIEW_MESSAGES.length);
      expect(messages.rows.filter((m) => m.channel === "geral").length).toBeGreaterThanOrEqual(6);
      expect(messages.rows.filter((m) => m.channel === "ajuda").length).toBe(1);
      expect(new Set(messages.rows.map((m) => m.author_id))).toEqual(
        new Set([demoId, friendId, report.blockMeUserId]),
      );
      expect(messages.rows.every((m) => m.nonce.startsWith(REVIEW_NONCE_PREFIX))).toBe(true);
      expect(messages.rows.filter((m) => m.reply_to_id).length).toBe(
        REVIEW_MESSAGES.filter((m) => m.replyTo).length,
      );
      expect(messages.rows.some((m) => /test message to report/i.test(m.body))).toBe(true);
      expect(messages.rows.some((m) => /Bem-vindo/.test(m.body))).toBe(true);
      expect((await table("message_reactions"))).toBe(REVIEW_REACTIONS.length);

      // The invite works for a third person, and is the one reported.
      expect(report.inviteCode).toMatch(/^[A-Za-z0-9_-]{6,8}$/);
      const invite = await getPool().query(
        `SELECT created_by, max_uses, expires_at FROM server_invites WHERE code = $1`,
        [report.inviteCode],
      );
      expect(invite.rows[0]).toMatchObject({ created_by: demoId, max_uses: 10, expires_at: null });
    });

    describe("Block Me, the account made to be blocked", () => {
      it("is a revoked character and a member, with two quiet messages in #geral", async () => {
        const report = await run({ apply: true });
        const blockMeId = report.blockMeUserId!;
        expect(blockMeId).toBeTruthy();
        expect(blockMeId).not.toBe(report.friendUserId);
        const row = await getPool().query(
          `SELECT u.display_name, u.is_character, u.dm_privacy, ca.label, ca.revoked_at, sm.role
             FROM users u
             JOIN character_accounts ca ON ca.user_id = u.id
             JOIN server_members sm ON sm.user_id = u.id AND sm.server_id = $2
            WHERE u.id = $1`,
          [blockMeId, report.serverId],
        );
        expect(row.rows[0]).toMatchObject({
          display_name: REVIEW_BLOCKME_NAME,
          is_character: true,
          dm_privacy: "nobody",
          label: REVIEW_BLOCKME_LABEL,
          role: "member",
        });
        expect(row.rows[0]!.revoked_at).not.toBeNull();

        const posts = await getPool().query<{ body: string; channel: string }>(
          `SELECT m.body, c.name AS channel FROM messages m
             JOIN channels c ON c.id = m.channel_id
            WHERE m.author_id = $1 ORDER BY m.created_at, m.id`,
          [blockMeId],
        );
        expect(posts.rowCount).toBe(2);
        expect(posts.rows.every((p) => p.channel === "geral")).toBe(true);
      });

      it("is NOT a friend and has NO conversation with the demo account", async () => {
        const report = await run({ apply: true });
        const blockMeId = report.blockMeUserId!;
        expect(
          (
            await getPool().query(
              `SELECT 1 FROM friendships WHERE low_user_id = $1 OR high_user_id = $1`,
              [blockMeId],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await getPool().query(
              `SELECT 1 FROM dm_pairs WHERE low_user_id = $1 OR high_user_id = $1`,
              [blockMeId],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await getPool().query(
              `SELECT 1 FROM channel_members cm JOIN channels c ON c.id = cm.channel_id
                WHERE cm.user_id = $1 AND c.kind IN ('dm', 'group')`,
              [blockMeId],
            )
          ).rowCount,
        ).toBe(0);
      });

      it("blocking it, as the reviewer is told to, leaves Demo Friend's friendship and DM alone", async () => {
        const report = await run({ apply: true });
        const before = report.chatState!.after;
        expect(before.demoFriendIsFriend).toBe(true);
        expect(before.demoFriendDmMessages).toBe(REVIEW_DM_MESSAGES.length);

        expect(await blockUser(demoId, report.blockMeUserId!)).toBe(true);
        expect((await listBlocks(demoId)).map((b) => b.id)).toEqual([report.blockMeUserId]);

        // The seed run that follows a reviewer's block is not refused either:
        // the block is on Block Me, not on Demo Friend.
        const again = await run({ apply: true });
        expect(again.actions.some((a) => a.kind === "blocked")).toBe(false);
        expect(again.chatState!.after).toEqual(before);
        expect(await listConversations(demoId)).toHaveLength(1);
        expect((await listFriendships(demoId)).friends).toHaveLength(1);
      });

      it("the how-to-block message points at Block Me and not at Demo Friend, in both languages", () => {
        const block = REVIEW_MESSAGES.find((m) => m.key === "block")!;
        expect(block.body).toMatch(/message menu on one of the Block Me messages/);
        expect(block.body).toMatch(/menu de uma mensagem do Block Me/);
        expect(block.body).toMatch(/Demo Friend is your friend, no need to block them/);
        expect(block.body).not.toMatch(/open their profile/);
        // Block Me posts before the instruction that points at it.
        const keys = REVIEW_MESSAGES.map((m) => m.key);
        expect(keys.indexOf("blockme-1")).toBeLessThan(keys.indexOf("block"));
        expect(keys.indexOf("blockme-2")).toBeLessThan(keys.indexOf("block"));
      });

      it("updates a database seeded with the old wording, in place, once", async () => {
        const first = await run({ apply: true });
        const blockNonce = `${REVIEW_NONCE_PREFIX}block`;
        const old =
          "To block someone, open their profile and choose Block. " +
          "Para bloquear alguém, abra o perfil da pessoa e escolha Bloquear.";
        await getPool().query(`UPDATE messages SET body = $2 WHERE nonce = $1`, [blockNonce, old]);
        const idBefore = (
          await getPool().query<{ id: string }>(`SELECT id FROM messages WHERE nonce = $1`, [blockNonce])
        ).rows[0]!.id;
        const counts = await snapshot();

        // A dry run says so and writes nothing.
        const dry = await run();
        expect(dry.actions.some((a) => a.kind === "change" && /text updated/.test(a.what))).toBe(true);
        expect(
          (await getPool().query<{ body: string }>(`SELECT body FROM messages WHERE nonce = $1`, [blockNonce]))
            .rows[0]!.body,
        ).toBe(old);

        const applied = await run({ apply: true });
        expect(applied.actions.some((a) => a.kind === "change" && /text updated/.test(a.what))).toBe(true);
        const row = (
          await getPool().query<{ id: string; body: string; edited_at: Date | null }>(
            `SELECT id, body, edited_at FROM messages WHERE nonce = $1`,
            [blockNonce],
          )
        ).rows[0]!;
        expect(row.id).toBe(idBefore);
        expect(row.body).toMatch(/Block Me/);
        // A correction by the seed is not shown to anybody as an edit.
        expect(row.edited_at).toBeNull();
        expect(await snapshot()).toEqual(counts);
        expect(applied.serverId).toBe(first.serverId);

        // Idempotent: nothing left to change.
        const third = await run({ apply: true });
        expect(third.actions.some((a) => a.kind === "create" || a.kind === "change")).toBe(false);
      });

      it("adds Block Me to a space that was seeded before it existed", async () => {
        const first = await run({ apply: true });
        // Take the account and its messages away, as an older seed would have left it.
        await getPool().query(`DELETE FROM users WHERE id = $1`, [first.blockMeUserId]);
        await getPool().query(`DELETE FROM character_accounts WHERE label = $1`, [REVIEW_BLOCKME_LABEL]);
        const second = await run({ apply: true });
        expect(second.blockMeUserId).toBeTruthy();
        expect(second.serverId).toBe(first.serverId);
        expect(
          (
            await getPool().query(`SELECT 1 FROM messages WHERE author_id = $1`, [second.blockMeUserId])
          ).rowCount,
        ).toBe(2);
        // Demo Friend, the friendship and the DM were never touched.
        expect(second.friendUserId).toBe(first.friendUserId);
        expect(second.chatState!.after.demoFriendIsFriend).toBe(true);
      });

      it("a dry run on an old seed writes nothing and says Block Me would be made", async () => {
        const before = await snapshot();
        const lines: string[] = [];
        await run({ log: (line: string) => lines.push(line) });
        expect(await snapshot()).toEqual(before);
        expect(lines.join("\n")).toContain(REVIEW_BLOCKME_NAME);
      });

      it("--cleanup takes Block Me with the rest", async () => {
        const seeded = await run({ apply: true });
        await run({ cleanup: true, apply: true });
        expect(
          (await getPool().query(`SELECT 1 FROM users WHERE id = $1`, [seeded.blockMeUserId])).rowCount,
        ).toBe(0);
        expect(
          (await getPool().query(`SELECT 1 FROM character_accounts WHERE label = $1`, [REVIEW_BLOCKME_LABEL]))
            .rowCount,
        ).toBe(0);
      });
    });

    it("every word the seed posts passes pqp's own text filter", () => {
      const bodies = [
        ...REVIEW_MESSAGES.map((m) => m.body),
        ...REVIEW_DM_MESSAGES.map((m) => m.body),
      ];
      for (const body of bodies) {
        expect(findBaselineViolation(body), body).toBeNull();
      }
    });

    it("is idempotent: a second apply changes nothing and reports the same ids", async () => {
      const first = await run({ apply: true });
      const afterFirst = await snapshot();

      const second = await run({ apply: true });
      expect(await snapshot()).toEqual(afterFirst);
      expect(second.serverId).toBe(first.serverId);
      expect(second.friendUserId).toBe(first.friendUserId);
      expect(second.inviteCode).toBe(first.inviteCode);
      expect(second.channels).toEqual(first.channels);
      expect(second.actions.some((a) => a.kind === "create" || a.kind === "change")).toBe(false);

      // Three times, for the lock that must have been released.
      await run({ apply: true });
      expect(await snapshot()).toEqual(afterFirst);
    });

    it("finishes a run that died half way", async () => {
      const first = await run({ apply: true });
      const complete = await snapshot();
      const serverId = first.serverId!;

      // Knock out the friend's membership, one message with its reactions, the
      // invite and #ajuda, as if the process had been killed between steps.
      await getPool().query(`DELETE FROM server_members WHERE server_id = $1 AND user_id = $2`, [
        serverId,
        first.friendUserId,
      ]);
      await getPool().query(`DELETE FROM messages WHERE nonce = $1`, [
        `${REVIEW_NONCE_PREFIX}how-to`,
      ]);
      await getPool().query(`DELETE FROM server_invites WHERE server_id = $1`, [serverId]);
      await getPool().query(`DELETE FROM channels WHERE id = $1`, [first.channels.ajuda]);

      const again = await run({ apply: true });
      expect(again.serverId).toBe(serverId);
      expect(again.friendUserId).toBe(first.friendUserId);
      // Same shape as before (channel and invite ids are new, counts are not).
      expect(await snapshot()).toEqual(complete);
    });

    it("revokes a friend whose token was left live by a run that died", async () => {
      await run({ apply: true });
      await getPool().query(`UPDATE character_accounts SET revoked_at = NULL WHERE label = $1`, [
        REVIEW_FRIEND_LABEL,
      ]);
      const dry = await run();
      expect(dry.actions.some((a) => a.kind === "change" && /not revoked/.test(a.what))).toBe(true);
      const stillLive = await getPool().query(
        `SELECT revoked_at FROM character_accounts WHERE label = $1`,
        [REVIEW_FRIEND_LABEL],
      );
      expect(stillLive.rows[0]!.revoked_at).toBeNull();

      await run({ apply: true });
      const revoked = await getPool().query(
        `SELECT revoked_at FROM character_accounts WHERE label = $1`,
        [REVIEW_FRIEND_LABEL],
      );
      expect(revoked.rows[0]!.revoked_at).not.toBeNull();
    });

    it("ignores another account's private server of the same name", async () => {
      const other = await upsertUser({
        clerkId: "user_test_namesake",
        displayName: "Namesake",
        avatarUrl: null,
      });
      const theirs = await createServer(REVIEW_SERVER_NAME, other.id);
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
        [theirs.server.id, demoId],
      );

      const seeded = await run({ apply: true });
      expect(seeded.serverId).not.toBe(theirs.server.id);
      expect(await getServer(seeded.serverId!)).not.toBeNull();

      await run({ cleanup: true, apply: true, force: true });
      expect(await getServer(seeded.serverId!)).toBeNull();
      expect(await getServer(theirs.server.id)).not.toBeNull();
    });

    it("refuses --force without --cleanup", async () => {
      await expect(run({ force: true })).rejects.toThrow(/--force only means something/);
    });

    it("recreates #geral when the server exists without it", async () => {
      const first = await run({ apply: true });
      await getPool().query(`DELETE FROM channels WHERE id = $1`, [first.channels.geral]);
      const again = await run({ apply: true });
      expect(again.channels.geral).toBeTruthy();
      expect(again.channels.geral).not.toBe(first.channels.geral);
      const n = await getPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM messages WHERE channel_id = $1`,
        [again.channels.geral],
      );
      expect(n.rows[0]!.n).toBe(REVIEW_MESSAGES.filter((m) => m.channel === "geral").length);
    });

    it("lets the demo account block and report the friend", async () => {
      const report = await run({ apply: true });
      const friendId = report.friendUserId!;

      expect(await blockUser(demoId, friendId)).toBe(true);
      expect((await listBlocks(demoId)).map((b) => b.id)).toContain(friendId);

      const userReport = await createReport({
        subjectType: "user",
        reporterId: demoId,
        userId: friendId,
        serverId: report.serverId,
        reason: "spam",
      });
      expect(userReport.duplicate).toBe(false);

      const target = await getPool().query<{ id: string }>(
        `SELECT id FROM messages WHERE nonce = $1`,
        [`${REVIEW_NONCE_PREFIX}report-me`],
      );
      const messageReport = await createReport({
        subjectType: "message",
        reporterId: demoId,
        messageId: target.rows[0]!.id,
        reason: "other",
      });
      expect(messageReport.report.contentSnapshot).toMatch(/test message to report/);
    });

    it("refuses clearly: unknown account, ambiguous arguments, non-person accounts", async () => {
      await expect(runReviewSeed({ clerkId: "user_nobody" })).rejects.toThrow(/No user found/);
      await expect(runReviewSeed({})).rejects.toThrow(ReviewSeedError);
      await expect(
        runReviewSeed({ clerkId: DEMO_CLERK_ID, userId: demoId }),
      ).rejects.toThrow(/exactly one/);
      await expect(runReviewSeed({ userId: demoId, apply: false })).resolves.toMatchObject({
        demoUserId: demoId,
      });
      await getPool().query(`UPDATE users SET is_character = TRUE WHERE id = $1`, [demoId]);
      await expect(run()).rejects.toThrow(/not a person/);
    });

    it("refuses to adopt a server of that name that is public", async () => {
      const made = await createServer(REVIEW_SERVER_NAME, demoId);
      await getPool().query(
        `UPDATE servers SET is_community = TRUE, community_slug = 'review-test' WHERE id = $1`,
        [made.server.id],
      );
      await expect(run({ apply: true })).rejects.toThrow(/must be private/);
    });

    describe("friend and DM", () => {
      async function realPerson(clerkId: string, name: string): Promise<string> {
        return (await upsertUser({ clerkId, displayName: name, avatarUrl: null })).id;
      }

      async function pendingRows(): Promise<number> {
        return (
          await getPool().query(`SELECT 1 FROM friendships WHERE status = 'pending'`)
        ).rowCount!;
      }

      it("makes Demo Friend an accepted friend and opens a DM with five messages", async () => {
        const report = await run({ apply: true });
        const friendId = report.friendUserId!;

        // The friendship row obeys the table's rules and the Friends tab lists it.
        const [low, high] = demoId < friendId ? [demoId, friendId] : [friendId, demoId];
        const row = await getPool().query(
          `SELECT status, requested_by, accepted_at, created_at FROM friendships
            WHERE low_user_id = $1 AND high_user_id = $2`,
          [low, high],
        );
        expect(row.rows[0]).toMatchObject({ status: "accepted", requested_by: friendId });
        expect(row.rows[0]!.accepted_at).not.toBeNull();
        const friendships = await listFriendships(demoId);
        expect(friendships.friends.map((f) => f.displayName)).toEqual([REVIEW_FRIEND_NAME]);
        expect(friendships.incoming).toEqual([]);
        expect(friendships.outgoing).toEqual([]);

        // The conversation: a server-less 'dm' channel, the sorted pair, both members.
        expect(report.dmChannelId).toBeTruthy();
        const channel = await getPool().query(
          `SELECT c.kind, c.server_id, p.low_user_id, p.high_user_id,
                  (SELECT count(*)::int FROM channel_members WHERE channel_id = c.id) AS members
             FROM channels c JOIN dm_pairs p ON p.channel_id = c.id WHERE c.id = $1`,
          [report.dmChannelId],
        );
        expect(channel.rows[0]).toMatchObject({
          kind: "dm",
          server_id: null,
          low_user_id: low,
          high_user_id: high,
          members: 2,
        });

        // Four to six messages, alternating authors, oldest first, spread over days,
        // marked with the nonce no client sends.
        const messages = await getPool().query<{
          author_id: string;
          nonce: string;
          created_at: Date;
          body: string;
        }>(
          `SELECT author_id, nonce, created_at, body FROM messages
            WHERE channel_id = $1 ORDER BY created_at, id`,
          [report.dmChannelId],
        );
        expect(messages.rowCount).toBe(REVIEW_DM_MESSAGES.length);
        expect(messages.rowCount).toBeGreaterThanOrEqual(4);
        expect(messages.rowCount).toBeLessThanOrEqual(6);
        const authors = messages.rows.map((m) => m.author_id);
        authors.forEach((author, i) => {
          expect(author).toBe(i % 2 === 0 ? friendId : demoId);
        });
        expect(messages.rows.every((m) => m.nonce.startsWith(REVIEW_NONCE_PREFIX))).toBe(true);
        const times = messages.rows.map((m) => m.created_at.getTime());
        expect([...times].sort((a, b) => a - b)).toEqual(times);
        const spreadDays = (times.at(-1)! - times[0]!) / 86_400_000;
        expect(spreadDays).toBeGreaterThan(2);
        expect(times[0]!).toBeGreaterThan(Date.now() - 6 * 86_400_000);
        expect(times.at(-1)!).toBeLessThanOrEqual(Date.now());
        expect(messages.rows.some((m) => /Oi!|Tudo bem|Perfeito/.test(m.body))).toBe(true);
        expect(messages.rows.some((m) => /nice to meet|Hi!/.test(m.body))).toBe(true);

        // The Chats tab: the real list query returns it with the last message.
        const chats = await listConversations(demoId);
        expect(chats).toHaveLength(1);
        expect(chats[0]!.channelId).toBe(report.dmChannelId);
        expect(chats[0]!.lastMessage?.preview).toBe(REVIEW_DM_MESSAGES.at(-1)!.body);
        expect(chats[0]!.lastMessage?.authorName).toBe(REVIEW_FRIEND_NAME);

        // ...and the report says so, before and after.
        expect(report.chatState!.before).toMatchObject({
          friends: 0,
          demoFriendIsFriend: false,
          conversations: 0,
          demoFriendDmMessages: 0,
        });
        expect(report.chatState!.after).toMatchObject({
          friends: 1,
          demoFriendIsFriend: true,
          pendingIncoming: 0,
          pendingOutgoing: 0,
          conversations: 1,
          demoFriendDmMessages: REVIEW_DM_MESSAGES.length,
        });
      });

      it("the dry run projects the same end state and writes nothing", async () => {
        const lines: string[] = [];
        const before = await snapshot();
        const dry = await run({ log: (line: string) => lines.push(line) });
        expect(await snapshot()).toEqual(before);
        expect(dry.dmChannelId).toBeNull();
        expect(dry.chatState!.before.friends).toBe(0);
        expect(dry.chatState!.after).toMatchObject({
          friends: 1,
          demoFriendIsFriend: true,
          conversations: 1,
          demoFriendDmMessages: REVIEW_DM_MESSAGES.length,
        });
        const text = lines.join("\n");
        expect(text).toMatch(/before: 0 friend\(s\)/);
        expect(text).toMatch(/after \(projected\): 1 friend\(s\)/);
        expect(text).not.toMatch(/@/);

        // A dry run on top of a finished seed projects "no change".
        await run({ apply: true });
        const dryAgain = await run();
        expect(dryAgain.chatState!.after).toEqual(dryAgain.chatState!.before);
      });

      it("is idempotent: no duplicate friendship, DM or messages, timestamps stay put", async () => {
        const first = await run({ apply: true });
        const afterFirst = await snapshot();
        const stamps = await getPool().query(
          `SELECT id, created_at FROM messages WHERE channel_id = $1 ORDER BY id`,
          [first.dmChannelId],
        );

        const second = await run({ apply: true });
        expect(await snapshot()).toEqual(afterFirst);
        expect(second.dmChannelId).toBe(first.dmChannelId);
        expect(second.actions.some((a) => a.kind === "create" || a.kind === "change")).toBe(false);
        expect(second.chatState!.after).toEqual(second.chatState!.before);
        expect(
          await getPool().query(
            `SELECT id, created_at FROM messages WHERE channel_id = $1 ORDER BY id`,
            [first.dmChannelId],
          ),
        ).toMatchObject({ rows: stamps.rows });
        expect((await listConversations(demoId))).toHaveLength(1);
        expect((await listFriendships(demoId)).friends).toHaveLength(1);
      });

      it("finishes a run that died after the friendship but before the messages", async () => {
        const first = await run({ apply: true });
        const complete = await snapshot();
        await getPool().query(`DELETE FROM messages WHERE channel_id = $1 AND nonce = $2`, [
          first.dmChannelId,
          `${REVIEW_NONCE_PREFIX}dm-3`,
        ]);
        await run({ apply: true });
        expect(await snapshot()).toEqual(complete);
      });

      it("reopens a conversation the reviewer closed", async () => {
        const first = await run({ apply: true });
        expect(await hideConversation(first.dmChannelId!, demoId)).toBe(true);
        expect(await listConversations(demoId)).toHaveLength(0);
        const again = await run({ apply: true });
        expect(again.dmChannelId).toBe(first.dmChannelId);
        expect(await listConversations(demoId)).toHaveLength(1);
      });

      it("does not make friends over a block, and says so", async () => {
        const first = await run({ apply: true });
        await blockUser(demoId, first.friendUserId!);
        expect((await listFriendships(demoId)).friends).toHaveLength(0);
        const again = await run({ apply: true });
        expect(again.actions.some((a) => a.kind === "blocked" && /block stands/.test(a.what))).toBe(
          true,
        );
        expect((await listFriendships(demoId)).friends).toHaveLength(0);
      });

      it("accepts a pending request with Demo Friend instead of failing on it", async () => {
        const first = await run({ apply: true });
        await getPool().query(`DELETE FROM friendships`);
        const [low, high] =
          demoId < first.friendUserId! ? [demoId, first.friendUserId!] : [first.friendUserId!, demoId];
        await getPool().query(
          `INSERT INTO friendships (low_user_id, high_user_id, requested_by) VALUES ($1, $2, $3)`,
          [low, high, demoId],
        );
        const report = await run({ apply: true });
        expect(report.actions.some((a) => a.kind === "change" && /accepted/.test(a.what))).toBe(true);
        const friendships = await listFriendships(demoId);
        expect(friendships.friends.map((f) => f.displayName)).toEqual([REVIEW_FRIEND_NAME]);
        expect(friendships.outgoing).toEqual([]);
      });

      describe("--clear-pending", () => {
        let mallory: string;
        let trent: string;
        let carol: string;
        let bob: string;

        beforeEach(async () => {
          mallory = await realPerson("user_test_mallory", "Mallory");
          trent = await realPerson("user_test_trent", "Trent");
          carol = await realPerson("user_test_carol", "Carol");
          bob = await realPerson("user_test_bob", "Bob");
          // Pending: one sent by the demo account, one received.
          expect(await sendFriendRequest(demoId, mallory)).toBe("pending");
          expect(await sendFriendRequest(trent, demoId)).toBe("pending");
          // An accepted real friendship of the demo account: must survive.
          expect(await sendFriendRequest(demoId, carol)).toBe("pending");
          expect(await acceptFriendRequest(carol, demoId)).toBe(true);
          // Two other accounts with a pending request between them: not ours.
          expect(await sendFriendRequest(bob, mallory)).toBe("pending");
        });

        it("a dry run lists exactly what it would delete and deletes nothing", async () => {
          const lines: string[] = [];
          const before = await snapshot();
          const dry = await run({ clearPending: true, log: (line: string) => lines.push(line) });
          expect(await snapshot()).toEqual(before);
          expect(dry.pendingCleared).toBe(2);
          const text = lines.join("\n");
          expect(text).toMatch(/would delete pending request to "Mallory" \(sent 0 day/);
          expect(text).toMatch(/would delete pending request from "Trent" \(received 0 day/);
          expect(text).not.toMatch(/Bob|Carol/);
          expect(dry.chatState!.before).toMatchObject({ pendingIncoming: 1, pendingOutgoing: 1 });
          expect(dry.chatState!.after).toMatchObject({
            pendingIncoming: 0,
            pendingOutgoing: 0,
            friends: 2,
          });
          expect(await pendingRows()).toBe(3);
        });

        it("without the flag, pending requests are left alone and flagged", async () => {
          const lines: string[] = [];
          const report = await run({ apply: true, log: (line: string) => lines.push(line) });
          expect(report.pendingCleared).toBe(0);
          expect(await pendingRows()).toBe(3);
          expect(lines.join("\n")).toMatch(/2 pending friend request\(s\) left alone/);
        });

        it("apply deletes only the demo account's pending rows", async () => {
          const report = await run({ apply: true, clearPending: true });
          expect(report.pendingCleared).toBe(2);

          const friendships = await listFriendships(demoId);
          expect(friendships.incoming).toEqual([]);
          expect(friendships.outgoing).toEqual([]);
          expect(friendships.friends.map((f) => f.displayName).sort()).toEqual([
            "Carol",
            REVIEW_FRIEND_NAME,
          ]);
          // Bob's request to Mallory is another pair's business.
          expect(await pendingRows()).toBe(1);
          expect(report.chatState!.after).toMatchObject({ pendingIncoming: 0, pendingOutgoing: 0 });

          // Again: nothing to clear, nothing else changes.
          const snap = await snapshot();
          const again = await run({ apply: true, clearPending: true });
          expect(again.pendingCleared).toBe(0);
          expect(await snapshot()).toEqual(snap);
        });

        it("never deletes an accepted row, even one with a person who asked first", async () => {
          await run({ apply: true, clearPending: true });
          const accepted = await getPool().query(
            `SELECT count(*)::int AS n FROM friendships WHERE status = 'accepted'`,
          );
          expect(accepted.rows[0]!.n).toBe(2);
        });

        it("refuses to be combined with --cleanup", async () => {
          await expect(run({ cleanup: true, clearPending: true })).rejects.toThrow(/separate runs/);
        });
      });

      it("--cleanup removes the friendship and the DM with its messages, and nothing real", async () => {
        const carol = await realPerson("user_test_carol", "Carol");
        const bob = await realPerson("user_test_bob", "Bob");
        await sendFriendRequest(demoId, carol);
        await acceptFriendRequest(carol, demoId);
        await getPool().query(`DELETE FROM user_blocks`);
        const realDm = (await openConversation(demoId, [carol])).channelId;
        await createMessage(
          realDm,
          (await getPool().query(`SELECT * FROM users WHERE id = $1`, [demoId])).rows[0],
          "a real message to a real friend",
        );
        const seeded = await run({ apply: true });

        const before = await snapshot();
        const dry = await run({ cleanup: true });
        expect(await snapshot()).toEqual(before);
        expect(dry.actions.some((a) => /would delete the 1:1 conversation/.test(a.what))).toBe(true);
        expect(dry.actions.some((a) => /would delete the friendship/.test(a.what))).toBe(true);

        await run({ cleanup: true, apply: true });
        expect(
          (await getPool().query(`SELECT 1 FROM channels WHERE id = $1`, [seeded.dmChannelId]))
            .rowCount,
        ).toBe(0);
        expect(
          (await getPool().query(`SELECT 1 FROM messages WHERE nonce LIKE $1`, [
            `${REVIEW_NONCE_PREFIX}dm-%`,
          ])).rowCount,
        ).toBe(0);
        expect((await getPool().query(`SELECT 1 FROM dm_pairs`)).rowCount).toBe(1);
        // The real friend and the real conversation are untouched.
        const friendships = await listFriendships(demoId);
        expect(friendships.friends.map((f) => f.displayName)).toEqual(["Carol"]);
        const chats = await listConversations(demoId);
        expect(chats.map((c) => c.channelId)).toEqual([realDm]);
        expect(
          (await getPool().query(`SELECT 1 FROM messages WHERE channel_id = $1`, [realDm])).rowCount,
        ).toBe(1);
        expect(
          (await getPool().query(`SELECT 1 FROM users WHERE id = $1`, [bob])).rowCount,
        ).toBe(1);

        // And it can be seeded again.
        const reseed = await run({ apply: true });
        expect(reseed.dmChannelId).toBeTruthy();
        expect(await listConversations(demoId)).toHaveLength(2);
      });
    });

    describe("--leave-others", () => {
      let qg: string;
      let owned: string;
      let qgMessage: string;

      beforeEach(async () => {
        const stranger = await upsertUser({
          clerkId: "user_test_stranger",
          displayName: "Stranger",
          avatarUrl: null,
        });
        const community = await createServer("Real Community", stranger.id);
        qg = community.server.id;
        await getPool().query(
          `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
          [qg, demoId],
        );
        const text = community.channels.find((c) => c.type === "text")!;
        const stranger2 = (await getPool().query(`SELECT * FROM users WHERE id = $1`, [stranger.id]))
          .rows[0];
        qgMessage = (await createMessage(text.id, stranger2, "hello from the real one"))!.id;
        owned = (await createServer("Owned By Demo", demoId)).server.id;
      });

      it("dry run lists and changes nothing; apply leaves the member server and refuses the owned one", async () => {
        const before = await snapshot();
        const dry = await run({ leaveOthers: true });
        expect(await snapshot()).toEqual(before);
        expect(dry.others.map((o) => [o.name, o.outcome]).sort()).toEqual([
          ["Owned By Demo", "blocked"],
          ["Real Community", "would-leave"],
        ]);

        const done = await run({ leaveOthers: true, apply: true });
        expect(done.others.map((o) => [o.name, o.outcome]).sort()).toEqual([
          ["Owned By Demo", "blocked"],
          ["Real Community", "left"],
        ]);
        expect(done.actions.some((a) => a.kind === "blocked")).toBe(true);

        const ids = (
          await getPool().query<{ server_id: string }>(
            `SELECT server_id FROM server_members WHERE user_id = $1`,
            [demoId],
          )
        ).rows.map((r) => r.server_id);
        expect(ids).not.toContain(qg);
        expect(ids).toContain(owned);
        expect(ids).toContain(done.serverId);

        // Nothing was deleted: the server, its channels and its messages stand.
        expect((await getServer(qg))?.name).toBe("Real Community");
        const kept = await getPool().query(`SELECT 1 FROM messages WHERE id = $1`, [qgMessage]);
        expect(kept.rowCount).toBe(1);
        expect(await getServer(owned)).not.toBeNull();

        // And a re-run has nothing left to leave.
        const again = await run({ leaveOthers: true, apply: true });
        expect(again.others.map((o) => o.outcome)).toEqual(["blocked"]);
      });

      it("never leaves anything without the flag", async () => {
        await run({ apply: true });
        const ids = (await getPool().query<{ server_id: string }>(
          `SELECT server_id FROM server_members WHERE user_id = $1`,
          [demoId],
        )).rows.map((r) => r.server_id);
        expect(ids).toContain(qg);
      });
    });

    describe("the text filter", () => {
      const slur = "you faggot";

      async function settingRows(serverId: string) {
        const result = await getPool().query<{ disabled: boolean }>(
          `SELECT disabled FROM server_text_filter_settings WHERE server_id = $1`,
          [serverId],
        );
        return result.rows;
      }

      beforeEach(() => {
        delete process.env.DEFAULT_TEXT_FILTER;
        invalidateAutomodCache();
      });

      it("is off by default, and a dry run says it would switch it on without writing", async () => {
        const dry = await run();
        const note = dry.actions.find((a) => /text filter/.test(a.what));
        expect(note?.kind).toBe("create");
        expect(note?.what).toMatch(/would be switched ON|switched ON/);
        expect(
          (await getPool().query(`SELECT 1 FROM server_text_filter_settings`)).rowCount,
        ).toBe(0);
        // Seeded, then a dry run reports it as already there.
        await run({ apply: true });
        const again = await run();
        expect(again.actions.find((a) => /text filter/.test(a.what))?.kind).toBe("exists");
      });

      it("--apply turns it on for the review server only, through the owner's switch", async () => {
        const other = await createServer("Untouched", demoId);
        const report = await run({ apply: true });
        expect(await settingRows(report.serverId!)).toEqual([{ disabled: false }]);
        expect(await settingRows(other.server.id)).toEqual([]);

        const status = await getBaselineStatus(report.serverId!);
        expect(status).toEqual({ instanceEnabled: false, ownerChoice: true, enabled: true });
        expect(await getBaselineStatus(other.server.id)).toEqual({
          instanceEnabled: false,
          ownerChoice: null,
          enabled: false,
        });

        // A slur is refused in the review server and lets through anywhere else.
        expect(await checkBaselineText(report.serverId!, slur)).toMatchObject({ baseline: true });
        expect(await checkBaselineText(other.server.id, slur)).toBeNull();
        expect(await checkBaselineText(null, slur)).toBeNull();
        // An insult is not on the list, so it lands even here.
        expect(await checkBaselineText(report.serverId!, "fuck you")).toBeNull();
      });

      it("is idempotent, and switches it back on if an owner turned it off", async () => {
        const first = await run({ apply: true });
        const afterFirst = await snapshot();
        const second = await run({ apply: true });
        expect(await snapshot()).toEqual(afterFirst);
        expect(second.actions.some((a) => a.kind === "create" || a.kind === "change")).toBe(false);
        expect(await settingRows(first.serverId!)).toEqual([{ disabled: false }]);

        await setBaselineEnabled(first.serverId!, false, demoId);
        expect(await settingRows(first.serverId!)).toEqual([{ disabled: true }]);
        const third = await run({ apply: true });
        expect(third.actions.find((a) => /text filter/.test(a.what))?.kind).toBe("change");
        expect(await settingRows(first.serverId!)).toEqual([{ disabled: false }]);
      });

      it("--cleanup takes the setting away with the server", async () => {
        const seeded = await run({ apply: true });
        const other = await createServer("Untouched", demoId);
        await setBaselineEnabled(other.server.id, true, demoId);
        await run({ cleanup: true, apply: true });
        expect(await settingRows(seeded.serverId!)).toEqual([]);
        // Another server's own choice is left exactly as it was.
        expect(await settingRows(other.server.id)).toEqual([{ disabled: false }]);
      });
    });

    describe("--cleanup", () => {
      it("dry run changes nothing; apply removes the server and the friend and nothing else", async () => {
        const seeded = await run({ apply: true });
        const other = await createServer("Untouched", demoId);

        const before = await snapshot();
        const dry = await run({ cleanup: true });
        expect(await snapshot()).toEqual(before);
        expect(dry.actions.some((a) => a.kind === "leave")).toBe(true);

        const done = await run({ cleanup: true, apply: true });
        expect(done.mode).toBe("cleanup");
        expect(await getServer(seeded.serverId!)).toBeNull();
        expect(
          (await getPool().query(`SELECT 1 FROM users WHERE id = $1`, [seeded.friendUserId])).rowCount,
        ).toBe(0);
        expect(
          (await getPool().query(`SELECT 1 FROM character_accounts WHERE label = $1`, [
            REVIEW_FRIEND_LABEL,
          ])).rowCount,
        ).toBe(0);
        // The demo account and its other server are exactly as they were.
        expect(await getServer(other.server.id)).not.toBeNull();
        expect(
          (await getPool().query(`SELECT 1 FROM users WHERE id = $1`, [demoId])).rowCount,
        ).toBe(1);

        // Nothing left, nothing to do, and the seed can be made again.
        const nothing = await run({ cleanup: true, apply: true });
        expect(nothing.actions.map((a) => a.kind)).toEqual(["exists"]);
        const reseed = await run({ apply: true });
        expect(reseed.serverId).not.toBe(seeded.serverId);
      });

      it("deletes a report filed against the friend rather than failing on it", async () => {
        const seeded = await run({ apply: true });
        await createReport({
          subjectType: "user",
          reporterId: demoId,
          userId: seeded.friendUserId!,
          serverId: seeded.serverId,
          reason: "spam",
        });
        await run({ cleanup: true, apply: true });
        expect(await getServer(seeded.serverId!)).toBeNull();
      });

      it("refuses when somebody else has joined, unless forced", async () => {
        const seeded = await run({ apply: true });
        const guest = await upsertUser({
          clerkId: "user_test_guest",
          displayName: "Guest",
          avatarUrl: null,
        });
        await getPool().query(
          `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
          [seeded.serverId, guest.id],
        );
        const refused = await run({ cleanup: true, apply: true });
        expect(refused.actions.some((a) => a.kind === "blocked")).toBe(true);
        expect(await getServer(seeded.serverId!)).not.toBeNull();

        // A refusal changes nothing at all: the friend is still there too.
        expect(
          (await getPool().query(`SELECT 1 FROM users WHERE id = $1`, [seeded.friendUserId])).rowCount,
        ).toBe(1);

        await run({ cleanup: true, apply: true, force: true });
        expect(await getServer(seeded.serverId!)).toBeNull();
        expect(
          (await getPool().query(`SELECT 1 FROM users WHERE id = $1`, [guest.id])).rowCount,
        ).toBe(1);
      });

      it("never deletes a public server that merely shares the name", async () => {
        const made = await createServer(REVIEW_SERVER_NAME, demoId);
        await getPool().query(
          `UPDATE servers SET is_community = TRUE, community_slug = 'review-test' WHERE id = $1`,
          [made.server.id],
        );
        await expect(run({ cleanup: true, apply: true })).rejects.toThrow(/not one this script made/);
        expect(await getServer(made.server.id)).not.toBeNull();
      });

      it("does not combine with --leave-others", async () => {
        await expect(run({ cleanup: true, leaveOthers: true })).rejects.toThrow(/separate runs/);
      });
    });
  });
}

suite("review community seed");

describe("review community seed, with the flags production sets", () => {
  const saved = {
    bus: process.env.CLUSTER_BUS,
    registry: process.env.VOICE_REGISTRY,
  };
  const frames: BusFrame[] = [];
  const evicts: BusFrame[] = [];
  let listener: ReturnType<typeof createPostgresBusTransport> | null = null;

  beforeAll(async () => {
    process.env.CLUSTER_BUS = "postgres";
    process.env.VOICE_REGISTRY = "postgres";
    if (DATABASE_URL) {
      await initDb();
      // A second "instance": it only listens, which is what api-a / api-b do.
      listener = createPostgresBusTransport(DATABASE_URL);
      listener.onFrame((frame) => {
        if (frame.topic === "audience.invalidate") {
          frames.push(frame);
        }
        if (frame.topic === "chat.evict") {
          evicts.push(frame);
        }
      });
      await listener.whenConnected();
    }
  });

  afterAll(async () => {
    await listener?.close();
    await closePool();
    process.env.CLUSTER_BUS = saved.bus;
    process.env.VOICE_REGISTRY = saved.registry;
    if (saved.bus === undefined) delete process.env.CLUSTER_BUS;
    if (saved.registry === undefined) delete process.env.VOICE_REGISTRY;
  });

  afterEach(() => {
    frames.length = 0;
  });

  it("tells the other instance, and still seeds, re-runs and leaves correctly", async () => {
    if (!DATABASE_URL) {
      return;
    }
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    const demo = await upsertUser({
      clerkId: DEMO_CLERK_ID,
      displayName: "AppStore Reviewer",
      avatarUrl: null,
    });
    const stranger = await upsertUser({
      clerkId: "user_test_stranger",
      displayName: "Stranger",
      avatarUrl: null,
    });
    const big = await createServer("Big Room", stranger.id);
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [big.server.id, demo.id],
    );

    const first = await runReviewSeed({
      clerkId: DEMO_CLERK_ID,
      apply: true,
      leaveOthers: true,
    });
    expect(first.others).toMatchObject([{ name: "Big Room", outcome: "left" }]);

    // The listener heard that the review server's audience changed, and that
    // the room the demo account left changed too. Without the script's bus it
    // would have heard nothing and its member lists would be stale.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const heard = frames.map((f) => (f.data as { serverId?: string }).serverId);
    expect(heard).toContain(first.serverId);
    expect(heard).toContain(big.server.id);

    // And that the demo account's open views of the room it left were evicted,
    // as the HTTP leave route does, so a socket on the OTHER instance stops
    // receiving that room's messages.
    const bigChannelIds = (
      await getPool().query<{ id: string }>(`SELECT id FROM channels WHERE server_id = $1`, [
        big.server.id,
      ])
    ).rows.map((r) => r.id);
    const evict = evicts
      .map((f) => f.data as { kind?: string; userId?: string; channelIds?: string[] })
      .find((d) => d.kind === "user" && d.userId === demo.id);
    expect(evict).toBeDefined();
    expect([...evict!.channelIds!].sort()).toEqual([...bigChannelIds].sort());

    const afterFirst = await snapshot();
    const second = await runReviewSeed({
      clerkId: DEMO_CLERK_ID,
      apply: true,
      leaveOthers: true,
    });
    expect(await snapshot()).toEqual(afterFirst);
    expect(second.serverId).toBe(first.serverId);
    expect(second.inviteCode).toBe(first.inviteCode);

    // A dry run opens no bus and writes nothing.
    frames.length = 0;
    await runReviewSeed({ clerkId: DEMO_CLERK_ID });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(frames).toEqual([]);
    expect(await snapshot()).toEqual(afterFirst);

    await runReviewSeed({ clerkId: DEMO_CLERK_ID, cleanup: true, apply: true });
    expect(await getServer(first.serverId!)).toBeNull();
  });
});

describe("seed-review-community argument handling", () => {
  it("parses the documented flags", () => {
    expect(parseArgs(["--clerk-id", "user_x"])).toEqual({ help: false, clerkId: "user_x" });
    expect(
      parseArgs(["--user-id", "abc", "--apply", "--leave-others", "--force"]),
    ).toEqual({ help: false, userId: "abc", apply: true, leaveOthers: true, force: true });
    expect(parseArgs(["--cleanup", "--clerk-id", "u"])).toMatchObject({ cleanup: true });
    expect(parseArgs(["--clerk-id", "u", "--clear-pending"])).toMatchObject({
      clearPending: true,
    });
    expect(parseArgs(["--clerk-id", "u", "--clear-pending"]).apply).toBeUndefined();
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  it("is dry run unless --apply is given", () => {
    expect(parseArgs(["--clerk-id", "user_x"]).apply).toBeUndefined();
  });

  it("rejects what it does not know and values that are missing", () => {
    expect(() => parseArgs(["--email", "a@b.c"])).toThrow(/Unknown argument/);
    expect(() => parseArgs(["--clerk-id"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--clerk-id", "--apply"])).toThrow(/needs a value/);
  });

  it("prints the database as host and name and never the credentials", () => {
    expect(describeDatabase("postgres://pqp:s3cret@db.example.com:5432/pqp?sslmode=require")).toBe(
      "db.example.com:5432/pqp",
    );
    expect(describeDatabase(undefined)).toMatch(/not set/);
    expect(describeDatabase("not a url")).not.toMatch(/not a url/);
  });
});
