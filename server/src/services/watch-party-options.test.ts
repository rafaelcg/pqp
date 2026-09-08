import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The watch party OPTIONS, driven through the real HTTP router.
 *
 * `watch-parties.test.ts` next door pins ownership: who may start a party,
 * who may end it, who may touch the roster. This suite pins the other half,
 * the one that decides whether the room can talk, because every one of its
 * failure modes is silent:
 *
 *   * A DEFAULT THAT DRIFTS IS A RIOT. `hosts_only` is the default precisely
 *     because a two hundred person room with open microphones is not a watch
 *     party. Nothing about a wrong default is visible until the room is full,
 *     so the whole options object is asserted rather than the one field a
 *     change happened to touch.
 *   * CLOSING THE FLOOR MUST NOT SILENCE THE HOST. Denying SPEAK to @everyone
 *     protects the room and, on its own, takes the microphone off the person
 *     running the show, because a host who is not the server owner has no
 *     short circuit through `computePermissions`. The grant back is the fix
 *     and it has no symptom in any type: the party goes live, the deny lands,
 *     and the host cannot speak.
 *   * A LIVE EDIT HAS TO REACH THE ROOM. The options are editable while the
 *     party runs, so `hosts_only` picked mid-show has to close the floor
 *     without the host restarting anything, and picking `everyone` again has
 *     to open it.
 *   * ENDING PUTS THE ROOM BACK, AND ONLY WHAT THE PARTY TOOK. The channel is
 *     borrowed for the length of a show. An unrelated bit somebody set on
 *     @everyone months ago must survive a film night.
 *
 * Same harness as watch-parties.test.ts: a real node:http server over the
 * real router, a real Postgres, and only the identity layer stubbed.
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
const { assignRole, createRole, upsertChannelOverwrite } = await import(
  "./roles.js"
);
const { getEveryoneRoleId } = await import("./permissions.js");
const { Permission, parsePermissions, WATCH_PARTY_DEFAULT_OPTIONS } =
  await import("@pqp/shared");

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

interface StagePerson {
  userId: string;
  displayName: string;
}

interface PartyBody {
  id: string;
  name: string;
  state: string;
  viewerRole: string;
  hostUserId: string;
  options: {
    stageMode: string;
    raiseHand: boolean;
    slowModeSeconds: number;
    reactionsEnabled: boolean;
  };
  stage: {
    invited: StagePerson[];
    hands: StagePerson[];
    handRaised: boolean;
  };
}

