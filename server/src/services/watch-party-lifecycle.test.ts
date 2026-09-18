import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE PARTY SESSION'S OWN LIFECYCLE, on a real Postgres.
 *
 * `watch-parties.test.ts` next door pins the journey a host takes. This one
 * pins what happens when nobody takes it: a draft somebody walked away from,
 * a live party whose host closed the laptop, and an Encerrar pressed on a
 * party the server had already ended.
 *
 * Every case here is something production did on 2026-09-18, in one channel,
 * in eighty minutes:
 *
 *   * A CO-HOST'S ABANDONED DRAFT BLOCKED THE CHANNEL. `POST .../watch-parties`
 *     answered 409 "This channel already has a watch party being set up,
 *     scheduled, or live" to everyone, and the SERVER OWNER got 404 from the
 *     state route, because a draft is invisible to a manager by design. It
 *     took an UPDATE against production Postgres to clear.
 *   * A LIVE PARTY THE SERVER ITSELF ENDED STAYED LIVE ON EVERY SCREEN, and
 *     pressing Encerrar on the ghost answered 403 "A host may not end a ended
 *     watch party" (the grammar was the least of it).
 *   * NOTHING ENDED A PARTY WHOSE HOST WAS GONE except a five-minute sweep
 *     that would happily have cut off a co-host mid-film, because it never
 *     asked whether anything was playing.
 *
 * Same harness as `watch-parties.test.ts`: the real HTTP router, the real
 * SQL, only the identity layer stubbed.
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
  markWatchPartyHostGone,
  resetWatchPartySweepCountersForTests,
  sweepStaleWatchPartyDrafts,
  sweepWatchPartyHosts,
  watchPartySweepCounters,
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
  hostUserId: string;
}

