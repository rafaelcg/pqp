import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Permission, serializePermissions } from "@pqp/shared";

/**
 * `computeMemberPermissionsForChannels` must be the one-channel answer, for a
 * whole list of channels at once (one membership read, one overwrite read).
 * It exists for the Encaminhar picker, which asks "where may this person
 * speak" over every channel of a server, and a second copy of how an overwrite
 * is picked is how a list starts offering places the send then refuses.
 *
 * So this asserts agreement, not numbers: every (member, channel) pair of a
 * matrix (an owner, an admin, a plain member, a role grant, an `@everyone`
 * deny, a member deny, a private channel, a thread under a restricted parent,
 * a non-member) against `computeMemberPermissions`, failing on the first
 * disagreement.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { createServer, createChannel } = await import("./servers.js");
const { createMessage } = await import("./messages.js");
const { createThreadForMessage } = await import("./threads.js");
const { computeMemberPermissions, computeMemberPermissionsForChannels } = await import(
  "./permissions.js"
);

describeDb("computeMemberPermissionsForChannels", () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  it("agrees with computeMemberPermissions on a matrix of members, channels and threads", async () => {
    const pool = getPool();
    await pool.query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    const make = (name: string) =>
      upsertUser({ clerkId: `clerk_pc_${name}`, displayName: name, avatarUrl: null });
    const owner = await make("owner");
    const admin = await make("admin");
    const plain = await make("plain");
    const vip = await make("vip");
    const denied = await make("denied");
    const stranger = await make("stranger");

    const { server } = await createServer("Matrix", owner.id);
    for (const user of [admin, plain, vip, denied]) {
      await pool.query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, $3)`,
        [server.id, user.id, user === admin ? "admin" : "member"],
      );
    }
    const roles = await pool.query<{ id: string; system_key: string | null; is_everyone: boolean }>(
      `SELECT id, system_key, is_everyone FROM roles WHERE server_id = $1`,
      [server.id],
    );
    const everyone = roles.rows.find((role) => role.is_everyone)!.id;
    const vipRole = roles.rows.find((role) => role.system_key === "vip")!.id;
    await pool.query(
      `INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [server.id, vip.id, vipRole],
    );

    const open = await createChannel(server.id, "open", "text");
    const readOnly = await createChannel(server.id, "read-only", "text");
    const vipSpeaks = await createChannel(server.id, "vip-speaks", "text");
    const privateRoom = await createChannel(server.id, "private", "text", true);
    const voice = await createChannel(server.id, "voice", "voice");

    const overwrite = (
      channelId: string,
      type: "role" | "member",
      targetId: string,
      allow: bigint,
      deny: bigint,
    ) =>
      pool.query(
        `INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (channel_id, target_type, target_id)
         DO UPDATE SET allow = EXCLUDED.allow, deny = EXCLUDED.deny`,
        [channelId, type, targetId, serializePermissions(allow), serializePermissions(deny)],
      );
    await overwrite(readOnly.id, "role", everyone, 0n, Permission.SEND_MESSAGES);
    await overwrite(vipSpeaks.id, "role", everyone, 0n, Permission.SEND_MESSAGES);
    await overwrite(vipSpeaks.id, "role", vipRole, Permission.SEND_MESSAGES, 0n);
    await overwrite(open.id, "member", denied.id, 0n, Permission.SEND_MESSAGES);
    await overwrite(privateRoom.id, "member", plain.id, Permission.VIEW_CHANNEL, 0n);

    // Threads take their parent's overwrites: one under a read-only parent,
    // one under an open channel the `denied` member is muted in.
    const threadIn = async (parentId: string, name: string) => {
      const origin = await createMessage(parentId, owner as never, `origem ${name}`);
      const started = await createThreadForMessage(origin!.id, name, owner.id);
      return started!.thread.channelId;
    };
    const readOnlyThread = await threadIn(readOnly.id, "so-lendo");
    const openThread = await threadIn(open.id, "aberta");

    const refs = [
      ...[open, readOnly, vipSpeaks, privateRoom, voice].map((channel) => ({
        id: channel.id,
        type: channel.type as string | null,
        parent_id: null as string | null,
      })),
      { id: readOnlyThread, type: "thread", parent_id: readOnly.id },
      { id: openThread, type: "thread", parent_id: open.id },
    ];

    for (const person of [owner, admin, plain, vip, denied, stranger]) {
      const bulk = await computeMemberPermissionsForChannels(server.id, person.id, refs);
      expect(bulk.size).toBe(refs.length);
      for (const ref of refs) {
        const single = await computeMemberPermissions(server.id, person.id, ref.id);
        expect(bulk.get(ref.id), `${person.id} in ${ref.id}`).toBe(single);
      }
    }

    // The point of the list: the members of this matrix differ where they should.
    const plainBits = await computeMemberPermissionsForChannels(server.id, plain.id, refs);
    const canSend = (bits: bigint | undefined) => ((bits ?? 0n) & Permission.SEND_MESSAGES) !== 0n;
    expect(canSend(plainBits.get(open.id))).toBe(true);
    expect(canSend(plainBits.get(readOnly.id))).toBe(false);
    expect(canSend(plainBits.get(readOnlyThread))).toBe(false);
    expect(canSend(plainBits.get(openThread))).toBe(true);
    const deniedBits = await computeMemberPermissionsForChannels(server.id, denied.id, refs);
    expect(canSend(deniedBits.get(open.id))).toBe(false);
    expect(canSend(deniedBits.get(openThread))).toBe(false);
    expect(await computeMemberPermissionsForChannels(server.id, plain.id, [])).toEqual(new Map());
  });
});
