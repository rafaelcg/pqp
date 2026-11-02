import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isPixCopiaECola } from "@pqp/shared";

/**
 * Baú+ payments end to end on a real Postgres, through the real router, with
 * only the identity layer stubbed. FLAGS ARE SET THE WAY PRODUCTION SETS THEM
 * (pitfall 12): the Baú as a global row, VIP and `bau_payments` as per-server
 * overrides from the dashboard path, never an env var.
 *
 * Pinned:
 *   - off means off: no offer, no checkout, for a self-host with no provider too;
 *   - a checkout is idempotent (one code per method while it is good);
 *   - a webhook with a bad signature is refused; one delivered twice applies once;
 *   - paid grants the server's own VIP role; refund, expiry and cancel at the
 *     end of the month take it back, and never a VIP staff gave by hand;
 *   - paid beats expired ("pagou mas demorou");
 *   - the monthly clock: reminder once, grace, expired;
 *   - a fan who left and came back while paid gets VIP again; one staff
 *     stripped on purpose does not.
 *
 * Scratch database only: set TEST_DATABASE_URL to a throwaway copy.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
process.env.BAU_PAYMENTS_PROVIDER = "sandbox";
process.env.BAU_PAYMENTS_SANDBOX_AUTOPAY_SECONDS = "0";
delete process.env.BAU_PAYMENTS;
delete process.env.COMMUNITY_HOME_ENABLED;
delete process.env.COMMUNITY_HOME_VIP_ENABLED;

let actor: { id: string; clerk_id: string } | null = null;

vi.mock("../../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser: async () => (actor ? { user: actor } : null),
  resolveAuthSession: async () => (actor ? { user: actor, ageGate: "passed" as const } : null),
  verifyAuthHeader: async () => null,
}));

const { getPool, initDb, closePool } = await import("../../db.js");
const { handleApi, resetApiRateLimits } = await import("../../api/index.js");
const { upsertUser } = await import("../users.js");
const { createServer: createChatServer } = await import("../servers.js");
const flags = await import("../../lib/flags.js");
const { signSandboxBody, SANDBOX_SIGNATURE_HEADER } = await import("./sandbox-provider.js");
const { sweepBauPayments } = await import("./sweep.js");
const { resetBauPaymentsForTests, connectSandboxPayout, applyCharge } = await import("./service.js");
const { bauPaymentsMetrics, resetBauPaymentsMetricsForTests } = await import("./metrics.js");

type Person = { id: string; clerk_id: string };

let httpServer: Server;
let baseUrl: string;

async function call<T = Record<string, unknown>>(
  as: Person,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function postWebhook(body: unknown, signature?: string) {
  const raw = JSON.stringify(body);
  const response = await fetch(`${baseUrl}/api/bau-plus/webhooks/sandbox`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [SANDBOX_SIGNATURE_HEADER]: signature ?? signSandboxBody(raw),
    },
    body: raw,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

interface Offer {
  enabled: boolean;
  plan: { id: string; priceCents: number } | null;
  seller: { name: string } | null;
  methods: string[];
  sandbox: boolean;
  membership: Membership | null;
}
interface Attempt {
  id: string;
  status: string;
  pixCode: string | null;
  expiresAt: string;
  failureReason: string | null;
  kind: string;
}
interface Membership {
  id: string;
  status: string;
  hasAccess: boolean;
  periodEnd: string | null;
  refundableUntil: string | null;
  renewalDue: boolean;
  receipts: { status: string; sellerName: string }[];
  pendingAttempt: Attempt | null;
}

describeDb("Baú+ payments", () => {
  let owner: Person;
  let fan: Person;
  let other: Person;
  let serverId: string;
  let planId: string;

  beforeAll(async () => {
    await initDb();
    httpServer = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    flags.resetFeatureFlagsForTests();
    await closePool();
  });

  async function turnOn(id: string): Promise<void> {
    const dashboard = { kind: "dashboard" } as const;
    await flags.setGlobalFlag("community_home", true, dashboard);
    if (flags.FEATURE_FLAGS.community_home_vip.perServer) {
      await flags.setServerFlagOverride("community_home_vip", id, true, dashboard);
    } else {
      await flags.setGlobalFlag("community_home_vip", true, dashboard);
    }
    await flags.setServerFlagOverride("bau_payments", id, true, dashboard);
    await flags.reloadFeatureFlags();
  }

  beforeEach(async () => {
    resetApiRateLimits();
    resetBauPaymentsForTests();
    resetBauPaymentsMetricsForTests();
    flags.resetFeatureFlagsForTests();
    await getPool().query(
      `TRUNCATE users, servers, feature_flags, feature_flag_overrides, feature_flag_audit,
                bau_payment_events
       RESTART IDENTITY CASCADE`,
    );
    const make = (name: string) =>
      upsertUser({ clerkId: `clerk_${name}`, displayName: name, avatarUrl: null });
    owner = await make("bia");
    fan = await make("fan");
    other = await make("other");
    const created = await createChatServer("Canal da Bia", owner.id);
    serverId = created.server.id;
    await getPool().query(`UPDATE servers SET community_home_enabled = TRUE WHERE id = $1`, [serverId]);
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, fan.id],
    );
    await connectSandboxPayout(serverId, owner.id, "Bia Souza");
  });

  async function createPlan(): Promise<string> {
    const res = await call<{ plan: { id: string } }>(owner, "PUT", `/api/servers/${serverId}/bau-plus/plan`, {
      name: "VIP",
      priceCents: 990,
      perks: ["Posts VIP inteiros"],
    });
    expect(res.status).toBe(200);
    return res.body.plan.id;
  }

  async function checkout(method: "pix" | "card" = "pix") {
    return call<{ attempt: Attempt; membership: Membership }>(
      fan,
      "POST",
      `/api/servers/${serverId}/bau-plus/checkout`,
      { planId, method },
    );
  }

  async function refOf(attemptId: string): Promise<string> {
    const row = await getPool().query<{ provider_ref: string }>(
      `SELECT provider_ref FROM bau_payment_attempts WHERE id = $1`,
      [attemptId],
    );
    return row.rows[0]!.provider_ref;
  }

  async function holdsVip(userId: string): Promise<boolean> {
    const row = await getPool().query(
      `SELECT 1 FROM member_roles mr JOIN roles r ON r.id = mr.role_id
        WHERE mr.server_id = $1 AND mr.user_id = $2 AND r.system_key = 'vip'`,
      [serverId, userId],
    );
    return (row.rowCount ?? 0) > 0;
  }

  async function pay(attemptId: string) {
    const res = await call<{ attempt: Attempt; membership: Membership }>(
      fan,
      "POST",
      `/api/bau-plus/attempts/${attemptId}/sandbox`,
      { action: "pay" },
    );
    expect(res.status).toBe(200);
    return res.body;
  }

  it("is off until the flags say so, and answers the same for a non-member as for a missing server", async () => {
    planId = await createPlan();
    const off = await call<Offer>(fan, "GET", `/api/servers/${serverId}/bau-plus`);
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);
    expect(off.body.plan).toBeNull();
    expect((await checkout()).status).toBe(404);

    await turnOn(serverId);
    const on = await call<Offer>(fan, "GET", `/api/servers/${serverId}/bau-plus`);
    expect(on.body.enabled).toBe(true);
    expect(on.body.plan?.priceCents).toBe(990);
    expect(on.body.seller?.name).toBe("Bia Souza");
    expect(on.body.methods[0]).toBe("pix");
    expect(on.body.sandbox).toBe(true);

    expect((await call(other, "GET", `/api/servers/${serverId}/bau-plus`)).status).toBe(404);
  });

  it("is off with no provider configured (a self-host), even with every flag on", async () => {
    planId = await createPlan();
    await turnOn(serverId);
    process.env.BAU_PAYMENTS_PROVIDER = "none";
    try {
      const offer = await call<Offer>(fan, "GET", `/api/servers/${serverId}/bau-plus`);
      expect(offer.body.enabled).toBe(false);
      expect((await checkout()).status).toBe(404);
    } finally {
      process.env.BAU_PAYMENTS_PROVIDER = "sandbox";
    }
  });

  it("pays by Pix: one code per tap, a webhook grants VIP once, and the receipt names the seller", async () => {
    planId = await createPlan();
    await turnOn(serverId);
    const first = await checkout();
    expect(first.status).toBe(200);
    expect(first.body.attempt.status).toBe("pending");
    expect(first.body.attempt.kind).toBe("first");
    expect(isPixCopiaECola(first.body.attempt.pixCode ?? "")).toBe(true);
    expect(new Date(first.body.attempt.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(first.body.membership.hasAccess).toBe(false);

    // A double tap hands back the same code.
    const again = await checkout();
    expect(again.body.attempt.id).toBe(first.body.attempt.id);

    const ref = await refOf(first.body.attempt.id);
    const event = { events: [{ id: "evt_1", type: "charge.paid", charge: ref }] };

    // A forged body is refused and applies nothing.
    const forged = await postWebhook(event, "sha256=deadbeef");
    expect(forged.status).toBe(401);
    expect(await holdsVip(fan.id)).toBe(false);

    // The body is a pointer, not the truth: the sandbox still says pending.
    const early = await postWebhook(event);
    expect(early.status).toBe(200);
    expect(await holdsVip(fan.id)).toBe(false);

    const paid = await pay(first.body.attempt.id);
    expect(paid.attempt.status).toBe("paid");
    expect(paid.membership.status).toBe("active");
    expect(paid.membership.hasAccess).toBe(true);
    expect(paid.membership.refundableUntil).not.toBeNull();
    expect(paid.membership.receipts).toHaveLength(1);
    expect(paid.membership.receipts[0]!.sellerName).toBe("Bia Souza");
    expect(await holdsVip(fan.id)).toBe(true);
    const periodEnd = paid.membership.periodEnd;

    // The same notification again, and a second one for the same charge:
    // nothing moves, the month is not extended twice.
    const replay = { events: [{ id: "evt_2", type: "charge.paid", charge: ref }] };
    expect((await postWebhook(replay)).body.processed).toBe(1);
    expect((await postWebhook(replay)).body.duplicates).toBe(1);
    const after = await call<{ memberships: Membership[] }>(fan, "GET", `/api/bau-plus/memberships`);
    expect(after.body.memberships[0]!.periodEnd).toBe(periodEnd);

    const audit = await getPool().query(
      `SELECT action FROM audit_log WHERE server_id = $1 AND action LIKE 'bau_plus.%' ORDER BY id`,
      [serverId],
    );
    expect(audit.rows.map((row) => row.action)).toEqual(["bau_plus.plan_update", "bau_plus.activate"]);
    const metrics = await bauPaymentsMetrics();
    expect(metrics.process.paid).toBe(1);
    expect(metrics.process.webhooksBadSignature).toBe(1);
    expect(metrics.process.webhooksDuplicate).toBe(1);
    expect(metrics.db?.vipFromPayments).toBe(1);

    // An active member has nothing to pay until the reminder window.
    expect((await checkout()).status).toBe(409);
  });

  it("applies one payment once when two processes race on it", async () => {
    planId = await createPlan();
    await turnOn(serverId);
    const started = await checkout();
    const ref = await refOf(started.body.attempt.id);
    const { sandboxProvider } = await import("./service.js");
    // Make the provider say paid without sending its own webhook.
    sandboxProvider.setEventSink(null);
    await sandboxProvider.act(ref, "pay");
    const charge = await sandboxProvider.getCharge({ ref: "x", sellerName: "x" }, ref);
    const results = await Promise.all([
      applyCharge(started.body.attempt.id, charge, "webhook"),
      applyCharge(started.body.attempt.id, charge, "sweep"),
    ]);
    expect(results.filter((r) => r?.reason === "paid")).toHaveLength(1);
    const months = await getPool().query<{ days: string }>(
      `SELECT EXTRACT(EPOCH FROM period_end - period_start) / 86400 AS days
         FROM bau_memberships WHERE user_id = $1`,
      [fan.id],
    );
    // One month, not two.
    expect(Number(months.rows[0]!.days)).toBeGreaterThan(27);
    expect(Number(months.rows[0]!.days)).toBeLessThan(32);
    const { handleProviderEvents } = await import("./service.js");
    sandboxProvider.setEventSink((events) => handleProviderEvents(sandboxProvider, events).then(() => {}));
  });

  it("a declined card and an expired code leave no VIP, and a payment that lands late still counts", async () => {
    planId = await createPlan();
    await turnOn(serverId);
    const card = await checkout("card");
    const declined = await call<{ attempt: Attempt }>(fan, "POST", `/api/bau-plus/attempts/${card.body.attempt.id}/sandbox`, {
      action: "fail",
    });
    expect(declined.body.attempt.status).toBe("failed");
    expect(declined.body.attempt.failureReason).toBe("declined");

    const pix = await checkout();
    expect(pix.body.attempt.id).not.toBe(card.body.attempt.id);
    const expired = await call<{ attempt: Attempt }>(fan, "POST", `/api/bau-plus/attempts/${pix.body.attempt.id}/sandbox`, {
      action: "expire",
    });
    expect(expired.body.attempt.status).toBe("expired");
    expect(await holdsVip(fan.id)).toBe(false);

    // Paid at the last second, confirmed after we called it expired.
    const late = await pay(pix.body.attempt.id);
    expect(late.attempt.status).toBe("paid");
    expect(late.membership.status).toBe("active");
    expect(await holdsVip(fan.id)).toBe(true);
  });

  it("cancel keeps VIP to the end of the month, resume undoes it, and the end of the month takes it", async () => {
    planId = await createPlan();
    await turnOn(serverId);
    const started = await checkout();
    const paid = await pay(started.body.attempt.id);
    const id = paid.membership.id;

    const cancelled = await call<{ membership: Membership }>(fan, "POST", `/api/bau-plus/memberships/${id}/cancel`);
    expect(cancelled.body.membership.status).toBe("cancelled");
    expect(cancelled.body.membership.hasAccess).toBe(true);
    expect(await holdsVip(fan.id)).toBe(true);

    const resumed = await call<{ membership: Membership }>(fan, "POST", `/api/bau-plus/memberships/${id}/resume`);
    expect(resumed.body.membership.status).toBe("active");

    await call(fan, "POST", `/api/bau-plus/memberships/${id}/cancel`);
    await getPool().query(`UPDATE bau_memberships SET period_end = NOW() - INTERVAL '1 minute' WHERE id = $1`, [id]);
    const swept = await sweepBauPayments();
    expect(swept.revoked).toBe(1);
    expect(await holdsVip(fan.id)).toBe(false);
    // Somebody else's membership is not theirs to touch.
    expect((await call(other, "POST", `/api/bau-plus/memberships/${id}/resume`)).status).toBe(404);
  });

  it("refunds the first payment within 7 days, takes VIP back, and refuses after", async () => {
    planId = await createPlan();
    await turnOn(serverId);
    const started = await checkout();
    const paid = await pay(started.body.attempt.id);
    const id = paid.membership.id;
    const refunded = await call<{ membership: Membership }>(fan, "POST", `/api/bau-plus/memberships/${id}/refund`);
    expect(refunded.status).toBe(200);
    expect(refunded.body.membership.status).toBe("refunded");
    expect(refunded.body.membership.hasAccess).toBe(false);
    expect(refunded.body.membership.receipts[0]!.status).toBe("refunded");
    expect(await holdsVip(fan.id)).toBe(false);
    expect((await call(fan, "POST", `/api/bau-plus/memberships/${id}/refund`)).status).toBe(409);

    // A first payment older than the window is not refundable.
    const again = await checkout();
    await pay(again.body.attempt.id);
    await getPool().query(
      `UPDATE bau_payment_attempts SET paid_at = NOW() - INTERVAL '8 days' WHERE id = $1`,
      [again.body.attempt.id],
    );
    expect((await call(fan, "POST", `/api/bau-plus/memberships/${id}/refund`)).status).toBe(409);
  });

  it("runs the month: one reminder, grace with VIP, then expired without it", async () => {
    planId = await createPlan();
    await turnOn(serverId);
    const started = await checkout();
    const paid = await pay(started.body.attempt.id);
    const id = paid.membership.id;

    await getPool().query(`UPDATE bau_memberships SET period_end = NOW() + INTERVAL '2 days' WHERE id = $1`, [id]);
    expect((await sweepBauPayments()).reminders).toBe(1);
    expect((await sweepBauPayments()).reminders).toBe(0);
    const due = await call<{ memberships: Membership[] }>(fan, "GET", `/api/bau-plus/memberships`);
    expect(due.body.memberships[0]!.renewalDue).toBe(true);

    // Renewing three days early extends the running month, no day lost.
    const renewal = await checkout();
    expect(renewal.status).toBe(200);
    expect(renewal.body.attempt.kind).toBe("renewal");
    const before = new Date(due.body.memberships[0]!.periodEnd!);
    const renewed = await pay(renewal.body.attempt.id);
    const afterEnd = new Date(renewed.membership.periodEnd!);
    expect(afterEnd.getTime() - before.getTime()).toBeGreaterThan(27 * 86_400_000);
    // A renewal is not the 7-day withdrawal.
    expect(renewed.membership.refundableUntil).toBeNull();

    await getPool().query(`UPDATE bau_memberships SET period_end = NOW() - INTERVAL '1 hour' WHERE id = $1`, [id]);
    expect((await sweepBauPayments()).grace).toBe(1);
    const inGrace = await call<{ memberships: Membership[] }>(fan, "GET", `/api/bau-plus/memberships`);
    expect(inGrace.body.memberships[0]!.status).toBe("grace");
    expect(await holdsVip(fan.id)).toBe(true);

    await getPool().query(`UPDATE bau_memberships SET period_end = NOW() - INTERVAL '4 days' WHERE id = $1`, [id]);
    const swept = await sweepBauPayments();
    expect(swept.expired).toBe(1);
    expect(swept.revoked).toBe(1);
    expect(await holdsVip(fan.id)).toBe(false);
  });

  it("never takes away a VIP staff gave by hand", async () => {
    planId = await createPlan();
    await turnOn(serverId);
    await getPool().query(
      `INSERT INTO member_roles (server_id, user_id, role_id)
       SELECT $1, $2, id FROM roles WHERE server_id = $1 AND system_key = 'vip'`,
      [serverId, fan.id],
    );
    const started = await checkout();
    const paid = await pay(started.body.attempt.id);
    await getPool().query(
      `UPDATE bau_memberships SET status = 'expired', period_end = NOW() - INTERVAL '10 days' WHERE id = $1`,
      [paid.membership.id],
    );
    await sweepBauPayments();
    expect(await holdsVip(fan.id)).toBe(true);
  });

  it("gives VIP back to a paid fan who left and came back, not to one staff stripped", async () => {
    planId = await createPlan();
    await turnOn(serverId);
    const started = await checkout();
    await pay(started.body.attempt.id);
    expect(await holdsVip(fan.id)).toBe(true);

    // Staff take the cargo away on purpose: the sweep leaves it.
    await getPool().query(
      `DELETE FROM member_roles mr USING roles r
        WHERE r.id = mr.role_id AND mr.server_id = $1 AND mr.user_id = $2 AND r.system_key = 'vip'`,
      [serverId, fan.id],
    );
    expect((await sweepBauPayments()).regranted).toBe(0);
    expect(await holdsVip(fan.id)).toBe(false);

    // Leave and come back (the FK cascade drops roles): the sweep gives it back.
    await getPool().query(`DELETE FROM server_members WHERE server_id = $1 AND user_id = $2`, [serverId, fan.id]);
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES ($1, $2, 'member', NOW() + INTERVAL '1 second')`,
      [serverId, fan.id],
    );
    expect((await sweepBauPayments()).regranted).toBe(1);
    expect(await holdsVip(fan.id)).toBe(true);
  });

  it("a new price is a new plan; the old checkout is refused as changed", async () => {
    planId = await createPlan();
    await turnOn(serverId);
    const res = await call<{ plan: { id: string; priceCents: number } }>(
      owner,
      "PUT",
      `/api/servers/${serverId}/bau-plus/plan`,
      { name: "VIP", priceCents: 1490, perks: [] },
    );
    expect(res.body.plan.id).not.toBe(planId);
    expect((await checkout()).status).toBe(409);
    expect((await call(fan, "PUT", `/api/servers/${serverId}/bau-plus/plan`, { name: "x", priceCents: 990 })).status).toBe(403);
  });
});
