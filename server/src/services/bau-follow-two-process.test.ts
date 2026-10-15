import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * EXACTLY ONCE ACROSS PROCESSES. Two Node processes (this one and a child, the
 * API and the worker of a split deployment) run the delivery tick against one
 * database at the same instant, over forty follows of one published post. The
 * claim, the claim-guarded transaction and the unique nonce have to give each
 * channel exactly one card, however the two interleave. A single process cannot
 * show this: its own overlap guard would serialise the ticks.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
// The flags the child reads from its environment (it never loads the table).
process.env.COMMUNITY_HOME_ENABLED = "true";
process.env.BAU_FOLLOW = "true";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = join(SERVER_DIR, "node_modules", ".bin", "tsx");

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { createServer: createChatServer, createChannel } = await import("./servers.js");
const { runBauFollowTick } = await import("./bau-follow-delivery.js");

const FOLLOWS = 40;

describeDb("Seguir across two processes", () => {
  beforeAll(async () => {
    await initDb();
  });
  afterAll(async () => {
    await closePool();
  });

  it("delivers each (post, follow) exactly once while two processes tick together", async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    const owner = await upsertUser({ clerkId: "clerk_bf2_owner", displayName: "owner", avatarUrl: null });
    const qg = await createChatServer("QG", owner.id);
    await getPool().query(`UPDATE servers SET community_home_enabled = TRUE, bau_follow_allowed = TRUE WHERE id = $1`, [qg.server.id]);
    const dest = await createChatServer("Galera", owner.id);
    for (let i = 0; i < FOLLOWS; i += 1) {
      const channel = await createChannel(dest.server.id, `c${i}`, "text", false);
      await getPool().query(
        `INSERT INTO bau_follows (source_server_id, target_server_id, target_channel_id, created_by)
         VALUES ($1, $2, $3, $4)`,
        [qg.server.id, dest.server.id, channel.id, owner.id],
      );
    }
    await getPool().query(
      `INSERT INTO community_home_posts (server_id, author_id, title, body, visibility, status, published_at)
       VALUES ($1, $2, 'Sessão 11', 'o clip inteiro', 'free', 'published', NOW())`,
      [qg.server.id, owner.id],
    );

    const startAt = Date.now() + 2500;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BAU_TICK_START_AT: String(startAt),
      BAU_TICK_ROUNDS: "4",
    };
    delete env.VITEST;
    delete env.VITEST_WORKER_ID;
    delete env.VITEST_POOL_ID;
    const child = spawn(TSX, ["src/services/bau-follow-tick-child.ts"], {
      cwd: SERVER_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (out += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));

    while (Date.now() < startAt) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    // The batch is smaller than the follows, so the two have to share rounds.
    let mine = 0;
    for (let i = 0; i < 4; i += 1) {
      mine += (await runBauFollowTick()).delivered;
    }
    expect(await exited).toBe(0);
    const theirs = Number(/CHILD_DELIVERED (\d+)/.exec(out)?.[1] ?? "NaN");
    expect(theirs, out).not.toBeNaN();

    const cards = await getPool().query<{ channel_id: string; n: number }>(
      `SELECT channel_id, count(*)::int AS n FROM messages WHERE forward IS NOT NULL GROUP BY channel_id`,
    );
    expect(cards.rows).toHaveLength(FOLLOWS);
    expect(cards.rows.every((row) => row.n === 1)).toBe(true);
    const rows = await getPool().query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM bau_follow_deliveries GROUP BY status`,
    );
    expect(rows.rows).toEqual([{ status: "delivered", n: FOLLOWS }]);
    // Between them they did exactly the work there was.
    expect(mine + theirs).toBe(FOLLOWS);
  }, 60_000);
});
