import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * SSO domain joins, against a real database.
 *
 * This is an *authorization* path — it lets someone into a private server with
 * no invite and nobody's approval — so the cases that matter most here are the
 * ones that must be refused. The domain comparison itself is unit-tested in
 * `@pqp/shared`; what these cover is the SQL actually agreeing with it, which
 * is the half a pure test cannot reach.
 */

// TEST_DATABASE_URL wins — see the note in api.test.ts.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const {
  createServer,
  joinServerBySso,
  listSsoJoinableServers,
  updateSsoEmailDomain,
} = await import("./servers.js");
const { banMember } = await import("./moderation.js");

describeDb("SSO domain joins", () => {
  let owner: { id: string };
  let acmeEmployee: { id: string };
  let outsider: { id: string };
  let serverId: string;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);

    owner = await upsertUser({
      clerkId: "clerk_owner",
      displayName: "Owner",
      avatarUrl: null,
      emailDomains: ["acme.com"],
    });
    acmeEmployee = await upsertUser({
      clerkId: "clerk_employee",
      displayName: "Employee",
      avatarUrl: null,
      emailDomains: ["acme.com"],
    });
    outsider = await upsertUser({
      clerkId: "clerk_outsider",
      displayName: "Outsider",
      avatarUrl: null,
      emailDomains: ["evil.test"],
    });

    const created = await createServer("Acme", owner.id);
    serverId = created.server.id;
    await updateSsoEmailDomain(serverId, "acme.com");
  });

  it("lets a matching verified domain join without an invite", async () => {
    const result = await joinServerBySso(serverId, acmeEmployee.id);
    expect(result.ok).toBe(true);
    expect(result.ok && result.joinedNow).toBe(true);

    const membership = await getPool().query(
      `SELECT role FROM server_members WHERE server_id = $1 AND user_id = $2`,
      [serverId, acmeEmployee.id],
    );
    expect(membership.rows[0]?.role).toBe("member");
  });

  it("refuses a non-matching domain", async () => {
    const result = await joinServerBySso(serverId, outsider.id);
    expect(result).toEqual({ ok: false, reason: "domain_mismatch" });

    const membership = await getPool().query(
      `SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2`,
      [serverId, outsider.id],
    );
    expect(membership.rows).toHaveLength(0);
  });

  it("refuses a user with no verified domains at all", async () => {
    const unverified = await upsertUser({
      clerkId: "clerk_unverified",
      displayName: "Unverified",
      avatarUrl: null,
      // What an account with only unverified addresses produces.
      emailDomains: [],
    });
    const result = await joinServerBySso(serverId, unverified.id);
    expect(result).toEqual({ ok: false, reason: "domain_mismatch" });
  });

  it("refuses everyone once the domain is cleared", async () => {
    await updateSsoEmailDomain(serverId, null);
    const result = await joinServerBySso(serverId, acmeEmployee.id);
    expect(result).toEqual({ ok: false, reason: "domain_mismatch" });
  });

  it("refuses a subdomain and a lookalike, in SQL and not just in the helper", async () => {
    const subdomain = await upsertUser({
      clerkId: "clerk_sub",
      displayName: "Sub",
      avatarUrl: null,
      emailDomains: ["mail.acme.com"],
    });
    const lookalike = await upsertUser({
      clerkId: "clerk_lookalike",
      displayName: "Lookalike",
      avatarUrl: null,
      // The two shapes a LIKE or suffix match in SQL would wrongly admit.
      emailDomains: ["acme.com.evil.test", "evil-acme.com"],
    });

    expect(await joinServerBySso(serverId, subdomain.id)).toEqual({
      ok: false,
      reason: "domain_mismatch",
    });
    expect(await joinServerBySso(serverId, lookalike.id)).toEqual({
      ok: false,
      reason: "domain_mismatch",
    });
  });

  it("still refuses a banned user whose domain matches", async () => {
    await banMember(serverId, acmeEmployee.id, owner.id, null);
    const result = await joinServerBySso(serverId, acmeEmployee.id);
    expect(result).toEqual({ ok: false, reason: "banned" });
  });

  it("is idempotent — a second join does not duplicate or re-log", async () => {
    await joinServerBySso(serverId, acmeEmployee.id);
    const second = await joinServerBySso(serverId, acmeEmployee.id);
    expect(second.ok).toBe(true);
    // The flag the route keys its audit entry off, so a refresh does not
    // write a second "joined" line.
    expect(second.ok && second.joinedNow).toBe(false);

    const memberships = await getPool().query(
      `SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2`,
      [serverId, acmeEmployee.id],
    );
    expect(memberships.rows).toHaveLength(1);
  });

  it("matches on a non-primary verified domain", async () => {
    const dualEmail = await upsertUser({
      clerkId: "clerk_dual",
      displayName: "Dual",
      avatarUrl: null,
      emailDomains: ["acme.com", "gmail.com"],
    });
    const result = await joinServerBySso(serverId, dualEmail.id);
    expect(result.ok).toBe(true);
  });

  it("revokes access when the verifying address goes away", async () => {
    // Re-authenticating after removing the work address rewrites the column.
    await upsertUser({
      clerkId: "clerk_employee",
      displayName: "Employee",
      avatarUrl: null,
      emailDomains: ["gmail.com"],
    });
    const result = await joinServerBySso(serverId, acmeEmployee.id);
    expect(result).toEqual({ ok: false, reason: "domain_mismatch" });
  });

  it("reports an unknown server the same way as a mismatch", async () => {
    const result = await joinServerBySso(
      "00000000-0000-0000-0000-000000000000",
      acmeEmployee.id,
    );
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  describe("listSsoJoinableServers", () => {
    it("lists a server the caller's domain admits", async () => {
      const servers = await listSsoJoinableServers(acmeEmployee.id);
      expect(servers.map((s) => s.id)).toEqual([serverId]);
    });

    it("omits servers the caller already belongs to", async () => {
      await joinServerBySso(serverId, acmeEmployee.id);
      expect(await listSsoJoinableServers(acmeEmployee.id)).toEqual([]);
      // The owner is a member by construction, so it never suggests their own.
      expect(await listSsoJoinableServers(owner.id)).toEqual([]);
    });

    it("omits servers the caller is banned from", async () => {
      await banMember(serverId, acmeEmployee.id, owner.id, null);
      expect(await listSsoJoinableServers(acmeEmployee.id)).toEqual([]);
    });

    it("omits everything for a non-matching domain", async () => {
      expect(await listSsoJoinableServers(outsider.id)).toEqual([]);
    });

    it("omits servers with the feature off", async () => {
      await updateSsoEmailDomain(serverId, null);
      expect(await listSsoJoinableServers(acmeEmployee.id)).toEqual([]);
    });
  });
});