describeDb("watch party options and the stage", () => {
  /** Owns the server. Never the host: an owner short-circuits to ALL. */
  let owner: User;
  /**
   * The host in every case below, and deliberately NOT the owner. The bug
   * this file exists for (closing the floor silencing the host) is invisible
   * when the host is the owner, because `computePermissions` hands an owner
   * every bit before any overwrite is consulted.
   */
  let host: User;
  /** Promoted to co-host where a case needs one. */
  let second: User;
  /** Holds MANAGE_CHANNELS through a role. Never the host. */
  let manager: User;
  /** Holds nothing beyond the @everyone default. The audience. */
  let member: User;

  let serverId: string;
  let channelId: string;
  let everyoneId: string;

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
    manager = await makeUser("manager");
    member = await makeUser("member");

    const created = await createChatServer("Cinemoon", owner.id);
    serverId = created.server.id;
    const channel = await createChannel(serverId, "sessao-da-tarde", "watch_party");
    channelId = channel.id;

    for (const user of [host, second, manager, member]) {
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
    const managerRole = await createRole(serverId, {
      name: "GerenteDeCanais",
      permissions: Permission.MANAGE_CHANNELS,
    });
    await assignRole(serverId, manager.id, managerRole.id);

    const resolved = await getEveryoneRoleId(serverId);
    expect(resolved).not.toBeNull();
    everyoneId = resolved!;
  });

  // ------------------------------------------------------------- the helpers

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

  /** A draft owned by `host`, which is where every case starts. */
  async function draft(body: Record<string, unknown> = {}) {
    const created = await create(host, body);
    expect(created.status).toBe(200);
    return created.body.party;
  }

  const setState = (as: User, id: string, state: string) =>
    call<{ party: PartyBody }>(as, "POST", `/api/watch-parties/${id}/state`, {
      state,
    });

  const patchOptions = (as: User, id: string, options: Record<string, unknown>) =>
    call<{ party: PartyBody }>(as, "PATCH", `/api/watch-parties/${id}`, {
      options,
    });

  const stage = (as: User, id: string, body: Record<string, unknown>) =>
    call<{ party: PartyBody }>(as, "POST", `/api/watch-parties/${id}/stage`, body);

  const readChannelParty = (as: User, channel = channelId) =>
    call<{ party: PartyBody | null }>(
      as,
      "GET",
      `/api/channels/${channel}/watch-party`,
    );

  /**
   * One overwrite row, straight off the table, with the bit strings parsed.
   * Reading the channel rather than a resolved permission is the point: this
   * suite is about what the party WROTE, and a resolver bug would hide a
   * missing row behind a role that happened to carry the bit anyway.
   */
  async function overwrite(
    targetType: "role" | "member",
    targetId: string,
    channel = channelId,
  ): Promise<{ allow: bigint; deny: bigint } | null> {
    const result = await getPool().query<{ allow: string; deny: string }>(
      `SELECT allow, deny FROM channel_overwrites
        WHERE channel_id = $1 AND target_type = $2 AND target_id = $3`,
      [channel, targetType, targetId],
    );
    const row = result.rows[0];
    return row
      ? { allow: parsePermissions(row.allow), deny: parsePermissions(row.deny) }
      : null;
  }

  const has = (bits: bigint, bit: bigint) => (bits & bit) === bit;

  /** Is the floor closed to the room right now? */
  async function everyoneSpeakDenied(): Promise<boolean> {
    const row = await overwrite("role", everyoneId);
    return row ? has(row.deny, Permission.SPEAK) : false;
  }

  /** Does this person hold a party-issued microphone right now? */
  async function memberSpeakAllowed(userId: string): Promise<boolean> {
    const row = await overwrite("member", userId);
    return row ? has(row.allow, Permission.SPEAK) : false;
  }

  // --------------------------------------------------------------- the cases

  it("gives a party with no options the safe defaults, in full", async () => {
    const party = await draft();

    // The WHOLE object, not the one field a change happened to touch. A
    // default that drifts has no symptom until a room is full: `hosts_only`
    // is what keeps two hundred people from being asked for a microphone,
    // and `raiseHand` is the door that makes closing the floor tolerable.
    expect(party.options).toEqual({
      stageMode: "hosts_only",
      raiseHand: true,
      slowModeSeconds: 0,
      reactionsEnabled: true,
    });
    // And the same object the shared module hands the client, so the panel
    // and the row cannot disagree about what "untouched" means.
    expect(party.options).toEqual(WATCH_PARTY_DEFAULT_OPTIONS);
  });

  it("refuses options the client made up", async () => {
    // `open` was a real stage mode once. A client that never reloaded, or an
    // old mobile build, will still send it, and the failure has to be loud:
    // `watchPartyOptionsSchema` is not a suggestion, it is the list.
    //
    // 400, because `createWatchPartySchema.parse` throws a ZodError before
    // the route body runs and `handleApi`'s generic handler answers 400
    // "Invalid request" for any ZodError.
    const madeUp = await create(host, { options: { stageMode: "open" } });
    expect(madeUp.status).toBe(400);

    // Six hours is the ceiling. A slow mode of 99999 seconds would outlive
    // the party, the channel and the person who typed it.
    const absurd = await create(host, { options: { slowModeSeconds: 99999 } });
    expect(absurd.status).toBe(400);

    // Neither of them left a row behind to block the next attempt: the
    // channel's one active party slot is still free.
    const good = await create(host);
    expect(good.status).toBe(200);
  });

  it("closes the floor for hosts_only without silencing the host", async () => {
    const party = await draft({ options: { stageMode: "hosts_only" } });
    // Nothing is applied until Ir ao vivo. A draft's options are a plan.
    expect(await everyoneSpeakDenied()).toBe(false);
    expect(await memberSpeakAllowed(host.id)).toBe(false);

    expect((await setState(host, party.id, "live")).status).toBe(200);

    // Half one: the room is a stage now.
    expect(await everyoneSpeakDenied()).toBe(true);

    /**
     * HALF TWO, AND IT IS THE HALF THAT BITES.
     *
     * `host` holds START_WATCH_PARTY through a role and nothing else. They
     * are not the owner, so `computePermissions` does not short-circuit them
     * to ALL, and the @everyone deny above applies to them exactly as it
     * applies to the audience. Without the member grant, the act of
     * protecting the room takes the microphone off the person running the
     * show: the party goes live, looks perfect, and the host is muted.
     */
    expect(await memberSpeakAllowed(host.id)).toBe(true);
  });

  it("leaves the floor open for everyone", async () => {
    const party = await draft({ options: { stageMode: "everyone" } });
    expect(party.options.stageMode).toBe("everyone");

    expect((await setState(host, party.id, "live")).status).toBe(200);

    // A film night among six friends. Nobody is denied anything, and no
    // overwrite row is invented on a channel that had none.
    expect(await everyoneSpeakDenied()).toBe(false);
    expect(await overwrite("role", everyoneId)).toBeNull();
  });

  it("applies a stage mode changed while the party is live, both ways", async () => {
    const party = await draft({ options: { stageMode: "everyone" } });
    expect((await setState(host, party.id, "live")).status).toBe(200);
    expect(await everyoneSpeakDenied()).toBe(false);

    // The room got loud. The host closes the floor mid-show, and it has to
    // take effect for the people already sitting in it.
    const closed = await patchOptions(host, party.id, { stageMode: "hosts_only" });
    expect(closed.status).toBe(200);
    expect(closed.body.party.options.stageMode).toBe("hosts_only");
    expect(closed.body.party.state).toBe("live");
    expect(await everyoneSpeakDenied()).toBe(true);
    // The same trap as the go-live path, reached by a different route.
    expect(await memberSpeakAllowed(host.id)).toBe(true);

    // And back. Opening the floor again lifts what the party put down.
    const reopened = await patchOptions(host, party.id, { stageMode: "everyone" });
    expect(reopened.status).toBe(200);
    expect(await everyoneSpeakDenied()).toBe(false);

    // The party never stopped. A host who has to end and restart a live
    // show to change one setting will simply not change it.
    expect(reopened.body.party.state).toBe("live");
    expect((await readChannelParty(member)).body.party?.state).toBe("live");
  });

  it("puts the channel back when the party ends, and only what it took", async () => {
    // Something the moderators set months ago, for their own reasons, on the
    // same overwrite row the party is about to write to.
    await upsertChannelOverwrite(
      channelId,
      serverId,
      "role",
      everyoneId,
      0n,
      Permission.ADD_REACTIONS,
    );

    const party = await draft({ options: { stageMode: "hosts_only" } });
    expect((await setState(host, party.id, "live")).status).toBe(200);

    const during = await overwrite("role", everyoneId);
    expect(during).not.toBeNull();
    // One row, carrying both reasons: the party's SPEAK deny went on top of
    // the moderators' bit rather than replacing the row.
    expect(during!.deny).toBe(Permission.SPEAK | Permission.ADD_REACTIONS);
    expect(await memberSpeakAllowed(host.id)).toBe(true);

    expect((await setState(host, party.id, "ended")).status).toBe(200);

    const after = await overwrite("role", everyoneId);
    // The row itself survives. Deleting the whole overwrite would be the
    // tidiest possible way to lose somebody else's setting.
    expect(
      after,
      "the @everyone overwrite was deleted, taking the moderators' own deny with it",
    ).not.toBeNull();
    // The party's own bit is gone.
    expect(has(after!.deny, Permission.SPEAK)).toBe(false);
    /**
     * AND THE ONE THAT WAS NOT THE PARTY'S IS STILL THERE.
     *
     * The channel is borrowed for the length of a show, not redecorated. A
     * restore that wrote a clean row would quietly hand the reactions back
     * to a room the moderators had deliberately closed, and nobody would
     * connect that to a film night three weeks earlier.
     */
    expect(after!.deny).toBe(Permission.ADD_REACTIONS);

    // The host's microphone was for the length of one show. The whole
    // overwrite goes, rather than an empty row left behind to make the
    // channel settings claim this member has overwrites for ever after.
    expect(await overwrite("member", host.id)).toBeNull();
  });

  it("lets the people running the party change the options and refuses the audience", async () => {
    const party = await draft();
    // Live, so a refusal below is about the role table and not about a draft
    // being invisible: a member who cannot see a draft is told 404, and a
    // 404 would prove nothing about who may edit.
    expect((await setState(host, party.id, "live")).status).toBe(200);

    // 403, not 404. The party is live, so the member can see it; what they
    // may not do is change how it runs.
    const byMember = await patchOptions(member, party.id, {
      stageMode: "everyone",
    });
    expect(byMember.status).toBe(403);
    expect((await readChannelParty(host)).body.party?.options.stageMode).toBe(
      "hosts_only",
    );

    // A co-host runs the party, which is the entire reason a co-host exists.
    expect(
      (
        await call(host, "POST", `/api/watch-parties/${party.id}/cohosts`, {
          userId: second.id,
          cohost: true,
        })
      ).status,
    ).toBe(200);
    const byCohost = await patchOptions(second, party.id, { slowModeSeconds: 10 });
    expect(byCohost.status).toBe(200);
    expect(byCohost.body.party.options.slowModeSeconds).toBe(10);

    // MANAGE_CHANNELS may edit a live party, because that is moderation: the
    // stage mode is exactly the lever somebody needs when a room goes wrong.
    const byManager = await patchOptions(manager, party.id, {
      stageMode: "everyone",
    });
    expect(byManager.status).toBe(200);
    expect(byManager.body.party.options.stageMode).toBe("everyone");
    expect(await everyoneSpeakDenied()).toBe(false);
  });

  it("runs the invited stage: a hand, an invitation, and a hand nobody else sees", async () => {
    const party = await draft({
      options: { stageMode: "invited", raiseHand: true },
    });
    expect((await setState(host, party.id, "live")).status).toBe(200);
    expect(await everyoneSpeakDenied()).toBe(true);

    // A hand is a request, not a permission: it needs nothing but the
    // ability to see the party.
    const raised = await stage(member, party.id, { action: "raise" });
    expect(raised.status).toBe(200);
    // Everyone is told about their OWN hand, or the button cannot show its
    // state and people press it twice.
    expect(raised.body.party.stage.handRaised).toBe(true);
    // But not about anyone else's, including their own place in a queue.
    expect(raised.body.party.stage.hands).toEqual([]);

    // The host sees the queue, because the host is the one who works it.
    const asHost = await readChannelParty(host);
    expect(asHost.body.party?.stage.hands.map((h) => h.userId)).toEqual([
      member.id,
    ]);

    /**
     * AND A SECOND VIEWER SEES NOTHING.
     *
     * A queue an audience can read is a queue where being passed over
     * happens in public. `second` is a plain viewer here (never promoted in
     * this case) and gets an empty list plus a false flag for a hand that is
     * genuinely up two rows away.
     */
    const asOtherViewer = await readChannelParty(second);
    expect(asOtherViewer.body.party?.stage.hands).toEqual([]);
    expect(asOtherViewer.body.party?.stage.handRaised).toBe(false);

    // Nobody hands out microphones except the people running the party.
    const byMember = await stage(member, party.id, {
      action: "invite",
      userId: second.id,
    });
    expect(byMember.status).toBe(403);
    expect(await memberSpeakAllowed(second.id)).toBe(false);

    // The host puts them up. One microphone, granted per member, on top of a
    // floor that stays closed to everybody else.
    const invited = await stage(host, party.id, {
      action: "invite",
      userId: member.id,
    });
    expect(invited.status).toBe(200);
    expect(await memberSpeakAllowed(member.id)).toBe(true);
    expect(await everyoneSpeakDenied()).toBe(true);
    // Being up is public: the room deserves to know why a stranger is
    // talking. The hand comes down with the invitation, so the queue does
    // not keep asking for someone who is already speaking.
    expect(invited.body.party.stage.invited.map((p) => p.userId)).toEqual([
      member.id,
    ]);
    expect(invited.body.party.stage.hands).toEqual([]);

    // And down again.
    const removed = await stage(host, party.id, {
      action: "remove",
      userId: member.id,
    });
    expect(removed.status).toBe(200);
    expect(removed.body.party.stage.invited).toEqual([]);
    expect(await memberSpeakAllowed(member.id)).toBe(false);
    // The host keeps theirs: they are on the stage by role, not by an
    // invitation anybody could take back.
    expect(await memberSpeakAllowed(host.id)).toBe(true);
  });

  it("refuses a hand on a party that is not on air", async () => {
    // A second channel, because one active party per channel and the live
    // one above is not what this asks about.
    const other = await createChannel(serverId, "sessao-da-noite", "watch_party");
    const created = await create(
      host,
      {
        startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        options: { stageMode: "invited" },
      },
      other.id,
    );
    expect(created.status).toBe(200);
    expect(created.body.party.state).toBe("scheduled");

    // The member can see it (it is announced), which is why this is a 409
    // about the state and not a 404 about visibility. A hand raised at a
    // party that has not started is a queue position in a room with nobody
    // in it, and it would still be up an hour later when the show begins.
    const early = await stage(member, created.body.party.id, { action: "raise" });
    expect(early.status).toBe(409);

    const asHost = await readChannelParty(host, other.id);
    expect(asHost.body.party?.stage.hands).toEqual([]);
  });
});
