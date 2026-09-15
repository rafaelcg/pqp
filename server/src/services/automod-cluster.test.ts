import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createMemoryHub } from "../lib/bus.js";

/**
 * AUTOMOD ON TWO MACHINES.
 *
 * Both halves of this module were per-process, and both of them are wrong the
 * moment a second `pqp-api` machine exists:
 *
 *  (1) The rule cache holds a server's list for 30 s. An owner editing the
 *      list dropped the entry on the machine their request landed on, and the
 *      OTHER machine went on enforcing yesterday's list for the rest of its
 *      TTL — a word filter half the members trip and half no longer do,
 *      depending on which machine the proxy picked for them.
 *  (2) The alert cooldown is one post per author per server per ten seconds,
 *      and it lived in a `Map`. Two machines, two maps, two copies of the same
 *      embed in #mod-log, and a flood gets one copy per machine per window.
 *
 * Two real module graphs over one memory hub, on a real Postgres, because the
 * cooldown's arbiter is a conditional UPSERT and a fake cannot serialise
 * anything.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

type BusModule = typeof import("../lib/bus.js");
type AutomodModule = typeof import("./automod.js");
type DbModule = typeof import("../db.js");

interface Instance {
  bus: BusModule;
  automod: AutomodModule;
  db: DbModule;
}

/** Flipped by the one test that needs the post to land and the read to fail. */
const hydrationFails = { now: false };
vi.mock("./messages.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./messages.js")>();
  return {
    ...actual,
    getHydratedMessage: async (id: string) => {
      if (hydrationFails.now) {
        throw new Error("hydration is down");
      }
      return actual.getHydratedMessage(id);
    },
  };
});

const hub = createMemoryHub();
const booted: Instance[] = [];

async function bootInstance(): Promise<Instance> {
  vi.resetModules();
  const bus = (await import("../lib/bus.js")) as BusModule;
  const db = (await import("../db.js")) as DbModule;
  const automod = (await import("./automod.js")) as AutomodModule;
  bus.setBusTransport(bus.createMemoryTransport(hub));
  const instance = { bus, automod, db };
  booted.push(instance);
  return instance;
}

