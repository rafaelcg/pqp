import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * Who may edit a community's listing panel, over HTTP.
 *
 * The panel carries two decisions that used to be one, and this file exists to
 * pin them apart:
 *
 *  - the PUBLIC ADDRESS (`pqp.gg/c/<slug>`), plus the tagline, category and
 *    language that dress it, is **Manage Server** — the same bit that already
 *    renames the server and replaces its icon. The people who hand out a
 *    community's link are its moderators as often as its owner;
 *  - the DIRECTORY LISTING (`isListed`) is **owner only**, because that is
 *    the switch that makes the room findable and joinable by strangers who were
 *    sent nothing, and the one that attaches the instance's moderation duty
 *    (docs/CONTENT_SAFETY.md §Communities).
 *
 * The listing check runs inside `updateCommunitySettings`' transaction rather
 * than at the route, so what is asserted here is that a patch which does not
 * MOVE the listing is fine from an admin, and one that does is refused with the
 * row untouched.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

let actor: { id: string; clerk_id: string } | null = null;

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser: async () => (actor ? { user: actor } : null),
  resolveAuthSession: async () =>
    actor ? { user: actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");

let server: Server;
let baseUrl: string;

type Actor = { id: string; clerk_id: string };

async function call<T = Record<string, unknown>>(
  as: Actor | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
  };
}

interface SettingsBody {
  community: {
    isCommunity: boolean;
    isListed: boolean;
    slug: string | null;
    tagline: string | null;
    category: string;
    language: string;
    suspended: boolean;
  };
}

