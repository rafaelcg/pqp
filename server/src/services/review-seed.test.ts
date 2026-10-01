import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Permission } from "@pqp/shared";
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
const {
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
        new Set([demoId, friendId]),
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