describeDb("automod across two machines", () => {
  let alpha: Instance;
  let beta: Instance;
  let serverId: string;
  let chatId: string;
  let modLogId: string;
  let authorId: string;

  beforeAll(async () => {
    vi.resetModules();
    const db = (await import("../db.js")) as DbModule;
    await db.initDb();
    await db.closePool();
  });

  afterAll(async () => {
    for (const instance of booted) {
      await instance.db.closePool().catch(() => {});
    }
  });

  beforeEach(async () => {
    alpha = await bootInstance();
    beta = await bootInstance();
    const pool = alpha.db.getPool();
    await pool.query(
      `TRUNCATE users, servers, channels, messages, automod_rules,
                automod_alert_cooldowns, audit_log, member_roles, roles
       RESTART IDENTITY CASCADE`,
    );
    const owner = await pool.query<{ id: string }>(
      `INSERT INTO users (clerk_id, display_name) VALUES ('clerk_am_owner', 'Dono')
       RETURNING id`,
    );
    const author = await pool.query<{ id: string }>(
      `INSERT INTO users (clerk_id, display_name) VALUES ('clerk_am_author', 'Membro')
       RETURNING id`,
    );
    authorId = author.rows[0]!.id;
    const server = await pool.query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('hall', $1) RETURNING id`,
      [owner.rows[0]!.id],
    );
    serverId = server.rows[0]!.id;
    const channels = await pool.query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position)
       VALUES ($1, 'geral', 'text', 0), ($1, 'mod-log', 'text', 1)
       RETURNING id`,
      [serverId],
    );
    chatId = channels.rows[0]!.id;
    modLogId = channels.rows[1]!.id;
  });

  afterEach(async () => {
    for (const instance of booted.splice(0)) {
      instance.automod.resetAutomodAlertCooldown();
      instance.automod.resetAutomodUser();
      await instance.bus.closeBus().catch(() => {});
      await instance.db.closePool().catch(() => {});
    }
  });

  it("(1) an edit on one machine drops the other machine's rule cache", async () => {
    const rule = await alpha.automod.createAutomodRule(serverId, {
      kind: "keywords",
      enabled: true,
      keywords: ["bolacha"],
      allowList: [],
      mentionLimit: 5,
      exemptRoleIds: [],
      exemptChannelIds: [],
      customMessage: "",
      alertChannelId: null,
      timeoutMinutes: 0,
      blockPqpInvites: false,
    });

    const check = () =>
      beta.automod.checkAutomod({
        serverId,
        channelId: chatId,
        authorId,
        memberPerms: 0n,
        body: "isso e uma bolacha",
      });

    // Beta reads the rule and caches it.
    expect(await check()).not.toBeNull();

    // Alpha turns it off. Without the relay beta answers from its cache for
    // another CACHE_TTL_MS (30 s) and goes on refusing the word.
    await alpha.automod.updateAutomodRule(serverId, rule.id, { enabled: false });

    // The memory hub delivers synchronously, so by the time the write above
    // returned beta had already dropped its entry.
    expect(await check()).toBeNull();
  });

  it("(2) only one of the two machines posts the alert inside the window", async () => {
    const rule = await alpha.automod.createAutomodRule(serverId, {
      kind: "keywords",
      enabled: true,
      keywords: ["bolacha"],
      allowList: [],
      mentionLimit: 5,
      exemptRoleIds: [],
      exemptChannelIds: [],
      customMessage: "",
      alertChannelId: modLogId,
      timeoutMinutes: 0,
      blockPqpInvites: false,
    });
    expect(rule.alertChannelId).toBe(modLogId);

    const hit = { kind: "keywords" as const, matched: "bolacha", ruleId: rule.id };
    const input = {
      serverId,
      channelId: chatId,
      authorId,
      memberPerms: 0n,
      body: "bolacha",
    };

    // The same author's next blocked message lands on the other machine, which
    // is exactly what a proxy with no session affinity does.
    const first = await alpha.automod.recordAutomodHit(input, hit);
    const second = await beta.automod.recordAutomodHit(input, hit);

    expect(first.alert).not.toBeNull();
    expect(second.alert).toBeNull();

    const posts = await alpha.db
      .getPool()
      .query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM messages WHERE channel_id = $1`,
        [modLogId],
      );
    expect(posts.rows[0]!.count).toBe("1");

    // Both hits are still audited: the cooldown silences the post, never the
    // record of what happened.
    const audits = await alpha.db
      .getPool()
      .query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM audit_log
          WHERE server_id = $1 AND action = 'automod.block'`,
        [serverId],
      );
    expect(audits.rows[0]!.count).toBe("2");
  });

  it("(2c) a failed alert post gives the window back instead of silencing the next one", async () => {
    const rule = await alpha.automod.createAutomodRule(serverId, {
      kind: "keywords",
      enabled: true,
      keywords: ["bolacha"],
      allowList: [],
      mentionLimit: 5,
      exemptRoleIds: [],
      exemptChannelIds: [],
      customMessage: "",
      alertChannelId: modLogId,
      timeoutMinutes: 0,
      blockPqpInvites: false,
    });
    const hit = { kind: "keywords" as const, matched: "bolacha", ruleId: rule.id };
    const input = {
      serverId,
      channelId: chatId,
      authorId,
      memberPerms: 0n,
      body: "bolacha",
    };

    // The alert channel is deleted between the claim and the insert, which is
    // one of the ways the post can fail for real (the FK refuses it).
    await alpha.db
      .getPool()
      .query(`DELETE FROM channels WHERE id = $1`, [modLogId]);
    const failed = await alpha.automod.recordAutomodHit(input, hit);
    expect(failed.alert).toBeNull();

    // Nothing was posted, so nothing is owed a cooldown: the row is gone and
    // the next hit is free to try again immediately.
    const rows = await alpha.db
      .getPool()
      .query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM automod_alert_cooldowns
          WHERE server_id = $1 AND author_id = $2`,
        [serverId, authorId],
      );
    expect(rows.rows[0]!.count).toBe("0");
  });

  it("(2d) a post that landed keeps its window even when the read back fails", async () => {
    const rule = await alpha.automod.createAutomodRule(serverId, {
      kind: "keywords",
      enabled: true,
      keywords: ["bolacha"],
      allowList: [],
      mentionLimit: 5,
      exemptRoleIds: [],
      exemptChannelIds: [],
      customMessage: "",
      alertChannelId: modLogId,
      timeoutMinutes: 0,
      blockPqpInvites: false,
    });
    const hit = { kind: "keywords" as const, matched: "bolacha", ruleId: rule.id };
    const input = {
      serverId,
      channelId: chatId,
      authorId,
      memberPerms: 0n,
      body: "bolacha",
    };

    // The embed is inserted and the read back throws. The moderators HAVE the
    // alert; only the live delivery of it is lost.
    hydrationFails.now = true;
    const first = await alpha.automod.recordAutomodHit(input, hit);
    hydrationFails.now = false;
    expect(first.alert).toBeNull();

    const posts = await alpha.db
      .getPool()
      .query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM messages WHERE channel_id = $1`,
        [modLogId],
      );
    expect(posts.rows[0]!.count).toBe("1");

    // SO THE WINDOW STANDS. Releasing it here — the failure looks identical
    // from inside the catch — is how #mod-log gets the same embed twice.
    beta.automod.resetAutomodAlertCooldown();
    const second = await beta.automod.recordAutomodHit(input, hit);
    expect(second.alert).toBeNull();
    const after = await alpha.db
      .getPool()
      .query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM messages WHERE channel_id = $1`,
        [modLogId],
      );
    expect(after.rows[0]!.count).toBe("1");
  });

  it("(2b) the window is the row's: a machine that never heard the frame still refuses", async () => {
    const rule = await alpha.automod.createAutomodRule(serverId, {
      kind: "keywords",
      enabled: true,
      keywords: ["bolacha"],
      allowList: [],
      mentionLimit: 5,
      exemptRoleIds: [],
      exemptChannelIds: [],
      customMessage: "",
      alertChannelId: modLogId,
      timeoutMinutes: 0,
      blockPqpInvites: false,
    });
    const hit = { kind: "keywords" as const, matched: "bolacha", ruleId: rule.id };
    const input = {
      serverId,
      channelId: chatId,
      authorId,
      memberPerms: 0n,
      body: "bolacha",
    };

    await alpha.automod.recordAutomodHit(input, hit);
    // The bus frame is lost (a blip, a reconnect): beta's own map knows
    // nothing. The conditional UPSERT is what refuses it.
    beta.automod.resetAutomodAlertCooldown();
    const second = await beta.automod.recordAutomodHit(input, hit);
    expect(second.alert).toBeNull();
  });
});
