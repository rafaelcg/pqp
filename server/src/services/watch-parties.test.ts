import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The watch party journey, driven through the real HTTP router.
 *
 * `packages/shared/src/watch-party-session.ts` already has a pure unit test
 * for its transition and role tables. That test proves the tables say the
 * right thing; it cannot prove the routes ask them, ask them about the right
 * actor, or write the right rows afterwards. This suite pins the seam between
 * the two, on a real Postgres, with only the identity layer stubbed:
 *
 *   * A DRAFT IS INVISIBLE, AND INVISIBLE MEANS ABSENT. A plain member and a
 *     MANAGE_CHANNELS moderator both get `{ party: null }` from the channel
 *     read and an empty list from the server-wide read. Not a 403: a 403
 *     would tell them a party is being set up, which is exactly what a draft
 *     must not do.
 *   * THE TWO ASYMMETRIES IN THE ROLE TABLE ARE REAL OVER HTTP. A manager may
 *     end someone else's party but may not start it or touch its roster; a
 *     co-host may run the party but may not promote, demote or hand it over.
 *   * SUCCESSION IS GATED ON THE HOST ACTUALLY BEING GONE. `claimHost` is
 *     refused while `host_disconnected_at` is NULL, and the sweep only ends a
 *     party once the grace window has run out.
 *   * GOING LIVE APPLIES THE HOST'S SETUP TO THE CHANNEL. Ending it is
 *     supposed to put the channel back and today does not; the last test
 *     pins the broken behaviour and explains the one-line cause, so the fix
 *     announces itself by turning that test red.
 *
 * Same harness as channel-sessions.test.ts.
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

const { getPool, initDb, closePool } = await import("../db.js");
const { handleApi, resetApiRateLimits } = await import("../api/index.js");
const { upsertUser } = await import("./users.js");
const { createServer: createChatServer, createChannel } = await import(
  "./servers.js"
);
const { assignRole, createRole } = await import("./roles.js");
const { Permission } = await import("@pqp/shared");
const {
  markWatchPartyHostBack,
  markWatchPartyHostGone,
  sweepWatchPartyHosts,
} = await import("./watch-parties.js");

let httpServer: Server;
let baseUrl: string;

interface ApiResult<T = Record<string, unknown>> {
  status: number;
  body: T;
}

