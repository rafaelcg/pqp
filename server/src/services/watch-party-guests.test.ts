import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
const { createServer: createChatServer, createChannel } = await import(
  "./servers.js"
);
const { createRole, assignRole } = await import("./roles.js");
const { WATCH_PARTY_MAX_GUESTS } = await import("@pqp/shared");
const { Permission } = await import("@pqp/shared");

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
});
