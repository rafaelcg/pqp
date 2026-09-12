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
 *   * THE ASYMMETRY IN THE ROLE TABLE IS REAL OVER HTTP. A manager may edit
 *     someone else's party but may not start, end, cancel or touch its
 *     roster; a co-host may run the party but may not promote, demote or
 *     hand it over. (Before 2026-09-12 a manager could also end/cancel; that
 *     let an uninvolved admin end a live show they were only watching.)
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
const watchPartyEvents = await import("../ws/watch-party-events.js");

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

  const rename = (as: User, id: string, name: string) =>
    call<{ party: PartyBody }>(as, "PATCH", `/api/watch-parties/${id}`, {
      name,
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

  it("refuses a manager and a plain member who try to end a live party", async () => {
    // 2026-09-12 incident: a server admin (MANAGE_CHANNELS, not the host or
    // a co-host) ended a live party while only watching it. `end`/`cancel`
    // came out of the manager's row in the role table for exactly this;
    // `edit` stays, so a manager can still rename or retime the party.
    const first = await draft();
    await setState(host, first.id, "live");

    const byManager = await setState(manager, first.id, "ended");
    expect(byManager.status).toBe(403);
    expect((await readChannelParty(member)).body.party?.state).toBe("live");

    const byMember = await setState(member, first.id, "ended");
    expect(byMember.status).toBe(403);
    expect((await readChannelParty(member)).body.party?.state).toBe("live");

    // The host still can, unaffected by the manager's refusal above.
    const endedByHost = await setState(host, first.id, "ended");
    expect(endedByHost.status).toBe(200);
    expect(endedByHost.body.party.state).toBe("ended");
    // Ended is no longer active, so the channel is free for the next one.
    expect((await readChannelParty(member)).body.party).toBeNull();
  });

  it("lets a co-host end a live party the manager may not touch", async () => {
    const party = await draft();
    expect((await setCohost(host, party.id, second.id, true)).status).toBe(200);
    await setState(host, party.id, "live");

    expect((await setState(manager, party.id, "ended")).status).toBe(403);
    const endedByCohost = await setState(second, party.id, "ended");
    expect(endedByCohost.status).toBe(200);
    expect(endedByCohost.body.party.state).toBe("ended");
  });

  it("lets host, co-host and manager rename a live party, and the room sees it", async () => {
    const party = await draft();
    expect((await setCohost(host, party.id, second.id, true)).status).toBe(200);
    expect((await setState(host, party.id, "live")).status).toBe(200);

    const broadcast = vi.spyOn(watchPartyEvents, "broadcastWatchParty");

    expect((await rename(member, party.id, "PQPTV")).status).toBe(403);
    expect((await readChannelParty(member)).body.party?.name).toBe(
      "Sessão do Rafa",
    );

    const asHost = await rename(host, party.id, "PQPTV test");
    expect(asHost.status).toBe(200);
    expect(asHost.body.party.name).toBe("PQPTV test");
    expect(broadcast).toHaveBeenCalledWith(party.id);

    // Same payload a late joiner would GET, and the same name the
    // `watch-party-update` frame carries: the write persisted, and the
    // audience does not need a refresh.
    expect((await readChannelParty(member)).body.party?.name).toBe("PQPTV test");

    expect((await rename(second, party.id, "Sessão da tarde")).status).toBe(200);
    expect((await readChannelParty(member)).body.party?.name).toBe(
      "Sessão da tarde",
    );

    expect((await rename(manager, party.id, "Cinemoon")).status).toBe(200);
    expect((await readChannelParty(member)).body.party?.name).toBe("Cinemoon");

    expect((await rename(host, party.id, "")).status).toBe(400);
    expect((await rename(host, party.id, "   ")).status).toBe(400);

    expect((await setState(host, party.id, "ended")).status).toBe(200);
    expect((await rename(host, party.id, "Too late")).status).toBe(403);

    broadcast.mockRestore();
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

  it("applies the host's slow mode on go live and puts the old value back on end", async () => {
    // The channel already throttles chat, so a restore that works and a
    // restore that resets to zero look different. A watch party borrows the
    // channel for the length of the show; it does not get to redecorate it.
    await getPool().query(`UPDATE channels SET slowmode_seconds = 5 WHERE id = $1`, [
      channelId,
    ]);

    const party = await draft({ options: { slowModeSeconds: 30 } });
    expect(party.options.slowModeSeconds).toBe(30);
    expect(await slowMode()).toBe(5);

    expect((await setState(host, party.id, "live")).status).toBe(200);
    expect(await slowMode()).toBe(30);
    // Go live records what it is replacing. Without this the end path has
    // nothing to put back and would have to guess at zero.
    expect(await restoreSlowMode(party.id)).toBe(5);

    expect((await setState(host, party.id, "ended")).status).toBe(200);

    /**
     * FIVE, NOT ZERO, AND NOT THIRTY.
     *
     * Thirty was the bug: `restoreChannelAfterParty` used to clear
     * `restore_slowmode_seconds` and read it back in one
     * `UPDATE ... RETURNING`, which in Postgres yields the NEW row, so the
     * value read back was always NULL and the restore branch never ran. A
     * channel kept the party's slow mode for ever after one film night, and
     * a `hosts_only` party's SPEAK denial on @everyone was never lifted
     * either, since it is read the same way in the same statement. Nothing
     * about it was visible from the outside: the end succeeded, the party
     * ended, and the room stayed throttled.
     *
     * Zero would be the other bug: resetting rather than restoring, which
     * would quietly turn off a slow mode the channel had before anyone
     * started a party.
     */
    expect(await slowMode()).toBe(5);
    // Cleared, so a second end (a host pressing Encerrar as the host sweep
    // fires) puts the channel back exactly once.
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

  // -------------------------------------------- starting one without a channel

  /**
   * A watch party stopped being "make a channel of this type" and became an
   * action: one control in the sidebar for people holding START_WATCH_PARTY.
   * The room still exists, because it is the voice room, the chat and the key
   * the egress hangs on; it is simply found or made for you and never listed.
   */
  describe("POST /api/servers/:id/watch-parties", () => {
    const startOnServer = (as: User, body: Record<string, unknown> = {}) =>
      call<{
        party: { id: string; state: string; hostUserId: string };
        channel: { id: string; type: string; name: string };
      }>(as, "POST", `/api/servers/${serverId}/watch-parties`, {
        name: "Cinemoon",
        ...body,
      });

    it("refuses somebody without the bit, and lets the bit holder start one", async () => {
      const refused = await startOnServer(member);
      expect(refused.status).toBe(403);

      const allowed = await startOnServer(host);
      expect(allowed.status).toBe(200);
      expect(allowed.body.party.state).toBe("draft");
      expect(allowed.body.party.hostUserId).toBe(host.id);
    });

    it("adopts the server's existing watch party channel rather than making another", async () => {
      // `beforeEach` already made one, which stands in for the channels that
      // exist on main from before this change.
      const before = await getPool().query(
        `SELECT id FROM channels WHERE server_id = $1 AND type = 'watch_party'`,
        [serverId],
      );
      expect(before.rowCount).toBe(1);

      const started = await startOnServer(host);
      expect(started.status).toBe(200);
      expect(started.body.channel.id).toBe(channelId);

      const after = await getPool().query(
        `SELECT id FROM channels WHERE server_id = $1 AND type = 'watch_party'`,
        [serverId],
      );
      expect(after.rowCount).toBe(1);
    });

    it("makes the room visible to a plain member on a server whose @everyone cannot see channels by default", async () => {
      /**
       * THE ONE THAT LOCKED AN AUDIENCE OUT OF ITS OWN EVENT.
       *
       * A community that does not put VIEW_CHANNEL on @everyone and hands it
       * back per channel instead is an ordinary Discord-shaped setup, and a
       * likely one for a server with two thousand members. The room is
       * created here with no overwrites at all, so its visibility fell
       * through to the server default, which on such a server is "no".
       *
       * Reproduced in a browser on 12 Sep 2026 before the fix: the room was
       * absent from the member's `GET /channels`, the watch-parties endpoint
       * answered `[]`, the sidebar block never appeared, and a deep link to
       * the room bounced them to the first text channel. The host saw a
       * perfectly normal live party the whole time. That is the entire
       * audience locked out, silently, on the day of the show.
       *
       * The three assertions below are the three surfaces that failed, in
       * the order a person meets them.
       */
      await getPool().query(`DELETE FROM channels WHERE id = $1`, [channelId]);

      const everyoneId = (
        await getPool().query<{ id: string }>(
          `SELECT id FROM roles WHERE server_id = $1 AND is_everyone`,
          [serverId],
        )
      ).rows[0]!.id;
      await getPool().query(
        `UPDATE roles SET permissions = permissions & ~$2::bigint WHERE id = $1`,
        [everyoneId, Permission.VIEW_CHANNEL],
      );
      await getPool().query(
        `UPDATE servers SET permissions_version = permissions_version + 1 WHERE id = $1`,
        [serverId],
      );

      // Started by the OWNER, who short-circuits `computePermissions` and is
      // who runs the show on the server this was reproduced against. A
      // role-holding host is refused 403 on a server like this, because
      // START_WATCH_PARTY still resolves through a channel they can no longer
      // see. That is arguable rather than obviously wrong (you cannot act in
      // a room you cannot enter) and it is a separate question from this one,
      // which is about the AUDIENCE.
      const started = await startOnServer(owner);
      expect(started.status).toBe(200);
      const roomId = started.body.channel.id;

      // 1. The room is in the member's own channel list, which is what the
      //    deep-link resolver looks it up in before deciding the channel does
      //    not exist and landing them somewhere else.
      const listed = await call<{ channels: { id: string }[] }>(
        member,
        "GET",
        `/api/servers/${serverId}/channels`,
      );
      expect(listed.status).toBe(200);
      expect(listed.body.channels.map((one) => one.id)).toContain(roomId);

      // 2. And the party itself, which is what draws the sidebar block.
      await call(owner, "POST", `/api/watch-parties/${started.body.party.id}/state`, {
        state: "live",
      });
      const parties = await call<{ parties: { id: string }[] }>(
        member,
        "GET",
        `/api/servers/${serverId}/watch-parties`,
      );
      expect(parties.status).toBe(200);
      expect(parties.body.parties.map((one) => one.id)).toContain(
        started.body.party.id,
      );

      // 3. The bit is written where it can still be overruled: an @everyone
      //    ALLOW, so a per-role or per-member deny on this channel continues
      //    to win. This removes the accidental case, not the deliberate one.
      const overwrite = await getPool().query<{ allow: string; deny: string }>(
        `SELECT allow, deny FROM channel_overwrites
          WHERE channel_id = $1 AND target_type = 'role' AND target_id = $2`,
        [roomId, everyoneId],
      );
      expect(overwrite.rowCount).toBe(1);
      expect(BigInt(overwrite.rows[0]!.allow) & BigInt(Permission.VIEW_CHANNEL)).not.toBe(
        0n,
      );
      // The VIEW bit only. The same row carries the SPEAK deny that going
      // live writes for a closed floor, which is the stage mode working and
      // has nothing to do with who can see the room.
      expect(
        BigInt(overwrite.rows[0]!.deny) & BigInt(Permission.VIEW_CHANNEL),
      ).toBe(0n);
    });

    it("does not re-open a watch party room somebody deliberately made private", async () => {
      // ADOPTION IS NOT CREATION. `beforeEach` leaves a `watch_party` channel
      // on the server; a host who made theirs private meant it, and a party
      // starting in it is not a reason for this code to overrule them.
      const everyoneId = (
        await getPool().query<{ id: string }>(
          `SELECT id FROM roles WHERE server_id = $1 AND is_everyone`,
          [serverId],
        )
      ).rows[0]!.id;
      await getPool().query(
        `UPDATE channels SET is_private = TRUE WHERE id = $1`,
        [channelId],
      );
      await getPool().query(
        `INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny)
         VALUES ($1, 'role', $2, 0, $3)`,
        [channelId, everyoneId, Permission.VIEW_CHANNEL],
      );

      const started = await startOnServer(host);
      expect(started.status).toBe(200);
      expect(started.body.channel.id).toBe(channelId);

      const overwrite = await getPool().query<{ allow: string; deny: string }>(
        `SELECT allow, deny FROM channel_overwrites
          WHERE channel_id = $1 AND target_type = 'role' AND target_id = $2`,
        [channelId, everyoneId],
      );
      expect(BigInt(overwrite.rows[0]!.deny) & BigInt(Permission.VIEW_CHANNEL)).not.toBe(
        0n,
      );
      expect(
        BigInt(overwrite.rows[0]!.allow) & BigInt(Permission.VIEW_CHANNEL),
      ).toBe(0n);
    });

    it("makes the room on demand for a server that has none", async () => {
      await getPool().query(`DELETE FROM channels WHERE id = $1`, [channelId]);

      const started = await startOnServer(host);
      expect(started.status).toBe(200);
      expect(started.body.channel.type).toBe("watch_party");
      // Handed back whole, because the client has never seen it and has to put
      // it in its own list before it can select it.
      expect(typeof started.body.channel.name).toBe("string");
    });

    it("reuses the same room for a second party, so rooms do not accumulate", async () => {
      const first = await startOnServer(host);
      expect(first.status).toBe(200);
      expect(
        (await setState(host, first.body.party.id, "cancelled")).status,
      ).toBe(200);

      const second = await startOnServer(host);
      expect(second.status).toBe(200);
      expect(second.body.channel.id).toBe(first.body.channel.id);

      const rooms = await getPool().query(
        `SELECT id FROM channels WHERE server_id = $1 AND type = 'watch_party'`,
        [serverId],
      );
      expect(rooms.rowCount).toBe(1);
    });

    it("refuses a second party while one is already running in that room", async () => {
      expect((await startOnServer(host)).status).toBe(200);
      // One room per server plus one active party per room is one live party
      // per server, which is the cardinality the sidebar block assumes.
      expect((await startOnServer(host)).status).toBe(409);
    });
  });
});