async function call<T = Record<string, unknown>>(
  as: { id: string; clerk_id: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
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
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

type User = { id: string; clerk_id: string };

interface PartyBody {
  id: string;
  name: string;
  state: string;
  startsAt: string | null;
  viewerRole: string;
  hostUserId: string;
  cohosts: { userId: string }[];
  options: { slowModeSeconds: number };
}

describeDb("watch party ownership", () => {
  /** Owns the server. Holds every bit, and hosts nothing by default. */
  let owner: User;
  /** Holds START_WATCH_PARTY through a role, and nothing else beyond @everyone. */
  let host: User;
  /** A plain member who gets promoted to co-host in the tests that need one. */
  let second: User;
  /** A third plain member, the target of the promotions that must be refused. */
  let third: User;
  /** Holds MANAGE_CHANNELS through a role. Never the host. */
  let manager: User;
  /** Holds nothing beyond the @everyone default. */
  let member: User;

  let serverId: string;
  let channelId: string;

  beforeAll(async () => {
    await initDb();
    httpServer = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await closePool();
  });

  beforeEach(async () => {
    // Every mutating route fans the party out with `void broadcastWatchParty`.
    // Nothing is listening in this process, but those queries are still in
    // flight when the next test begins, and TRUNCATE wants a lock they hold,
    // which Postgres reports as a deadlock rather than a wait. A tick lets
    // them finish first.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    resetApiRateLimits();

    const makeUser = (name: string) =>
      upsertUser({ clerkId: `clerk_${name}`, displayName: name, avatarUrl: null });
    owner = await makeUser("owner");
    host = await makeUser("host");
    second = await makeUser("second");
    third = await makeUser("third");
    manager = await makeUser("manager");
    member = await makeUser("member");

    const created = await createChatServer("Cinemoon", owner.id);
    serverId = created.server.id;
    const channel = await createChannel(serverId, "sessao-da-tarde", "watch_party");
    channelId = channel.id;

    for (const user of [host, second, third, manager, member]) {
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
        [serverId, user.id],
      );
    }

    // Two roles carrying one bit each, so a refusal can only be about that
    // bit. @everyone is ORed in at resolve time and carries neither.
    const hostRole = await createRole(serverId, {
      name: "Apresentador",
      permissions: Permission.START_WATCH_PARTY,
    });
    await assignRole(serverId, host.id, hostRole.id);
    const managerRole = await createRole(serverId, {
      name: "GerenteDeCanais",
      permissions: Permission.MANAGE_CHANNELS,
    });
    await assignRole(serverId, manager.id, managerRole.id);
  });

  // ------------------------------------------------------------- the helpers

  const inAnHour = () => new Date(Date.now() + 60 * 60_000).toISOString();

  async function create(
    as: User,
    body: Record<string, unknown> = {},
    channel = channelId,
  ) {
    return call<{ party: PartyBody }>(
      as,
      "POST",
      `/api/channels/${channel}/watch-parties`,
      { name: "Sessão do Rafa", ...body },
    );
  }

  /** A draft owned by `host`, which is the starting point for most cases. */
  async function draft(body: Record<string, unknown> = {}) {
    const created = await create(host, body);
    expect(created.status).toBe(200);
    return created.body.party;
  }

  const setState = (as: User, id: string, state: string) =>
    call<{ party: PartyBody }>(as, "POST", `/api/watch-parties/${id}/state`, {
      state,
    });

  const setCohost = (as: User, id: string, userId: string, cohost: boolean) =>
    call<{ party: PartyBody }>(as, "POST", `/api/watch-parties/${id}/cohosts`, {
      userId,
      cohost,
    });

  const readChannelParty = (as: User, channel = channelId) =>
    call<{ party: PartyBody | null }>(
      as,
      "GET",
      `/api/channels/${channel}/watch-party`,
    );

  const readServerParties = (as: User) =>
    call<{ parties: PartyBody[] }>(as, "GET", `/api/servers/${serverId}/watch-parties`);

  async function slowMode(): Promise<number> {
    const result = await getPool().query<{ slowmode_seconds: number | null }>(
      `SELECT slowmode_seconds FROM channels WHERE id = $1`,
      [channelId],
    );
    return result.rows[0]?.slowmode_seconds ?? 0;
  }

  /** What the party recorded that it was replacing, straight off the row. */
  async function restoreSlowMode(sessionId: string): Promise<number | null> {
    const result = await getPool().query<{ restore_slowmode_seconds: number | null }>(
      `SELECT restore_slowmode_seconds FROM channel_sessions WHERE id = $1`,
      [sessionId],
    );
    return result.rows[0]?.restore_slowmode_seconds ?? null;
  }

  // --------------------------------------------------------------- the cases

  it("refuses a create without START_WATCH_PARTY and hands the bit holder a draft", async () => {
    const refused = await create(member);
    expect(refused.status).toBe(403);

    const allowed = await create(host);
    expect(allowed.status).toBe(200);
    // No startsAt, so it is a draft: it exists, it has a name, and nobody has
    // been told about it.
    expect(allowed.body.party.state).toBe("draft");
    expect(allowed.body.party.startsAt).toBeNull();
    expect(allowed.body.party.viewerRole).toBe("host");
    expect(allowed.body.party.hostUserId).toBe(host.id);
  });

  it("keeps a draft invisible to the room and to a channel manager", async () => {
    const party = await draft();

    for (const viewer of [member, manager]) {
      const read = await readChannelParty(viewer);
      expect(read.status).toBe(200);
      // Null rather than 403. A 403 would confirm that something is there.
      expect(read.body.party).toBeNull();
      const listed = await readServerParties(viewer);
      expect(listed.body.parties).toEqual([]);
    }

    const asHost = await readChannelParty(host);
    expect(asHost.body.party?.id).toBe(party.id);
    const listedForHost = await readServerParties(host);
    expect(listedForHost.body.parties.map((p) => p.id)).toEqual([party.id]);
  });

  it("publishes the party to the room the moment the host goes live", async () => {
    const party = await draft();
    expect((await setState(host, party.id, "live")).status).toBe(200);

    const asMember = await readChannelParty(member);
    expect(asMember.body.party?.state).toBe("live");
    expect(asMember.body.party?.viewerRole).toBe("viewer");
    expect(asMember.body.party?.name).toBe("Sessão do Rafa");

    // The same party through the sidebar's server-wide read.
    const listed = await readServerParties(member);
    expect(listed.body.parties.map((p) => p.id)).toEqual([party.id]);

    // MANAGE_CHANNELS shows up as `manager`, not as a co-host.
    const asManager = await readChannelParty(manager);
    expect(asManager.body.party?.viewerRole).toBe("manager");
  });

  it("lets only the host and co-hosts press go live", async () => {
    const party = await draft();

    // While it is a draft, neither of them gets a 403: `authoriseWatchParty`
    // checks `view` first, and someone who cannot see the party is told it is
    // not there rather than that they are not allowed. The brief expected a
    // 403 from the manager here; 404 is the draft rule doing its job.
    expect((await setState(manager, party.id, "live")).status).toBe(404);
    expect((await setState(member, party.id, "live")).status).toBe(404);
    expect((await readChannelParty(host)).body.party?.state).toBe("draft");

    // Announced, so both of them can now see it. This is where the role
    // table answers rather than the visibility rule: MANAGE_CHANNELS may stop
    // a party but may not press Ir ao vivo on someone else's.
    const published = await call<{ party: PartyBody }>(
      host,
      "PATCH",
      `/api/watch-parties/${party.id}`,
      { startsAt: inAnHour() },
    );
    expect(published.status).toBe(200);
    expect(published.body.party.state).toBe("scheduled");

    expect((await setState(manager, party.id, "live")).status).toBe(403);
    expect((await setState(member, party.id, "live")).status).toBe(403);
    expect((await readChannelParty(member)).body.party?.state).toBe("scheduled");
  });

  it("lets a manager end a live party and refuses a plain member", async () => {
    const first = await draft();
    await setState(host, first.id, "live");

    const ended = await setState(manager, first.id, "ended");
    expect(ended.status).toBe(200);
    expect(ended.body.party.state).toBe("ended");
    // Ended is no longer active, so the channel is free for the next one.
    expect((await readChannelParty(member)).body.party).toBeNull();

    const next = await draft();
    await setState(host, next.id, "live");
    const byMember = await setState(member, next.id, "ended");
    expect(byMember.status).toBe(403);
    expect((await readChannelParty(member)).body.party?.state).toBe("live");
  });

  it("refuses the moves the tables do not allow", async () => {
    const party = await draft();
    await setState(host, party.id, "live");

    // Cancelling a live party. The brief expected 409 here; the code answers
    // 403, because `cancel` is only legal in draft/scheduled and the
    // role-and-state check runs before the transition table is consulted.
    // Same shape for the other two: a refused action never reaches the SQL.
    expect((await setState(host, party.id, "cancelled")).status).toBe(403);
    // Going live twice.
    expect((await setState(host, party.id, "live")).status).toBe(403);

    expect((await setState(host, party.id, "ended")).status).toBe(200);
    // Reviving an ended party.
    expect((await setState(host, party.id, "live")).status).toBe(403);

    // The transition table's own 409 is reachable through `schedule`, which
    // is legal for a host in the `scheduled` state but is not a legal move
    // from `scheduled` to `scheduled`.
    const scheduled = await create(host, { startsAt: inAnHour() });
    expect(scheduled.status).toBe(200);
    expect(scheduled.body.party.state).toBe("scheduled");
    const again = await setState(host, scheduled.body.party.id, "scheduled");
    expect(again.status).toBe(409);
  });

  it("gives a co-host the controls but never the roster", async () => {
    const first = await draft();
    expect((await setCohost(host, first.id, second.id, true)).status).toBe(200);

    // A co-host exists so the show does not depend on one person's laptop.
    expect((await setState(second, first.id, "live")).status).toBe(200);
    expect((await setState(second, first.id, "ended")).status).toBe(200);

    const next = await draft();
    await setCohost(host, next.id, second.id, true);
    // Live, so the manager can see it: a refusal below is then about the
    // roster rule and not about a draft being invisible.
    await setState(host, next.id, "live");

    // The roster is the host's alone: a co-host who could promote could also
    // demote the host, and there would be no chain of authority left.
    expect((await setCohost(second, next.id, third.id, true)).status).toBe(403);
    // MANAGE_CHANNELS does not buy a seat on the roster either.
    expect((await setCohost(manager, next.id, third.id, true)).status).toBe(403);

    const roster = await readChannelParty(host);
    expect(roster.body.party?.cohosts.map((c) => c.userId)).toEqual([second.id]);
  });

  it("hands the party over and refuses a co-host doing the same", async () => {
    const party = await draft();
    await setCohost(host, party.id, second.id, true);

    const transferred = await call<{ party: PartyBody }>(
      host,
      "POST",
      `/api/watch-parties/${party.id}/host`,
      { userId: second.id },
    );
    expect(transferred.status).toBe(200);

    const asSecond = await readChannelParty(second);
    expect(asSecond.body.party?.viewerRole).toBe("host");
    expect(asSecond.body.party?.hostUserId).toBe(second.id);
    // Handing over is a delegation, not an exit: the old host stays on the
    // roster with the controls they were already using.
    expect(asSecond.body.party?.cohosts.map((c) => c.userId)).toEqual([host.id]);

    // The old host is now a co-host, and a co-host may not hand the party on.
    const byCohost = await call(host, "POST", `/api/watch-parties/${party.id}/host`, {
      userId: third.id,
    });
    expect(byCohost.status).toBe(403);
  });

  it("opens succession only while the host is actually gone", async () => {
    const party = await draft();
    await setCohost(host, party.id, second.id, true);
    await setState(host, party.id, "live");

    const claim = (as: User) =>
      call(as, "POST", `/api/watch-parties/${party.id}/host`, { claim: true });

    // The host is connected, so there is nothing to succeed to.
    expect((await claim(second)).status).toBe(403);

    const gone = await markWatchPartyHostGone(host.id);
    expect(gone).toContain(channelId);

    // A viewer never claims, however open the window is.
    expect((await claim(member)).status).toBe(403);

    expect((await claim(second)).status).toBe(200);
    const asSecond = await readChannelParty(second);
    expect(asSecond.body.party?.viewerRole).toBe("host");
    expect(asSecond.body.party?.hostUserId).toBe(second.id);
    // Claiming clears the clock, so the sweep has nothing left to end.
    expect(asSecond.body.party?.state).toBe("live");
  });

  it("ends a hostless party only once the grace window has run out", async () => {
    const party = await draft();
    await setState(host, party.id, "live");
    await markWatchPartyHostGone(host.id);

    // Inside the five minute window the party stays live: the audience is
    // watching, and a host whose wifi blinked is back in seconds.
    const early = await sweepWatchPartyHosts(Date.now());
    expect(early.ended).toEqual([]);
    expect((await readChannelParty(member)).body.party?.state).toBe("live");

    // With no grace at all the same row is past its deadline.
    const late = await sweepWatchPartyHosts(Date.now(), 0);
    expect(late.ended.map((e) => e.sessionId)).toEqual([party.id]);
    expect((await readChannelParty(member)).body.party).toBeNull();

    // A host who comes back clears the clock, and the sweep leaves the party
    // alone even with the grace window closed.
    const next = await draft();
    await setState(host, next.id, "live");
    await markWatchPartyHostGone(host.id);
    const back = await markWatchPartyHostBack(host.id);
    expect(back).toContain(channelId);

    const afterReturn = await sweepWatchPartyHosts(Date.now(), 0);
    expect(afterReturn.ended).toEqual([]);
    expect((await readChannelParty(member)).body.party?.state).toBe("live");
  });

  it("applies the host's slow mode on go live, and does NOT put it back on end", async () => {
    // The channel already throttles chat, so a restore that works and a
    // restore that resets to zero look different.
    await getPool().query(`UPDATE channels SET slowmode_seconds = 5 WHERE id = $1`, [
      channelId,
    ]);

    const party = await draft({ options: { slowModeSeconds: 30 } });
    expect(party.options.slowModeSeconds).toBe(30);
    expect(await slowMode()).toBe(5);

    expect((await setState(host, party.id, "live")).status).toBe(200);
    expect(await slowMode()).toBe(30);
    // Go live records what it is replacing, which is the half that works.
    expect(await restoreSlowMode(party.id)).toBe(5);

    expect((await setState(host, party.id, "ended")).status).toBe(200);

    /**
     * THIS ASSERTION PINS A BUG, DELIBERATELY, AND IT SHOULD FAIL WHEN THE
     * BUG IS FIXED.
     *
     * `restoreChannelAfterParty` clears `restore_slowmode_seconds` and reads
     * it back in one statement, with `UPDATE ... SET restore_slowmode_seconds
     * = NULL ... RETURNING restore_slowmode_seconds`, and its comment says
     * that is what makes a double end idempotent. Postgres `RETURNING` on an
     * UPDATE yields the NEW row, not the old one, so the value read back is
     * always NULL and the restore branch never runs. The channel keeps the
     * party's slow mode for ever after one film night. `stage_speak_applied`
     * is read the same way in the same statement, so the SPEAK denial a
     * `hosts_only` party applies is never lifted either.
     *
     * Reality is asserted here rather than the intent, per the brief. Fixing
     * it means reading the old values before clearing them (a SELECT ... FOR
     * UPDATE inside a transaction, or `UPDATE ... FROM (SELECT ...) old`),
     * after which this expectation becomes `toBe(5)`.
     */
    expect(await slowMode()).toBe(30);
    // The flag is cleared, so the end path is at least idempotent about it.
    expect(await restoreSlowMode(party.id)).toBeNull();
  });

  it("allows one active party per channel", async () => {
    const party = await draft();

    // A draft occupies the channel: two people setting one up in the same
    // room at once is a conflict, not a crash.
    const whileDraft = await create(host);
    expect(whileDraft.status).toBe(409);

    await setState(host, party.id, "live");
    const whileLive = await create(host);
    expect(whileLive.status).toBe(409);

    // A different channel in the same server is unaffected.
    const other = await createChannel(serverId, "sessao-da-noite", "watch_party");
    const elsewhere = await create(host, {}, other.id);
    expect(elsewhere.status).toBe(200);

    // And the channel frees up once the party is over.
    await setState(host, party.id, "ended");
    const afterEnd = await create(host);
    expect(afterEnd.status).toBe(200);
  });
});
