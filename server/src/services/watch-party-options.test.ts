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
const { sweepWatchPartyHosts } = await import("./watch-parties.js");
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
    voiceEnabled: boolean;
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

  const cohost = (as: User, id: string, userId: string, promote: boolean) =>
    call<{ party: PartyBody | null }>(
      as,
      "POST",
      `/api/watch-parties/${id}/cohosts`,
      { userId, cohost: promote },
    );

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

  /** The channel's own slow mode, which the party borrows and gives back. */
  async function slowModeSeconds(): Promise<number> {
    const result = await getPool().query<{ slowmode_seconds: number | null }>(
      `SELECT slowmode_seconds FROM channels WHERE id = $1`,
      [channelId],
    );
    return result.rows[0]?.slowmode_seconds ?? 0;
  }

  /** Does this person hold a party-issued microphone right now? */
  async function memberSpeakAllowed(userId: string): Promise<boolean> {
    const row = await overwrite("member", userId);
    return row ? has(row.allow, Permission.SPEAK) : false;
  }

  /**
   * Every overwrite on this channel, ordered, as raw strings.
   *
   * The snapshot the leak test compares. Rows rather than a resolved
   * permission, for the reason `overwrite` above already gives: a resolver
   * bug would hide a leftover row behind a role that happens to carry the
   * bit anyway.
   */
  async function allOverwrites(): Promise<
    { target_type: string; target_id: string; allow: string; deny: string }[]
  > {
    const result = await getPool().query<{
      target_type: string;
      target_id: string;
      allow: string;
      deny: string;
    }>(
      `SELECT target_type, target_id, allow, deny FROM channel_overwrites
        WHERE channel_id = $1
        ORDER BY target_type, target_id`,
      [channelId],
    );
    return result.rows;
  }

  /**
   * The server's `permissions_version`, and why this is the stronger half of
   * the leak test.
   *
   * `upsertChannelOverwrite` and `deleteChannelOverwrite` both bump it, on
   * every call, before anything else. So it counts WRITES, not rows: an
   * upsert that happens to write the bits that were already there leaves the
   * table identical and moves this number. "The default path writes no
   * overwrite at all" is a claim about calls, and this is the only thing in
   * reach that can see one.
   */
  async function permissionsVersion(): Promise<number> {
    const result = await getPool().query<{ permissions_version: number }>(
      `SELECT permissions_version FROM servers WHERE id = $1`,
      [serverId],
    );
    return result.rows[0].permissions_version;
  }

  // --------------------------------------------------------------- the cases

  it("gives a party with no options the safe defaults, in full", async () => {
    const party = await draft();

    // The WHOLE object, not the one field a change happened to touch. A
    // default that drifts has no symptom until a room is full: `hosts_only`
    // is what keeps two hundred people from being asked for a microphone,
    // and `raiseHand` is the door that makes closing the floor tolerable.
    expect(party.options).toEqual({
      // NO VOICE. The one that decides whether this party ever writes a
      // permission rule on the channel, and the one whose drift would put
      // five hundred people back in a call they did not ask to be in.
      voiceEnabled: false,
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

  /**
   * THE TEST THAT WOULD HAVE CAUGHT THE ROW SOMEBODY DELETED BY HAND.
   *
   * On 2026-09-09 a production channel was found still carrying an @everyone
   * SPEAK deny from a watch party that had ended through a path which did not
   * clean up. Nothing surfaced it: the party was gone, the channel looked
   * normal, and the only symptom would have arrived the following Saturday as
   * an entire audience that could not talk even with the floor set to open.
   *
   * The fix is not a better cleanup. It is that a party with no voice, which
   * is now the DEFAULT, never writes a permission rule in the first place, so
   * there is nothing left to leak. Both halves are asserted: the table is
   * byte for byte what it was, and `permissions_version` has not moved, which
   * is what catches a write that put back the bits already there.
   */
  it("a party with no voice writes no permission rule at all", async () => {
    // A channel that already carries a rule somebody set on purpose, because
    // "wrote nothing" has to mean "wrote nothing", not "left an empty table".
    await upsertChannelOverwrite(
      channelId,
      serverId,
      "role",
      everyoneId,
      0n,
      Permission.ADD_REACTIONS,
    );
    const before = await allOverwrites();
    const versionBefore = await permissionsVersion();
    expect(before).toHaveLength(1);

    // The default. No options at all, which is what pressing Criar watch
    // party and then Ir ao vivo produces.
    const party = await draft();
    expect(party.options.voiceEnabled).toBe(false);
    expect((await setState(host, party.id, "live")).status).toBe(200);

    expect(
      await allOverwrites(),
      "going live with no voice wrote a permission rule on the channel",
    ).toEqual(before);
    expect(
      await permissionsVersion(),
      "going live with no voice called an overwrite writer",
    ).toBe(versionBefore);

    // A co-host and a stage invitation, the two other paths that write a
    // member grant. Both are gated on the floor actually being closed, so on
    // a voiceless party neither writes.
    expect((await cohost(host, party.id, second.id, true)).status).toBe(200);
    expect(
      (await stage(host, party.id, { action: "invite", userId: member.id }))
        .status,
    ).toBe(200);
    expect(await allOverwrites()).toEqual(before);
    expect(await permissionsVersion()).toBe(versionBefore);

    expect((await setState(host, party.id, "ended")).status).toBe(200);

    // THE ASSERTION THIS FILE EXISTS FOR: exactly the overwrites it started
    // with, and the moderators' own bit untouched.
    expect(
      await allOverwrites(),
      "the party left a permission rule behind on the channel",
    ).toEqual(before);
    expect(await permissionsVersion()).toBe(versionBefore);
    expect(await everyoneSpeakDenied()).toBe(false);
  });


  it("leaves a channel's own SPEAK deny alone, and does not grant the host around it", async () => {
    /**
     * THE CONSEQUENCE OF WRITING NOTHING, PINNED SO IT IS A DECISION.
     *
     * Before this change the default party closed the floor and granted the
     * host back, which had a side effect nobody designed: it routed around
     * ANY pre-existing @everyone SPEAK deny on the channel, deliberate or
     * stale. A voiceless party writes nothing, so it routes around nothing,
     * and on such a channel the host has a seat and no microphone.
     *
     * That is the right trade (a rule that is never written cannot leak) and
     * it is worth an assertion rather than a discovery on a Saturday. The
     * answer to a stale deny is the cleanup query in docs/WATCH_PARTY.md,
     * not a grant on the path that is supposed to write nothing.
     */
    await upsertChannelOverwrite(
      channelId,
      serverId,
      "role",
      everyoneId,
      0n,
      Permission.SPEAK,
    );
    const before = await allOverwrites();
    const versionBefore = await permissionsVersion();

    const party = await draft();
    expect((await setState(host, party.id, "live")).status).toBe(200);

    // No grant for the host, and the deny is exactly as somebody else left
    // it: the party neither honours it nor repairs it, it ignores it.
    expect(await memberSpeakAllowed(host.id)).toBe(false);
    expect(await allOverwrites()).toEqual(before);
    expect(await permissionsVersion()).toBe(versionBefore);

    // And ending does not hand the room a microphone it never had. The
    // channel is left in the state it was found in, which is the promise.
    expect((await setState(host, party.id, "ended")).status).toBe(200);
    expect(await everyoneSpeakDenied()).toBe(true);
    expect(await allOverwrites()).toEqual(before);
  });
  it("a party stored before voiceEnabled existed still closes its floor", async () => {
    /**
     * EXISTING PARTIES MUST NOT BREAK, and this is the one that could.
     *
     * A row written by yesterday's build has no `voiceEnabled` key and was
     * set up when every watch party was a voice room. If the schema's `false`
     * default decided, a party that was live across the deploy would lose its
     * voice and its host would lose the microphone mid-show. The options
     * column is written by hand here because that is exactly the shape the
     * old build stored and no route can produce it any more.
     */
    const party = await draft();
    await getPool().query(
      `UPDATE channel_sessions
          SET options = '{"stageMode":"hosts_only","raiseHand":true,"slowModeSeconds":0,"reactionsEnabled":true}'::jsonb
        WHERE id = $1`,
      [party.id],
    );

    const read = await readChannelParty(host);
    expect(read.body.party?.options.voiceEnabled).toBe(true);

    expect((await setState(host, party.id, "live")).status).toBe(200);
    expect(await everyoneSpeakDenied()).toBe(true);
    expect(await memberSpeakAllowed(host.id)).toBe(true);

    // And it still puts the channel back, so a legacy party is not a leak
    // either: the cleanup path never depended on the new option.
    expect((await setState(host, party.id, "ended")).status).toBe(200);
    expect(await everyoneSpeakDenied()).toBe(false);
    expect(await overwrite("member", host.id)).toBeNull();
  });

  it("lifts everything the moment a host turns voice back off mid-show", async () => {
    // The reconciler runs on every edit, so switching Voz to Desligada is the
    // same code path as switching the floor to `everyone`: whatever the party
    // put down comes back up, for the people already in the room.
    const party = await draft({
      options: { voiceEnabled: true, stageMode: "hosts_only" },
    });
    expect((await setState(host, party.id, "live")).status).toBe(200);
    expect(await everyoneSpeakDenied()).toBe(true);
    expect(await memberSpeakAllowed(host.id)).toBe(true);

    const off = await patchOptions(host, party.id, { voiceEnabled: false });
    expect(off.status).toBe(200);
    expect(off.body.party.options.voiceEnabled).toBe(false);
    // The stage mode is REMEMBERED, not reset: a host who turns voice on
    // again gets back the floor they had chosen.
    expect(off.body.party.options.stageMode).toBe("hosts_only");
    expect(off.body.party.state).toBe("live");

    expect(await everyoneSpeakDenied()).toBe(false);
    expect(await overwrite("member", host.id)).toBeNull();
    expect(await allOverwrites()).toEqual([]);
  });

  it("closes the floor for hosts_only without silencing the host", async () => {
    const party = await draft({ options: { voiceEnabled: true, stageMode: "hosts_only" } });
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
    const party = await draft({ options: { voiceEnabled: true, stageMode: "everyone" } });
    expect(party.options.stageMode).toBe("everyone");

    expect((await setState(host, party.id, "live")).status).toBe(200);

    // A film night among six friends. Nobody is denied anything, and no
    // overwrite row is invented on a channel that had none.
    expect(await everyoneSpeakDenied()).toBe(false);
    expect(await overwrite("role", everyoneId)).toBeNull();
  });

  it("applies a stage mode changed while the party is live, both ways", async () => {
    const party = await draft({ options: { voiceEnabled: true, stageMode: "everyone" } });
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

    const party = await draft({ options: { voiceEnabled: true, stageMode: "hosts_only" } });
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
    // Voice on, so the last assertion below (a manager opening a floor
    // somebody else closed) is about the floor moving rather than about a
    // party that never had one.
    const party = await draft({ options: { voiceEnabled: true } });
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
      options: { voiceEnabled: true, stageMode: "invited", raiseHand: true },
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
        options: { voiceEnabled: true, stageMode: "invited" },
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

  /**
   * THE MICROPHONE THAT CAME WITH THE BADGE, AND ONLY WHILE IT IS ON AIR.
   *
   * A co-host exists so the show does not depend on one person's laptop, and
   * the takeover it makes possible is worthless if the person who takes over
   * cannot speak. `applyGoLiveOptions` grants SPEAK to the host and co-hosts
   * at the moment the party goes live; somebody promoted after that moment was
   * not in that list when it ran, so before this they arrived with Encerrar,
   * Assumir, the options panel, and no voice. There is no type that catches
   * it and no error anybody sees: the button is there and the room is silent.
   */
  it("hands a co-host promoted mid-show the microphone, and takes it back on demotion", async () => {
    const party = await draft({ options: { voiceEnabled: true, stageMode: "hosts_only" } });
    expect((await setState(host, party.id, "live")).status).toBe(200);
    expect(await everyoneSpeakDenied()).toBe(true);
    // The floor is closed and `second` is part of the audience it closed on.
    expect(await memberSpeakAllowed(second.id)).toBe(false);

    const promoted = await cohost(host, party.id, second.id, true);
    expect(promoted.status).toBe(200);
    expect(
      await memberSpeakAllowed(second.id),
      "a co-host promoted mid-show can run the party and cannot say a word in it",
    ).toBe(true);

    const demoted = await cohost(host, party.id, second.id, false);
    expect(demoted.status).toBe(200);
    // The grant was the badge's, so it goes with the badge. A microphone that
    // outlived the role would be a permission nobody remembers issuing.
    expect(await overwrite("member", second.id)).toBeNull();
  });

  /**
   * A DEMOTION MUST NOT SILENCE SOMEBODY THE HOST PUT ON THE STAGE BY HAND.
   *
   * The mirror image of the guard `removeFromWatchPartyStage` already carries.
   * Two independent reasons to hold a microphone, and taking one away must not
   * take the other with it, or a host who demotes a co-host has also, silently,
   * cut off a guest they invited up to talk.
   */
  it("leaves a demoted co-host speaking when they were also invited up", async () => {
    const party = await draft({ options: { voiceEnabled: true, stageMode: "invited" } });
    expect((await setState(host, party.id, "live")).status).toBe(200);

    expect((await cohost(host, party.id, second.id, true)).status).toBe(200);
    expect(
      (await stage(host, party.id, { action: "invite", userId: second.id }))
        .status,
    ).toBe(200);
    expect(await memberSpeakAllowed(second.id)).toBe(true);

    expect((await cohost(host, party.id, second.id, false)).status).toBe(200);
    expect(
      await memberSpeakAllowed(second.id),
      "demoting a co-host also took the microphone off a guest the host had invited up",
    ).toBe(true);
  });

  /**
   * A DRAFT'S CO-HOST GETS NO OVERWRITE, because a draft's options are a plan
   * rather than a rule. Writing SPEAK bits onto a channel over a show nobody
   * has been told about leaves permissions behind for a party that may never
   * happen, and `restoreChannelAfterParty` only runs on an end or a cancel.
   */
  it("writes nothing to the channel for a co-host promoted on a draft", async () => {
    const party = await draft({ options: { voiceEnabled: true, stageMode: "hosts_only" } });
    expect(party.state).toBe("draft");

    expect((await cohost(host, party.id, second.id, true)).status).toBe(200);
    expect(await overwrite("member", second.id)).toBeNull();
    expect(await everyoneSpeakDenied()).toBe(false);

    // And going live afterwards picks them up the ordinary way, through
    // `stageMemberIds`, so nothing is lost by waiting.
    expect((await setState(host, party.id, "live")).status).toBe(200);
    expect(await memberSpeakAllowed(second.id)).toBe(true);
  });

  /**
   * THE END NOBODY PRESSES.
   *
   * A host whose five minutes run out has their party ended by
   * `sweepWatchPartyHosts`, and that loop used to flip the row and stop. Every
   * other end path goes through the state route, which calls
   * `applyWatchPartyOptions`, so the channel keeps the slow mode the party set
   * and keeps @everyone denied SPEAK, for good, over a show that ended because
   * somebody's wifi died. It is exactly the path this whole area is about: the
   * host dropping is the case the grace window exists for.
   */
  it("puts the channel back when the host's grace window ends the party", async () => {
    const party = await draft({
      options: { voiceEnabled: true, stageMode: "hosts_only", slowModeSeconds: 30 },
    });
    expect((await setState(host, party.id, "live")).status).toBe(200);
    expect(await everyoneSpeakDenied()).toBe(true);
    expect(await slowModeSeconds()).toBe(30);

    // The host's last socket closed six minutes ago. Stamped directly rather
    // than through the socket path: this is about what the SWEEP does with a
    // stamp, and `ws/watch-party-events.ts` owns how one gets there.
    await getPool().query(
      `UPDATE channel_sessions SET host_disconnected_at = NOW() - INTERVAL '6 minutes'
        WHERE id = $1`,
      [party.id],
    );

    const { ended } = await sweepWatchPartyHosts();
    expect(ended.map((one) => one.sessionId)).toContain(party.id);
    expect((await readChannelParty(host)).body.party).toBeNull();

    expect(
      await everyoneSpeakDenied(),
      "the sweep left the room's microphones denied after the party it ended",
    ).toBe(false);
    expect(
      await slowModeSeconds(),
      "the sweep left the party's slow mode on the channel for good",
    ).toBe(0);
    expect(await overwrite("member", host.id)).toBeNull();
  });
});
