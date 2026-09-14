import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * CONVIDADOS: who may request, accept, invite, remove, and the cap.
 *
 * `watch-party-options.test.ts` next door pins the SPEAK-overwrite mechanics
 * (the floor closing and reopening, the grant surviving a co-host demotion).
 * This file pins the guest queue itself: the four permission rules
 * (`docs/plans/WATCH_PARTY_GUESTS.md` §5.8), the three-guest cap and the race
 * on its last slot, and that an old stored party migrates to the right
 * `guests` mode on the way out. Same harness: a real node:http server over
 * the real router, a real Postgres, only the identity layer stubbed.
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
const { joinWatchPartyGuestSlot, getWatchPartyRow } = await import(
  "./watch-parties.js"
);
const { createServer: createChatServer, createChannel } = await import(
  "./servers.js"
);
const { createRole, assignRole } = await import("./roles.js");
const { WATCH_PARTY_MAX_GUESTS } = await import("@pqp/shared");
const { Permission } = await import("@pqp/shared");
const { setAuthenticatedSocket, deleteAuthenticatedSocket } = await import(
  "../ws/sockets.js"
);
type FakeSocket = { readyState: number; send: (data: string) => void };

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

interface Person {
  userId: string;
  displayName: string;
}

interface PartyBody {
  id: string;
  state: string;
  options: { guests: string };
  guests: {
    onAir: Person[];
    invited: Person[];
    requests: Person[];
    requestCount: number;
    requested: boolean;
    position: number | null;
  };
  /** DEPRECATED compat mirror -- see `legacyWatchPartyStageOf`. */
  stage: {
    invited: Person[];
    hands: Person[];
    handRaised: boolean;
  };
}