describeDb("community settings permissions", () => {
  let owner: Actor;
  let admin: Actor;
  let member: Actor;
  let outsider: Actor;
  let serverId: string;

  beforeAll(async () => {
    await initDb();
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => server.listen(0, done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.COMMUNITIES_ENABLED = "true";
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
    delete process.env.COMMUNITIES_ENABLED;
  });

  beforeEach(async () => {
    resetApiRateLimits();
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels, messages,
                server_members, channel_members, server_invites, server_bans,
                channel_reads, message_mentions, message_reactions,
                message_attachments, user_blocks, dm_pairs, link_embeds,
                audit_log
       RESTART IDENTITY CASCADE`,
    );
    owner = await upsertUser({
      clerkId: "clerk_owner",
      displayName: "Owner",
      avatarUrl: null,
    });
    admin = await upsertUser({
      clerkId: "clerk_admin",
      displayName: "Admin",
      avatarUrl: null,
    });
    member = await upsertUser({
      clerkId: "clerk_member",
      displayName: "Member",
      avatarUrl: null,
    });
    outsider = await upsertUser({
      clerkId: "clerk_outsider",
      displayName: "Outsider",
      avatarUrl: null,
    });
    const created = await call<{ server: { id: string } }>(
      owner,
      "POST",
      "/api/servers",
      { name: "MoonKase" },
    );
    expect(created.status).toBe(201);
    serverId = created.body.server.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role)
       VALUES ($1, $2, 'admin'), ($1, $3, 'member')`,
      [serverId, admin.id, member.id],
    );
  });

  /** Both switches on, which is what the old single switch used to mean. */
  async function listedByOwner() {
    const res = await call<SettingsBody>(
      owner,
      "PATCH",
      `/api/servers/${serverId}/community`,
      { isCommunity: true, isListed: true },
    );
    expect(res.status).toBe(200);
    return res.body.community;
  }

  describe("reading the panel", () => {
    it("opens for Manage Server, not just for the owner", async () => {
      const asAdmin = await call<SettingsBody>(
        admin,
        "GET",
        `/api/servers/${serverId}/community`,
      );
      expect(asAdmin.status).toBe(200);
      expect(asAdmin.body.community.isCommunity).toBe(false);
    });

    it("is refused for a plain member and invisible to an outsider", async () => {
      const asMember = await call(
        member,
        "GET",
        `/api/servers/${serverId}/community`,
      );
      expect(asMember.status).toBe(403);

      // 404 rather than 403: a non-member must not be able to probe which
      // server ids exist.
      const asOutsider = await call(
        outsider,
        "GET",
        `/api/servers/${serverId}/community`,
      );
      expect(asOutsider.status).toBe(404);
    });
  });

  describe("the public address", () => {
    it("is an admin's to set, and reaches the public page", async () => {
      await listedByOwner();

      const patched = await call<SettingsBody>(
        admin,
        "PATCH",
        `/api/servers/${serverId}/community`,
        { slug: "moonkase", tagline: "Sala da moonkase" },
      );
      expect(patched.status).toBe(200);
      expect(patched.body.community.slug).toBe("moonkase");
      expect(patched.body.community.tagline).toBe("Sala da moonkase");

      // The unauthenticated page is the whole point of the address, so the
      // admin's write has to be the one a stranger reads.
      const page = await fetch(`${baseUrl}/api/public/communities/moonkase`);
      expect(page.status).toBe(200);
      const body = (await page.json()) as {
        community: { name: string; tagline: string | null };
      };
      expect(body.community.name).toBe("MoonKase");
      expect(body.community.tagline).toBe("Sala da moonkase");
    });

    it("is not a plain member's to set", async () => {
      await listedByOwner();
      const refused = await call(
        member,
        "PATCH",
        `/api/servers/${serverId}/community`,
        { slug: "nao-vai" },
      );
      expect(refused.status).toBe(403);
      const after = await call<SettingsBody>(
        owner,
        "GET",
        `/api/servers/${serverId}/community`,
      );
      expect(after.body.community.slug).not.toBe("nao-vai");
    });

    it("names the admin in the audit trail, not the owner", async () => {
      await listedByOwner();
      await call(admin, "PATCH", `/api/servers/${serverId}/community`, {
        slug: "moonkase-oficial",
      });
      const log = await call<{
        entries: { action: string; actorId: string }[];
      }>(owner, "GET", `/api/servers/${serverId}/audit-log`);
      const entry = log.body.entries.find(
        (e) => e.action === "server.community_update" && e.actorId === admin.id,
      );
      expect(entry).toBeDefined();
    });
  });

  describe("the directory listing", () => {
    it("is refused to an admin, and the row does not move", async () => {
      // The address first, which an admin may do, so the refusal below is
      // about the directory alone and not about the missing prerequisite.
      await call(admin, "PATCH", `/api/servers/${serverId}/community`, {
        isCommunity: true,
      });
      const refused = await call<{ error?: string }>(
        admin,
        "PATCH",
        `/api/servers/${serverId}/community`,
        { isListed: true, tagline: "abrindo pro mundo" },
      );
      expect(refused.status).toBe(403);

      const after = await call<SettingsBody>(
        owner,
        "GET",
        `/api/servers/${serverId}/community`,
      );
      expect(after.body.community.isListed).toBe(false);
      // The whole patch rolled back, tagline included: half of a refused write
      // landing is the shape of a bug nobody can see from the panel.
      expect(after.body.community.tagline).toBeNull();
    });

    it("is refused to an admin unlisting a live community", async () => {
      await listedByOwner();
      const refused = await call(
        admin,
        "PATCH",
        `/api/servers/${serverId}/community`,
        { isListed: false },
      );
      expect(refused.status).toBe(403);
      const after = await call<SettingsBody>(
        owner,
        "GET",
        `/api/servers/${serverId}/community`,
      );
      expect(after.body.community.isListed).toBe(true);
    });

    it("is refused to an admin emptying the address underneath it", async () => {
      await listedByOwner();
      // The sideways route to the same outcome: no address, no listing. The
      // refusal names it, because "you cannot do that" about a switch the
      // admin never touched is the confusing half.
      const refused = await call<{ error?: string }>(
        admin,
        "PATCH",
        `/api/servers/${serverId}/community`,
        { isCommunity: false },
      );
      expect(refused.status).toBe(403);
      expect(refused.body.error).toMatch(/directory/i);
      const after = await call<SettingsBody>(
        owner,
        "GET",
        `/api/servers/${serverId}/community`,
      );
      expect(after.body.community.isCommunity).toBe(true);
      expect(after.body.community.isListed).toBe(true);
    });

    it("lets an admin resend the value it already has", async () => {
      await listedByOwner();
      // An older client sends the whole form. Repeating the listing value is
      // not an attempt to flip it and must not fail, or every admin save on a
      // stale tab becomes a 403 about a switch they never touched.
      const patched = await call<SettingsBody>(
        admin,
        "PATCH",
        `/api/servers/${serverId}/community`,
        { isCommunity: true, isListed: true, tagline: "mesma coisa" },
      );
      expect(patched.status).toBe(200);
      expect(patched.body.community.tagline).toBe("mesma coisa");
    });

    it("is the owner's, both ways", async () => {
      const on = await listedByOwner();
      expect(on.isListed).toBe(true);
      // Derived from the name on the transition into listed.
      expect(on.slug).toBe("moonkase");

      const off = await call<SettingsBody>(
        owner,
        "PATCH",
        `/api/servers/${serverId}/community`,
        { isListed: false },
      );
      expect(off.status).toBe(200);
      expect(off.body.community.isListed).toBe(false);
      // The address survives leaving the directory. That is the split.
      expect(off.body.community.isCommunity).toBe(true);
      // Unlisting keeps the address on the row, as it always has.
      expect(off.body.community.slug).toBe("moonkase");
    });
  });
});