describeDb("watch party lifecycle", () => {
  /** Owns the server. Holds every bit. Never the host in these tests. */
  let owner: User;
  /** Holds START_WATCH_PARTY. The host of almost every party below. */
  let host: User;
  /** A second holder of START_WATCH_PARTY: the person the ghost blocks. */
  let other: User;
  /** Holds MANAGE_CHANNELS only. */
  let manager: User;
  /** Holds nothing beyond @everyone. */
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
    // Those queries are still in flight when the next test begins and
    // TRUNCATE wants a lock they hold, which Postgres reports as a deadlock
    // rather than a wait. A tick lets them finish first.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    resetApiRateLimits();
    resetWatchPartySweepCountersForTests();

    const makeUser = (name: string) =>
      upsertUser({ clerkId: `clerk_${name}`, displayName: name, avatarUrl: null });
    owner = await makeUser("owner");
    host = await makeUser("host");
    other = await makeUser("other");
    manager = await makeUser("manager");
    member = await makeUser("member");

    const created = await createChatServer("Cinemoon", owner.id);
    serverId = created.server.id;
    const channel = await createChannel(serverId, "sessao-da-tarde", "watch_party");
    channelId = channel.id;

    for (const user of [host, other, manager, member]) {
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
    await assignRole(serverId, other.id, hostRole.id);
    const managerRole = await createRole(serverId, {
      name: "GerenteDeCanais",
      permissions: Permission.MANAGE_CHANNELS,
    });
    await assignRole(serverId, manager.id, managerRole.id);
  });

  // ------------------------------------------------------------- the helpers

  async function create(as: User, body: Record<string, unknown> = {}) {
    return call<{ party: PartyBody; blockingParty?: { sessionId: string } }>(
      as,
      "POST",
      `/api/channels/${channelId}/watch-parties`,
      { name: "Sessão do Rafa", ...body },
    );
  }

  async function draft(as: User = host) {
    const created = await create(as);
    expect(created.status).toBe(200);
    return created.body.party;
  }

  const setState = (as: User, id: string, state: string) =>
    call<{ party: PartyBody; error?: string }>(
      as,
      "POST",
      `/api/watch-parties/${id}/state`,
      { state },
    );

  const statusOf = async (sessionId: string) => {
    const result = await getPool().query<{ status: string }>(
      `SELECT status FROM channel_sessions WHERE id = $1`,
      [sessionId],
    );
    return result.rows[0]?.status ?? null;
  };

  /** Backdate a row so the age-based rules can be exercised without waiting. */
  const ageRow = (sessionId: string, minutes: number) =>
    getPool().query(
      `UPDATE channel_sessions
          SET created_at = NOW() - ($2 || ' minutes')::interval,
              updated_at = NOW() - ($2 || ' minutes')::interval
        WHERE id = $1`,
      [sessionId, String(minutes)],
    );

  /** An open, unended `hls_sessions` row: something IS playing on this channel. */
  const startFakeStream = (id = "rung") =>
    getPool().query(
      `INSERT INTO hls_sessions (channel_id, object_prefix, started_at)
       VALUES ($1, $2, NOW())`,
      [channelId, `live/${channelId}/${id}`],
    );

  // ------------------------------------------------- A. idempotent terminals

  it("treats Encerrar on an already ended party as a success", async () => {
    const party = await draft();
    expect((await setState(host, party.id, "live")).status).toBe(200);
    expect((await setState(host, party.id, "ended")).status).toBe(200);

    // The exact 2026-09-18 click: a second tab, or a host whose party the
    // server ended behind them, pressing Encerrar on a dead party.
    const again = await setState(host, party.id, "ended");
    expect(again.status).toBe(200);
    expect(again.body.party.state).toBe("ended");
    expect(again.body.party.id).toBe(party.id);
  });

  it("treats Descartar on an already cancelled draft as a success", async () => {
    const party = await draft();
    expect((await setState(host, party.id, "cancelled")).status).toBe(200);

    const again = await setState(host, party.id, "cancelled");
    expect(again.status).toBe(200);
    expect(again.body.party.state).toBe("cancelled");
  });

  it("accepts either terminal word for a party that reached the other one", async () => {
    // A cancelled draft asked to "end", and an ended party asked to
    // "cancel": both are somebody restating where the party already is,
    // and neither is a move. The alternative is an error message about a
    // distinction only this codebase cares about.
    const cancelled = await draft();
    expect((await setState(host, cancelled.id, "cancelled")).status).toBe(200);
    expect((await setState(host, cancelled.id, "ended")).status).toBe(200);
    expect(await statusOf(cancelled.id)).toBe("cancelled");

    const ended = await draft();
    expect((await setState(host, ended.id, "live")).status).toBe(200);
    expect((await setState(host, ended.id, "ended")).status).toBe(200);
    expect((await setState(host, ended.id, "cancelled")).status).toBe(200);
    expect(await statusOf(ended.id)).toBe("ended");
  });

  it("still refuses a real move out of a terminal state, and says so properly", async () => {
    const party = await draft();
    expect((await setState(host, party.id, "live")).status).toBe(200);
    expect((await setState(host, party.id, "ended")).status).toBe(200);

    // Idempotence is for the two terminal words only. Asking a dead party
    // to go live again is a request for a move, and it is refused.
    const relive = await setState(host, party.id, "live");
    expect(relive.status).toBe(403);
    // The grammar Rafael photographed: "a ended watch party".
    expect(relive.body.error).not.toContain("a ended");
    expect(relive.body.error).toContain("already ended");
  });

  it("does not let a plain member end a party by asking twice", async () => {
    const party = await draft();
    expect((await setState(host, party.id, "live")).status).toBe(200);
    expect((await setState(host, party.id, "ended")).status).toBe(200);

    // Idempotence is not an open door: somebody who could never have ended
    // this party is still refused, with a sentence that reads.
    const byMember = await setState(member, party.id, "ended");
    expect(byMember.status).toBe(403);
    expect(byMember.body.error).toContain("already ended");
  });

  // ------------------------------------------------- B. the staff override

  it("lets a MANAGE_CHANNELS manager cancel a draft they cannot even see", async () => {
    const stuck = await draft();
    // The 2026-09-18 404: a draft is invisible to a manager, so the route
    // that would clear it denied the draft existed.
    expect((await call(manager, "GET", `/api/channels/${channelId}/watch-party`)).body)
      .toEqual({ party: null });

    const cancelled = await setState(manager, stuck.id, "cancelled");
    expect(cancelled.status).toBe(200);
    expect(await statusOf(stuck.id)).toBe("cancelled");

    // And the channel is usable again by the person who was blocked.
    expect((await create(other)).status).toBe(200);
  });

  it("lets a START_WATCH_PARTY holder end somebody else's live party", async () => {
    const party = await draft();
    expect((await setState(host, party.id, "live")).status).toBe(200);

    const ended = await setState(other, party.id, "ended");
    expect(ended.status).toBe(200);
    expect(await statusOf(party.id)).toBe("ended");
  });

  it("refuses the override to somebody holding neither bit", async () => {
    const party = await draft();
    expect((await setState(host, party.id, "live")).status).toBe(200);

    const byMember = await setState(member, party.id, "ended");
    expect(byMember.status).toBe(403);
    expect(await statusOf(party.id)).toBe("live");
  });

  it("keeps a draft invisible to staff everywhere except the cancel", async () => {
    await draft();
    // The override is `end`/`cancel` and nothing else. A draft is still
    // absent from the server-wide list a manager reads, so it never appears
    // in anybody's sidebar.
    const list = await call<{ parties: unknown[] }>(
      manager,
      "GET",
      `/api/servers/${serverId}/watch-parties`,
    );
    expect(list.body.parties).toEqual([]);
  });

  it("never lets the override reach a non-member", async () => {
    const outsider = await upsertUser({
      clerkId: "clerk_outsider",
      displayName: "outsider",
      avatarUrl: null,
    });
    const party = await draft();
    expect((await setState(host, party.id, "live")).status).toBe(200);

    const refused = await setState(outsider, party.id, "ended");
    expect(refused.status).toBe(404);
    expect(await statusOf(party.id)).toBe("live");
  });

  // ------------------------------------- B (cont). the blocked create

  it("names the party that is blocking a create", async () => {
    const stuck = await draft();
    // `other` holds START_WATCH_PARTY but is connected to nothing, and the
    // draft is fresh and its host is not connected either, so this create
    // supersedes rather than conflicts. Keep the host present by making the
    // blocking party a SCHEDULED one, which is never superseded.
    await getPool().query(
      `UPDATE channel_sessions SET status = 'scheduled', starts_at = NOW() + INTERVAL '1 hour'
        WHERE id = $1`,
      [stuck.id],
    );
    const blocked = await create(other);
    expect(blocked.status).toBe(409);
    expect(blocked.body.blockingParty?.sessionId).toBe(stuck.id);
  });

  it("supersedes an abandoned draft instead of refusing the next create", async () => {
    const stuck = await draft();
    // Nobody holds a socket in this process, so the draft's host reads as
    // gone: exactly the production case, where the sheet's tab was closed.
    const next = await create(other);
    expect(next.status).toBe(200);
    expect(next.body.party.id).not.toBe(stuck.id);
    expect(await statusOf(stuck.id)).toBe("cancelled");
    expect(watchPartySweepCounters().supersededDrafts).toBe(1);
  });

  it("lets a host start over on top of their own abandoned draft", async () => {
    const first = await draft(host);
    const second = await create(host);
    expect(second.status).toBe(200);
    expect(second.body.party.id).not.toBe(first.id);
    expect(await statusOf(first.id)).toBe("cancelled");
  });

  it("never supersedes a live party", async () => {
    const party = await draft();
    expect((await setState(host, party.id, "live")).status).toBe(200);

    const blocked = await create(other);
    expect(blocked.status).toBe(409);
    expect(blocked.body.blockingParty?.sessionId).toBe(party.id);
    expect(await statusOf(party.id)).toBe("live");
  });

  // ------------------------------------------------------- C. the two sweeps

  it("cancels a draft nobody came back for, and leaves a fresh one alone", async () => {
    // Two drafts, one per channel, because one active party per channel is
    // a database constraint. The old one is swept; the new one is not.
    const stale = await draft(host);
    await ageRow(stale.id, 45);

    const secondChannel = await createChannel(serverId, "sessao-2", "watch_party");
    const fresh = await call<{ party: PartyBody }>(
      other,
      "POST",
      `/api/channels/${secondChannel.id}/watch-parties`,
      { name: "Hoje à noite" },
    );
    expect(fresh.status).toBe(200);

    const swept = await sweepStaleWatchPartyDrafts({
      ttlMinutes: 30,
      isConnected: () => false,
    });
    expect(swept.cancelled.map((c) => c.sessionId)).toEqual([stale.id]);
    expect(await statusOf(stale.id)).toBe("cancelled");
    expect(await statusOf(fresh.body.party.id)).toBe("draft");
    expect(watchPartySweepCounters().sweptDrafts).toBe(1);
  });

  it("leaves an old draft alone while its host is still connected", async () => {
    const party = await draft(host);
    await ageRow(party.id, 45);

    const swept = await sweepStaleWatchPartyDrafts({
      ttlMinutes: 30,
      isConnected: (userId) => userId === host.id,
    });
    expect(swept.cancelled).toEqual([]);
    expect(await statusOf(party.id)).toBe("draft");
  });

  it("does nothing at all when the draft TTL is zero", async () => {
    const party = await draft(host);
    await ageRow(party.id, 600);

    const swept = await sweepStaleWatchPartyDrafts({
      ttlMinutes: 0,
      isConnected: () => false,
    });
    expect(swept.cancelled).toEqual([]);
    expect(await statusOf(party.id)).toBe("draft");
  });

  it("ends a live party whose host is long gone", async () => {
    const party = await draft();
    expect((await setState(host, party.id, "live")).status).toBe(200);
    await markWatchPartyHostGone(host.id);

    const swept = await sweepWatchPartyHosts(Date.now(), 0);
    expect(swept.ended.map((e) => e.sessionId)).toEqual([party.id]);
    expect(swept.heldByLiveStream).toEqual([]);
    expect(await statusOf(party.id)).toBe("ended");
    expect(watchPartySweepCounters().sweptHostGone).toBe(1);
  });

  it("NEVER ends a party that still has a stream on it", async () => {
    // THE SAFETY ARGUMENT, made executable. A co-host presenting while the
    // host's laptop sleeps is an ordinary evening, and the sweep that
    // shipped before today would have cut the room off after five minutes.
    const party = await draft();
    expect((await setState(host, party.id, "live")).status).toBe(200);
    await markWatchPartyHostGone(host.id);
    await startFakeStream();

    const swept = await sweepWatchPartyHosts(Date.now(), 0);
    expect(swept.ended).toEqual([]);
    expect(swept.heldByLiveStream.map((h) => h.sessionId)).toEqual([party.id]);
    expect(await statusOf(party.id)).toBe("live");
    expect(watchPartySweepCounters().heldByLiveStream).toBe(1);

    // The hold is not permanent: the moment the stream's row is closed the
    // next tick ends the party.
    await getPool().query(
      `UPDATE hls_sessions SET ended_at = NOW() WHERE channel_id = $1`,
      [channelId],
    );
    const after = await sweepWatchPartyHosts(Date.now(), 0);
    expect(after.ended.map((e) => e.sessionId)).toEqual([party.id]);
    expect(await statusOf(party.id)).toBe("ended");
  });

  it("ignores a stale open stream row so a leak cannot make a party immortal", async () => {
    const party = await draft();
    expect((await setState(host, party.id, "live")).status).toBe(200);
    await markWatchPartyHostGone(host.id);
    await startFakeStream("ancient");
    await getPool().query(
      `UPDATE hls_sessions SET started_at = NOW() - INTERVAL '30 hours'
        WHERE channel_id = $1`,
      [channelId],
    );

    const swept = await sweepWatchPartyHosts(Date.now(), 0);
    expect(swept.ended.map((e) => e.sessionId)).toEqual([party.id]);
  });

  it("holds the party when the stream check itself cannot answer", async () => {
    const party = await draft();
    expect((await setState(host, party.id, "live")).status).toBe(200);
    await markWatchPartyHostGone(host.id);

    // Failing safe means never ending a party we cannot prove is off air.
    const swept = await sweepWatchPartyHosts(Date.now(), 0, {
      hasLiveStream: async () => {
        throw new Error("postgres blinked");
      },
    });
    expect(swept.ended).toEqual([]);
    expect(await statusOf(party.id)).toBe("live");
  });
});