describeDb("watch party guests", () => {
  let owner: User;
  /** The host, deliberately not the owner — see watch-party-options.test.ts. */
  let host: User;
  let second: User;
  let viewer: User;
  let viewer2: User;
  let viewer3: User;

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
    // See watch-party-options.test.ts: broadcastWatchParty is fire-and-forget
    // and a TRUNCATE racing it deadlocks rather than waits.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    resetApiRateLimits();

    const makeUser = (name: string) =>
      upsertUser({ clerkId: `clerk_${name}`, displayName: name, avatarUrl: null });
    owner = await makeUser("owner");
    host = await makeUser("host");
    second = await makeUser("second");
    viewer = await makeUser("viewer");
    viewer2 = await makeUser("viewer2");
    viewer3 = await makeUser("viewer3");

    const created = await createChatServer("Cinemoon", owner.id);
    serverId = created.server.id;
    const channel = await createChannel(serverId, "sessao-da-tarde", "watch_party");
    channelId = channel.id;

    for (const user of [host, second, viewer, viewer2, viewer3]) {
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
        [serverId, user.id],
      );
    }
    const hostRole = await createRole(serverId, {
      name: "Apresentador",
      permissions: Permission.START_WATCH_PARTY,
    });
    await assignRole(serverId, host.id, hostRole.id);
  });

  // --------------------------------------------------------------- helpers

  /** One active party per channel, so a test needing several makes several. */
  async function freshChannel(): Promise<string> {
    const channel = await createChannel(
      serverId,
      `sessao-${Math.random().toString(36).slice(2, 8)}`,
      "watch_party",
    );
    return channel.id;
  }

  async function liveParty(
    options: Record<string, unknown> = { guests: "request" },
    channel: string = channelId,
  ): Promise<PartyBody> {
    const created = await call<{ party: PartyBody }>(
      host,
      "POST",
      `/api/channels/${channel}/watch-parties`,
      { name: "Sessão do Rafa", options },
    );
    expect(created.status).toBe(200);
    const live = await call<{ party: PartyBody }>(
      host,
      "POST",
      `/api/watch-parties/${created.body.party.id}/state`,
      { state: "live" },
    );
    expect(live.status).toBe(200);
    return live.body.party;
  }

  const guests = (as: User, id: string, body: Record<string, unknown>) =>
    call<{ party: PartyBody | null }>(
      as,
      "POST",
      `/api/watch-parties/${id}/guests`,
      body,
    );

  // ----------------------------------------------------------- permissions

  it("refuses a viewer's invite/accept/decline/remove, 403", async () => {
    const party = await liveParty();
    for (const body of [
      { action: "invite", userId: second.id },
      { action: "accept", userId: second.id },
      { action: "decline", userId: second.id },
      { action: "remove", userId: second.id },
    ]) {
      const res = await guests(viewer, party.id, body);
      expect(res.status, JSON.stringify(body)).toBe(403);
    }
  });

  it("lets the host and a co-host invite, accept, decline and remove", async () => {
    const party = await liveParty({ guests: "invite" });
    expect(
      (await guests(host, party.id, { action: "invite", userId: viewer.id })).status,
    ).toBe(200);

    const promote = await call(host, "POST", `/api/watch-parties/${party.id}/cohosts`, {
      userId: second.id,
      cohost: true,
    });
    expect(promote.status).toBe(200);
    expect(
      (await guests(second, party.id, { action: "invite", userId: viewer2.id }))
        .status,
    ).toBe(200);
    expect(
      (await guests(second, party.id, { action: "remove", userId: viewer.id }))
        .status,
    ).toBe(200);
  });

  it("refuses a request unless guests is \"request\"", async () => {
    const off = await liveParty({ guests: "off" }, await freshChannel());
    expect((await guests(viewer, off.id, { action: "request" })).status).toBe(
      403,
    );

    const invite = await liveParty({ guests: "invite" }, await freshChannel());
    expect(
      (await guests(viewer, invite.id, { action: "request" })).status,
    ).toBe(403);

    const request = await liveParty({ guests: "request" }, await freshChannel());
    expect(
      (await guests(viewer, request.id, { action: "request" })).status,
    ).toBe(200);
  });

  it("lets a viewer withdraw their own request and nobody else's", async () => {
    const party = await liveParty({ guests: "request" });
    expect((await guests(viewer, party.id, { action: "request" })).status).toBe(
      200,
    );
    // `withdraw` takes no userId: it is always the caller's own row.
    const mine = await guests(viewer, party.id, { action: "withdraw" });
    expect(mine.status).toBe(200);
    expect(mine.body.party?.guests.requested).toBe(false);
  });

  it("lets only the invited person themselves join or leave", async () => {
    const party = await liveParty({ guests: "invite" });
    expect(
      (await guests(host, party.id, { action: "invite", userId: viewer.id }))
        .status,
    ).toBe(200);

    // `join`/`leave` need no userId in the body — they are always the
    // caller's own row, not an action on somebody else's.
    const wrongPerson = await guests(second, party.id, { action: "join" });
    // Nothing to confirm for `second`: refused as "no invitation", not as a
    // permission error, because `join`/`leave` need only the ability to see
    // the party.
    expect(wrongPerson.status).toBe(404);

    const joined = await guests(viewer, party.id, { action: "join" });
    expect(joined.status).toBe(200);
    expect(joined.body.party?.guests.onAir.map((p) => p.userId)).toEqual([
      viewer.id,
    ]);

    const left = await guests(viewer, party.id, { action: "leave" });
    expect(left.status).toBe(200);
    expect(left.body.party?.guests.onAir).toEqual([]);
  });

  // ------------------------------------------------------------------ cap

  it(`refuses a ${WATCH_PARTY_MAX_GUESTS + 1}th guest on air with 409, and the reason is readable`, async () => {
    expect(WATCH_PARTY_MAX_GUESTS).toBe(3);
    const party = await liveParty({ guests: "invite" });
    const extra = await upsertUser({
      clerkId: "clerk_fourth",
      displayName: "fourth",
      avatarUrl: null,
    });
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, extra.id],
    );

    for (const person of [second, viewer, viewer2]) {
      expect(
        (await guests(host, party.id, { action: "invite", userId: person.id }))
          .status,
      ).toBe(200);
      expect(
        (await guests(person, party.id, { action: "join" })).status,
      ).toBe(200);
    }

    expect(
      (await guests(host, party.id, { action: "invite", userId: extra.id }))
        .status,
    ).toBe(200);
    const refused = await guests(extra, party.id, { action: "join" });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toMatch(/3/);
  });

  it("lets exactly one of two simultaneous joins take the last slot", async () => {
    // Driven at the SERVICE layer, not through `call()`/`fetch()`: the HTTP
    // harness's `actor` is one shared mutable variable standing in for
    // Clerk, so two genuinely concurrent requests would both authenticate as
    // whichever one last assigned it before either reached the server — a
    // harness artifact, not the race this test means to exercise. Calling
    // `joinWatchPartyGuestSlot` directly for two distinct real users is the
    // race itself: two Postgres transactions racing `SELECT ... FOR UPDATE`
    // on the same session row.
    const { getWatchPartyRow, joinWatchPartyGuestSlot, WatchPartyGuestsError } =
      await import("./watch-parties.js");
    const party = await liveParty({ guests: "invite" });
    for (const person of [second, viewer]) {
      expect(
        (await guests(host, party.id, { action: "invite", userId: person.id }))
          .status,
      ).toBe(200);
      expect(
        (await guests(person, party.id, { action: "join" })).status,
      ).toBe(200);
    }
    // Two on air, room for exactly one more.
    for (const person of [viewer2, viewer3]) {
      expect(
        (await guests(host, party.id, { action: "invite", userId: person.id }))
          .status,
      ).toBe(200);
    }

    const row = (await getWatchPartyRow(party.id))!;
    const attempt = (userId: string) =>
      joinWatchPartyGuestSlot(row, userId).then(
        () => "ok" as const,
        (error) =>
          error instanceof WatchPartyGuestsError && error.code === "full"
            ? ("full" as const)
            : Promise.reject(error),
      );
    const [a, b] = await Promise.all([
      attempt(viewer2.id),
      attempt(viewer3.id),
    ]);
    expect([a, b].sort()).toEqual(["full", "ok"]);

    const finalCount = await getPool().query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM channel_session_stage_invites
        WHERE session_id = $1 AND accepted_at IS NOT NULL`,
      [party.id],
    );
    expect(Number(finalCount.rows[0]?.n)).toBe(WATCH_PARTY_MAX_GUESTS);
  });

  it("an unanswered invitation does not hold a slot", async () => {
    const party = await liveParty({ guests: "invite" });
    for (const person of [second, viewer, viewer2]) {
      expect(
        (await guests(host, party.id, { action: "invite", userId: person.id }))
          .status,
      ).toBe(200);
    }
    // Three PENDING invitations, none accepted: the room is still empty, and
    // a fourth invite (still just a call-up, not a slot) is not refused.
    const fourthInvite = await guests(host, party.id, {
      action: "invite",
      userId: viewer3.id,
    });
    expect(fourthInvite.status).toBe(200);
    expect(fourthInvite.body.party?.guests.onAir).toEqual([]);
  });

  // ----------------------------------------------------------- migration

  it("migrates an old-format stored party to the right guests mode", async () => {
    const created = await call<{ party: PartyBody }>(
      host,
      "POST",
      `/api/channels/${channelId}/watch-parties`,
      { name: "Sessão antiga" },
    );
    expect(created.status).toBe(200);
    // Written the way a build before this feature would: no `guests` key.
    await getPool().query(
      `UPDATE channel_sessions
          SET options = '{"voiceEnabled":true,"stageMode":"invited","raiseHand":true}'::jsonb
        WHERE id = $1`,
      [created.body.party.id],
    );
    const read = await call<{ party: PartyBody }>(
      host,
      "GET",
      `/api/channels/${channelId}/watch-party`,
    );
    expect(read.body.party?.options.guests).toBe("request");
  });

  // ------------------------------------------------------ legacy compat

  it("the deprecated `stage.invited` mirror still carries an accepted guest", async () => {
    // `watch-party-panel.tsx` (frozen ahead of #538) reads `party.stage.invited`
    // to decide whether it draws "Entrar no palco"; if this ever goes back to
    // being hardcoded empty, that button silently stops appearing for anyone
    // the host actually brought up.
    const party = await liveParty({ guests: "invite" });
    expect(
      (await guests(host, party.id, { action: "invite", userId: viewer.id }))
        .status,
    ).toBe(200);
    const joined = await guests(viewer, party.id, { action: "join" });
    expect(joined.status).toBe(200);
    expect(joined.body.party?.stage.invited.map((p) => p.userId)).toEqual([
      viewer.id,
    ]);
  });

  it("the deprecated `stage.hands`/`handRaised` mirror the request queue", async () => {
    const requestChannel = await freshChannel();
    const party = await liveParty({ guests: "request" }, requestChannel);
    const requested = await guests(viewer2, party.id, { action: "request" });
    expect(requested.status).toBe(200);
    // The requester's own copy: `handRaised` true, and they are in `hands`
    // (host/co-host visibility does not apply to one's own row).
    expect(requested.body.party?.stage.handRaised).toBe(true);
    // The host's copy: the same row, from the other side.
    const hostView = await call<{ party: PartyBody }>(
      host,
      "GET",
      `/api/channels/${requestChannel}/watch-party`,
    );
    expect(hostView.status).toBe(200);
    expect(hostView.body.party?.stage.hands.map((p) => p.userId)).toContain(
      viewer2.id,
    );
  });

  it("`raise`/`lower` (a stale tab's request/withdraw) still work on the same route", async () => {
    // §2.3: `raiseHand` is gone from the schema, and `raise`/`lower` are gone
    // from the action vocabulary, but `watch-party-panel.tsx` still sends
    // them (it is frozen ahead of #538) and this route is the only door a
    // stale tab has. They must keep meaning exactly `request`/`withdraw`.
    const party = await liveParty({ guests: "request" });
    const raised = await guests(viewer, party.id, { action: "raise" });
    expect(raised.status).toBe(200);
    expect(raised.body.party?.guests.requested).toBe(true);
    expect(raised.body.party?.stage.handRaised).toBe(true);

    const lowered = await guests(viewer, party.id, { action: "lower" });
    expect(lowered.status).toBe(200);
    expect(lowered.body.party?.guests.requested).toBe(false);
  });

  // ------------------------------------------------------------ the wire

  it("broadcasts the request queue and the accepted guest to a DIFFERENT socket, not just the actor", async () => {
    // THE BUG THIS PINS (2026-09-14): `broadcastWatchParty` called
    // `mapWatchParty` with no `guests` argument at all, so every socket but
    // the actor's own HTTP response saw an empty queue and an empty stage
    // until their own next unrelated action refreshed it. The actor always
    // sees their own change correctly (the HTTP response, asserted by every
    // other test in this file); only a SECOND, uninvolved socket proves the
    // fan-out itself carries the state.
    const party = await liveParty({ guests: "request" });
    const sent: unknown[] = [];
    const fakeHostSocket: FakeSocket = {
      readyState: 1,
      send: (data: string) => sent.push(JSON.parse(data)),
    };
    setAuthenticatedSocket(
      fakeHostSocket as unknown as WebSocket,
      host as unknown as DbUser,
      [],
    );
    try {
      const requested = await guests(viewer, party.id, { action: "request" });
      expect(requested.status).toBe(200);
      // Give the fire-and-forget `void broadcastWatchParty(...)` its turn.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const updates = sent.filter(
        (frame): frame is { type: string; party: PartyBody | null } =>
          (frame as { type?: string }).type === "watch-party-update",
      );
      expect(updates.length).toBeGreaterThan(0);
      const last = updates[updates.length - 1]!.party;
      expect(last?.guests.requests.map((p) => p.userId)).toEqual([viewer.id]);
      expect(last?.guests.requestCount).toBe(1);
      expect(last?.stage.hands.map((p) => p.userId)).toEqual([viewer.id]);
    } finally {
      deleteAuthenticatedSocket(fakeHostSocket as unknown as WebSocket);
    }
  });

  it("broadcasting to 500 sockets loads the guest rows a fixed number of times, not once per recipient", async () => {
    // SATURDAY'S PARTY IS THE REASON FOR THIS TEST. `broadcastWatchParty`
    // loads `channel_session_stage_invites`/`channel_session_raised_hands`
    // ONCE per fan-out and reshapes the same rows per recipient
    // (`prepareWatchPartyGuests`/`shapeWatchPartyGuests`, no query of their
    // own) -- this pins that the query count does not scale with the
    // audience, which nothing short of an actual 500-socket broadcast can
    // prove.
    // 500 real, distinct server members, each with a fake socket watching —
    // bulk-inserted rather than 500 round trips through `upsertUser`/
    // `createRole`-style helpers, which this scale test has no need of.
    // BEFORE the party goes live: `getChannelAudience` caches its answer on
    // the first read, which going live already triggers, so a member
    // inserted afterwards needs its own cache invalidation to be seen — this
    // test is about the guest query, not the audience cache, so it sidesteps
    // that entirely by existing first.
    const scaleUserIds = Array.from({ length: 500 }, () => randomUUID());
    const userValues = scaleUserIds
      .map((id, i) => `('${id}', 'clerk_scale_${i}', 'scale-${i}', NULL)`)
      .join(",");
    await getPool().query(
      `INSERT INTO users (id, clerk_id, display_name, avatar_url) VALUES ${userValues}`,
    );
    const memberValues = scaleUserIds
      .map((id) => `('${serverId}', '${id}', 'member')`)
      .join(",");
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ${memberValues}`,
    );

    const party = await liveParty({ guests: "request" });
    // `liveParty`'s own two writes (draft, then live) each fire their own
    // `void broadcastWatchParty(...)` in the background; let those finish
    // before the spy below attaches, or their still-in-flight queries would
    // be counted alongside the one broadcast this test is actually about.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const sent: unknown[] = [];
    const scaleSockets = scaleUserIds.map((id) => {
      const socket: FakeSocket = {
        readyState: 1,
        send: (data: string) => sent.push(JSON.parse(data)),
      };
      setAuthenticatedSocket(
        socket as unknown as WebSocket,
        { id } as unknown as DbUser,
        [],
      );
      return socket;
    });

    const pool = getPool();
    const querySpy = vi.spyOn(pool, "query");
    try {
      const requested = await guests(viewer, party.id, { action: "request" });
      expect(requested.status).toBe(200);
      // 500 sockets, 500 permission resolutions and 500 sends: give the
      // fire-and-forget broadcast real time to walk all of them.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const guestRowQueries = querySpy.mock.calls.filter(([text]) =>
        typeof text === "string" &&
        text.includes("channel_session_stage_invites") &&
        text.includes("i.invited_at"),
      );
      // At most two: the actor's own HTTP response (`presentWatchParty`) and
      // the broadcast fan-out (`loadGuestRowsForBroadcast`) each load the
      // rows once. Neither scales with the 500 recipients that follow.
      expect(guestRowQueries.length).toBeLessThanOrEqual(2);
      expect(guestRowQueries.length).toBeGreaterThan(0);

      const updates = sent.filter(
        (frame) => (frame as { type?: string }).type === "watch-party-update",
      );
      // Every recipient actually got a frame — the query count above is not
      // low because the fan-out silently skipped people.
      expect(updates.length).toBe(500);
    } finally {
      querySpy.mockRestore();
      for (const socket of scaleSockets) {
        deleteAuthenticatedSocket(socket as unknown as WebSocket);
      }
    }
  }, 20_000);

  it("a transient guest-rows failure during the fan-out keeps the last known state, never an empty one", async () => {
    // THE FAILURE MODE THIS PINS: a Postgres hiccup mid-broadcast used to
    // fall through to `mapWatchParty`'s empty default and ship THAT to
    // every recipient as if it were the truth -- for a live 500-viewer
    // party, that reads as every guest going silent at once. Keeping the
    // last successfully loaded snapshot and falling back to it is "never
    // emit empty" made literal.
    const party = await liveParty({ guests: "invite" });
    expect(
      (await guests(host, party.id, { action: "invite", userId: viewer.id }))
        .status,
    ).toBe(200);
    expect((await guests(viewer, party.id, { action: "join" })).status).toBe(
      200,
    );

    const sent: unknown[] = [];
    const fakeHostSocket: FakeSocket = {
      readyState: 1,
      send: (data: string) => sent.push(JSON.parse(data)),
    };
    setAuthenticatedSocket(
      fakeHostSocket as unknown as WebSocket,
      host as unknown as DbUser,
      [],
    );

    const { broadcastWatchParty } = await import("../ws/watch-party-events.js");
    try {
      // Warm the fallback with a real, successful broadcast that reflects
      // the accepted guest above, then discard that frame -- the test is
      // about what happens on the NEXT broadcast, not this one.
      await broadcastWatchParty(party.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      sent.length = 0;

      const pool = getPool();
      const realQuery = pool.query.bind(pool) as typeof pool.query;
      const querySpy = vi
        .spyOn(pool, "query")
        .mockImplementation(((...args: Parameters<typeof pool.query>) => {
          const text = args[0];
          if (
            typeof text === "string" &&
            text.includes("channel_session_stage_invites") &&
            text.includes("i.invited_at")
          ) {
            return Promise.reject(new Error("simulated transient failure"));
          }
          return realQuery(...args);
        }) as typeof pool.query);

      try {
        await broadcastWatchParty(party.id);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } finally {
        querySpy.mockRestore();
      }

      const updates = sent.filter(
        (frame) => (frame as { type?: string }).type === "watch-party-update",
      );
      expect(updates.length).toBeGreaterThan(0);
      const last = updates[updates.length - 1] as {
        party: PartyBody | null;
      };
      // NEVER EMPTY: the accepted guest from before the simulated failure
      // is still there, not silently replaced with an empty onAir list.
      expect(last.party?.guests.onAir.map((p) => p.userId)).toEqual([
        viewer.id,
      ]);
      expect(last.party?.stage.invited.map((p) => p.userId)).toEqual([
        viewer.id,
      ]);
    } finally {
      deleteAuthenticatedSocket(fakeHostSocket as unknown as WebSocket);
    }
  });

  // ------------------------------------------------ moderation and staleness

  it("refuses to remove somebody who was never a guest, 404, before touching anything", async () => {
    // FINDING 4: `remove`'s SFU moderation (mute, revoke, evict) used to run
    // before anything checked that `userId` was ever invited or accepted at
    // all -- `manageGuests` authorises the CALLER, not the target. `second`
    // here is an ordinary server member, never invited to this party.
    const party = await liveParty({ guests: "invite" });
    const attempt = await guests(host, party.id, {
      action: "remove",
      userId: second.id,
    });
    expect(attempt.status).toBe(404);
  });

  it("still removes an actual accepted guest normally", async () => {
    const party = await liveParty({ guests: "invite" });
    expect(
      (await guests(host, party.id, { action: "invite", userId: viewer.id }))
        .status,
    ).toBe(200);
    expect((await guests(viewer, party.id, { action: "join" })).status).toBe(
      200,
    );
    const removed = await guests(host, party.id, {
      action: "remove",
      userId: viewer.id,
    });
    expect(removed.status).toBe(200);
    expect(removed.body.party?.guests.onAir).toEqual([]);
  });

  it("re-reads the party's live status and options inside the join transaction, not the caller's stale row", async () => {
    // FINDING 5: `joinWatchPartyGuestSlot` used to decide the post-accept
    // SPEAK grant from the `row` its HTTP caller had already fetched BEFORE
    // this function's own transaction opened. A host flipping `guests` back
    // to `off` in the gap between that read and this write landing must not
    // still grant SPEAK on a floor that is no longer closed -- the fix reads
    // `status`/`options` fresh, under the row's own `FOR UPDATE` lock, so
    // this test calls the service function directly with a DELIBERATELY
    // stale row to prove it does.
    const party = await liveParty({ guests: "invite" });
    expect(
      (await guests(host, party.id, { action: "invite", userId: viewer.id }))
        .status,
    ).toBe(200);

    // The STALE row: fetched while `guests` was still `invite` (floor
    // closed) -- exactly what `requireWatchParty` hands the route a moment
    // before a concurrent change lands.
    const staleRow = await getWatchPartyRow(party.id);
    expect(staleRow).not.toBeNull();

    // The concurrent change: the host turns Convidados back off, mid-party
    // (not ending it, which would delete the invite row this test still
    // needs `joinWatchPartyGuestSlot` to find).
    expect(
      (
        await call(host, "PATCH", `/api/watch-parties/${party.id}`, {
          options: { guests: "off" },
        })
      ).status,
    ).toBe(200);

    // The join lands after that, but is handed the STALE row.
    await joinWatchPartyGuestSlot(staleRow!, viewer.id);

    // No SPEAK overwrite was written: the transaction's OWN re-read saw the
    // floor was open by the time `accepted_at` landed, not the closed floor
    // the stale row still claimed.
    const overwrite = await getPool().query(
      `SELECT 1 FROM channel_overwrites
        WHERE channel_id = $1 AND target_type = 'member' AND target_id = $2`,
      [channelId, viewer.id],
    );
    expect(overwrite.rowCount).toBe(0);
  });

  it("still grants SPEAK on an ordinary join with no concurrent change -- proves the test above is about staleness, not a broken grant path", async () => {
    const party = await liveParty({ guests: "invite" });
    expect(
      (await guests(host, party.id, { action: "invite", userId: viewer.id }))
        .status,
    ).toBe(200);
    const row = await getWatchPartyRow(party.id);
    await joinWatchPartyGuestSlot(row!, viewer.id);
    const overwrite = await getPool().query<{ allow: string }>(
      `SELECT allow FROM channel_overwrites
        WHERE channel_id = $1 AND target_type = 'member' AND target_id = $2`,
      [channelId, viewer.id],
    );
    expect(overwrite.rowCount).toBe(1);
  });
});
