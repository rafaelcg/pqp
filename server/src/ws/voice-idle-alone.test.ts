import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * THE IDLE HANGUP: ALONE FOR TEN MINUTES, WARNED AT NINE, DISCONNECTED AT TEN.
 *
 * What is pinned here:
 *  - a room with two people never starts the clock;
 *  - the last person left behind is warned once, a minute before the limit,
 *    and released at it through the moderator's disconnect path (so the
 *    frame that reaches them is the `voice-moderation` notice, with
 *    `reason: "idle"` so the client can say it in Portuguese);
 *  - the warning's button (`voice-still-here`) starts the clock over, and
 *    so does any self-initiated frame, such as a mute toggle;
 *  - somebody joining cancels a pending warning silently;
 *  - `VOICE_IDLE_ALONE_MINUTES=0` turns the whole thing off.
 *
 * Registry off, production's single-instance shape. `now` is passed to the
 * sweep rather than faked system-wide, except where the reset path reads
 * the real clock (it uses `Date.now()`), which is what the fake timers are
 * for.
 */

vi.mock("../voice/backends.js", () => ({
  getServerVoiceBackend: () => "mesh",
  isLiveKitConfigured: () => false,
}));

vi.mock("../services/users.js", () => ({
  resolveMemberName: async (
    _serverId: string | null,
    user: { display_name: string },
  ) => user.display_name,
  canAccessChannel: async () => true,
}));

vi.mock("../services/sanctions.js", () => ({
  findTimeoutForChannel: async () => null,
  timeoutMessage: () => "",
}));

vi.mock("../services/dms.js", () => ({
  isDmSendBlocked: async () => false,
}));

/**
 * Per-channel type, "voice" unless a test says otherwise (the watch-party
 * exemption group below). A plain object rather than a fixed return value so
 * one test can make a channel a `watch_party` without touching the others.
 */
const channelTypes = vi.hoisted(() => ({ byId: new Map<string, string>() }));

vi.mock("../services/servers.js", () => ({
  getChannel: async (channelId: string) => ({
    kind: "server",
    type: channelTypes.byId.get(channelId) ?? "voice",
  }),
  getChannelAudience: async () => ({
    serverId: null,
    kind: "server",
    has: () => true,
  }),
}));

/**
 * `getActiveWatchPartyRow` is the idle sweep's cluster-safe signal that a
 * lone seat is presenting to an audience (see `isPresentingLiveWatchParty`
 * in `voice.ts`). Real `channel_sessions` access needs a database this file
 * runs without, so it is mocked here like every other service dependency;
 * the watch-party group below drives it with `watchPartyRow.current`.
 */
const watchPartyRow = vi.hoisted(() => ({
  current: null as { status: string } | null,
  /** Set by the overlap-guard test to hold one read open on purpose. */
  pending: null as Promise<{ status: string } | null> | null,
}));

vi.mock("../services/watch-parties.js", () => ({
  getActiveWatchPartyRow: async () => watchPartyRow.pending ?? watchPartyRow.current,
  loadWatchPartySeat: async () => null,
}));

vi.mock("../voice/admin.js", () => ({
  evictSfuRoom: vi.fn(() => Promise.resolve()),
  evictSfuUser: vi.fn(() => Promise.resolve()),
  evictSfuUsersExcept: vi.fn(() => Promise.resolve()),
  tickSfuResweeps: vi.fn(() => Promise.resolve(0)),
}));

const {
  handleVoiceMessage,
  resetVoicePeers,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
  sweepIdleAloneSeats,
} = await import("./voice.js");
const { setCoalesceImmediate } = await import("./fanout.js");
setCoalesceImmediate(true);
const { deleteAuthenticatedSocket, setAuthenticatedSocket } = await import(
  "./sockets.js"
);

interface Frame {
  type: string;
  [key: string]: unknown;
}

interface Recorder {
  socket: WebSocket;
  frames: Frame[];
}

const open: Recorder[] = [];

function recorder(): Recorder {
  const frames: Frame[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => frames.push(JSON.parse(payload) as Frame),
    on: () => {},
  } as unknown as WebSocket;
  const rec = { socket, frames };
  open.push(rec);
  return rec;
}

function asUser(id: string): DbUser {
  return {
    id,
    display_name: `User ${id.slice(0, 8)}`,
    avatar_url: null,
  } as unknown as DbUser;
}

const MINUTE = 60_000;
const T0 = 1_800_000_000_000;

const previousClerk = process.env.CLERK_SECRET_KEY;
const previousLimit = process.env.VOICE_IDLE_ALONE_MINUTES;

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = "sk_test_voice_idle";
  delete process.env.VOICE_IDLE_ALONE_MINUTES;
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetVoicePeers();
  resetVoiceRateLimits();
  resetVoiceRoomTransports();
});

afterEach(() => {
  process.env.CLERK_SECRET_KEY = previousClerk;
  if (previousLimit === undefined) {
    delete process.env.VOICE_IDLE_ALONE_MINUTES;
  } else {
    process.env.VOICE_IDLE_ALONE_MINUTES = previousLimit;
  }
  for (const rec of open.splice(0)) {
    deleteAuthenticatedSocket(rec.socket);
  }
  resetVoicePeers();
  vi.useRealTimers();
  channelTypes.byId.clear();
  watchPartyRow.current = null;
  watchPartyRow.pending = null;
});

async function join(userId: string, channel: string): Promise<Recorder> {
  const rec = recorder();
  const user = asUser(userId);
  setAuthenticatedSocket(rec.socket, user);
  await handleVoiceMessage(
    { socket: rec.socket, user },
    { type: "join-voice-room", voiceChannelId: channel, resume: true },
  );
  if (!rec.frames.some((f) => f.type === "welcome")) {
    throw new Error(`join refused: ${JSON.stringify(rec.frames)}`);
  }
  return rec;
}

async function leave(rec: Recorder, userId: string) {
  await handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    { type: "leave-voice-room" },
  );
}

function warnings(rec: Recorder): Frame[] {
  return rec.frames.filter((f) => f.type === "voice-idle-warning");
}

function hangups(rec: Recorder): Frame[] {
  return rec.frames.filter(
    (f) => f.type === "voice-moderation" && f.action === "disconnected",
  );
}

describe("idle hangup", () => {
  it("leaves a two-person room alone forever", async () => {
    const channel = randomUUID();
    const a = await join(randomUUID(), channel);
    const b = await join(randomUUID(), channel);
    for (const minutes of [0, 5, 9, 10, 60]) {
      await sweepIdleAloneSeats(T0 + minutes * MINUTE);
    }
    expect(warnings(a)).toHaveLength(0);
    expect(warnings(b)).toHaveLength(0);
    expect(hangups(a)).toHaveLength(0);
    expect(hangups(b)).toHaveLength(0);
  });

  it("warns the last person at nine minutes and hangs up at ten", async () => {
    const channel = randomUUID();
    const alice = randomUUID();
    const a = await join(alice, channel);
    const bobId = randomUUID();
    const b = await join(bobId, channel);
    await leave(b, bobId);

    await sweepIdleAloneSeats(T0); // clock starts
    await sweepIdleAloneSeats(T0 + 8 * MINUTE);
    expect(warnings(a)).toHaveLength(0);

    await sweepIdleAloneSeats(T0 + 9 * MINUTE);
    expect(warnings(a)).toHaveLength(1);
    expect(warnings(a)[0]).toMatchObject({
      voiceChannelId: channel,
      disconnectAt: T0 + 10 * MINUTE,
    });
    // One warning per stretch, however many ticks pass inside the window.
    await sweepIdleAloneSeats(T0 + 9.5 * MINUTE);
    expect(warnings(a)).toHaveLength(1);
    expect(hangups(a)).toHaveLength(0);

    await sweepIdleAloneSeats(T0 + 10 * MINUTE);
    expect(hangups(a)).toHaveLength(1);
    expect(hangups(a)[0]).toMatchObject({
      voiceChannelId: channel,
      reason: "idle",
    });
    expect(typeof hangups(a)[0]!.message).toBe("string");

    // The seat is gone: a further tick has nothing to say.
    await sweepIdleAloneSeats(T0 + 20 * MINUTE);
    expect(hangups(a)).toHaveLength(1);
  });

  it("starts over when the person answers the warning", async () => {
    const channel = randomUUID();
    const alice = randomUUID();
    const a = await join(alice, channel);

    await sweepIdleAloneSeats(T0);
    await sweepIdleAloneSeats(T0 + 9 * MINUTE);
    expect(warnings(a)).toHaveLength(1);

    vi.setSystemTime(T0 + 9.5 * MINUTE);
    await handleVoiceMessage(
      { socket: a.socket, user: asUser(alice) },
      { type: "voice-still-here" },
    );

    await sweepIdleAloneSeats(T0 + 10 * MINUTE);
    await sweepIdleAloneSeats(T0 + 18 * MINUTE);
    expect(hangups(a)).toHaveLength(0);
    expect(warnings(a)).toHaveLength(1);

    // Nine minutes after the answer: warned again; ten: gone.
    await sweepIdleAloneSeats(T0 + 18.5 * MINUTE);
    expect(warnings(a)).toHaveLength(2);
    await sweepIdleAloneSeats(T0 + 19.5 * MINUTE);
    expect(hangups(a)).toHaveLength(1);
  });

  it("counts a mute toggle as being there", async () => {
    const channel = randomUUID();
    const alice = randomUUID();
    const a = await join(alice, channel);

    await sweepIdleAloneSeats(T0);
    vi.setSystemTime(T0 + 8 * MINUTE);
    await handleVoiceMessage(
      { socket: a.socket, user: asUser(alice) },
      { type: "set-voice-state", muted: true, deafened: false },
    );
    await sweepIdleAloneSeats(T0 + 10 * MINUTE);
    expect(warnings(a)).toHaveLength(0);
    expect(hangups(a)).toHaveLength(0);
  });

  it("forgets a pending warning when somebody joins", async () => {
    const channel = randomUUID();
    const alice = randomUUID();
    const a = await join(alice, channel);

    await sweepIdleAloneSeats(T0);
    await sweepIdleAloneSeats(T0 + 9 * MINUTE);
    expect(warnings(a)).toHaveLength(1);

    const bobId = randomUUID();
    const b = await join(bobId, channel);
    await sweepIdleAloneSeats(T0 + 10 * MINUTE);
    await sweepIdleAloneSeats(T0 + 30 * MINUTE);
    expect(hangups(a)).toHaveLength(0);

    // Bob leaves: a fresh ten minutes, not the remainder of the old stretch.
    await leave(b, bobId);
    await sweepIdleAloneSeats(T0 + 31 * MINUTE);
    await sweepIdleAloneSeats(T0 + 39 * MINUTE);
    expect(warnings(a)).toHaveLength(1);
    await sweepIdleAloneSeats(T0 + 40 * MINUTE);
    expect(warnings(a)).toHaveLength(2);
    await sweepIdleAloneSeats(T0 + 41 * MINUTE);
    expect(hangups(a)).toHaveLength(1);
  });

  it("is off at VOICE_IDLE_ALONE_MINUTES=0", async () => {
    process.env.VOICE_IDLE_ALONE_MINUTES = "0";
    const channel = randomUUID();
    const a = await join(randomUUID(), channel);
    await sweepIdleAloneSeats(T0);
    await sweepIdleAloneSeats(T0 + 600 * MINUTE);
    expect(warnings(a)).toHaveLength(0);
    expect(hangups(a)).toHaveLength(0);
  });

  /**
   * Farol's correctness finding on the first review: the sweep only reset
   * `aloneSince` when it directly SAW two occupants, so a visit entirely
   * between two 15s ticks was invisible to it, and the departed visitor's
   * presence never reset the remaining peer's clock — a later tick could
   * count the whole stretch, visit included, as one uninterrupted alone
   * period. Fixed by clearing the mark synchronously on join
   * (`peers.set(peerId, peer)` in the join handler), not only from the
   * sweep. This is the regression test for that fix, not for the general
   * "somebody joining cancels a pending warning" behaviour already covered
   * above (which happens to hide the same bug when a sweep DOES run while
   * both are seated).
   */
  it("a visit that starts and ends between two sweeps still resets the clock", async () => {
    const channel = randomUUID();
    const alice = randomUUID();
    const a = await join(alice, channel);

    await sweepIdleAloneSeats(T0); // alice's clock starts

    // Bob joins and leaves entirely between two sweep ticks: the periodic
    // sweep never once observes two occupants in this room.
    vi.setSystemTime(T0 + 5 * MINUTE);
    const bobId = randomUUID();
    const b = await join(bobId, channel);
    await leave(b, bobId);

    // Alice's ORIGINAL ten-minute mark: without a reset on the visit, this
    // tick disconnects her.
    await sweepIdleAloneSeats(T0 + 10 * MINUTE);
    expect(hangups(a)).toHaveLength(0);
    expect(warnings(a)).toHaveLength(0);

    // A fresh ten minutes, counted from the sweep that found her alone
    // again (which is the one right above, since her mark was cleared).
    await sweepIdleAloneSeats(T0 + 19 * MINUTE);
    expect(warnings(a)).toHaveLength(1);
    await sweepIdleAloneSeats(T0 + 20 * MINUTE);
    expect(hangups(a)).toHaveLength(1);
  });

  /**
   * Defensive: nothing in this codebase writes a `VoicePeer` for a LiveKit
   * composite-egress bot (see `isEgressIdentity` in `voice.ts`), but the
   * sweep must still never be fooled by one if that ever changes — it must
   * not count as company for somebody else, and it must never itself be
   * warned or hung up (a bot has nobody to show a countdown banner to).
   */
  it("never counts an egress identity as company, and never targets one itself", async () => {
    const channel = randomUUID();
    const alice = randomUUID();
    const a = await join(alice, channel);
    const egress = await join("EG_transcode-bot", channel);

    await sweepIdleAloneSeats(T0);
    await sweepIdleAloneSeats(T0 + 9 * MINUTE);
    expect(warnings(a)).toHaveLength(1);
    expect(warnings(egress)).toHaveLength(0);

    await sweepIdleAloneSeats(T0 + 10 * MINUTE);
    expect(hangups(a)).toHaveLength(1);
    expect(warnings(egress)).toHaveLength(0);
    expect(hangups(egress)).toHaveLength(0);
  });

  /**
   * Requirement (d) of the multi-instance rebase: a watch-party presenter
   * alone in the voice room is not "alone" while an audience is watching
   * HLS without a seat (see `docs/WATCH_PARTY.md`, "The stream") —
   * `isPresentingLiveWatchParty` reads `channel_sessions` (mocked here as
   * `getActiveWatchPartyRow`) rather than a per-process egress map, because
   * the host's socket and the instance running the HLS egress are not
   * guaranteed to be the same machine.
   */
  describe("watch-party presenter exemption", () => {
    it("never disconnects the lone presenter of a live watch party", async () => {
      const channel = randomUUID();
      channelTypes.byId.set(channel, "watch_party");
      watchPartyRow.current = { status: "live" };
      const host = randomUUID();
      const a = await join(host, channel);

      await sweepIdleAloneSeats(T0);
      await sweepIdleAloneSeats(T0 + 9 * MINUTE);
      await sweepIdleAloneSeats(T0 + 10 * MINUTE);
      await sweepIdleAloneSeats(T0 + 60 * MINUTE);
      expect(warnings(a)).toHaveLength(0);
      expect(hangups(a)).toHaveLength(0);
    });

    it("still applies the idle hangup once the party is not live", async () => {
      const channel = randomUUID();
      channelTypes.byId.set(channel, "watch_party");
      // Scheduled but not yet on air, or already ended — either way not
      // "live", so an empty seat is exactly as alone as an ordinary room.
      watchPartyRow.current = { status: "ended" };
      const host = randomUUID();
      const a = await join(host, channel);

      await sweepIdleAloneSeats(T0);
      await sweepIdleAloneSeats(T0 + 9 * MINUTE);
      expect(warnings(a)).toHaveLength(1);
      await sweepIdleAloneSeats(T0 + 10 * MINUTE);
      expect(hangups(a)).toHaveLength(1);
    });
  });

  /**
   * Farol's reliability and performance finding: a slow registry (or, here,
   * a slow watch-party read) must not let a second full sweep stack on top
   * of a first one still awaiting Postgres. Proven by holding one read open
   * on purpose and showing a second tick's sweep still settles promptly —
   * if the in-flight guard in `sweepIdleAloneSeats` were missing, this
   * `await` would hang on the same stuck read the first sweep is holding,
   * and the test would time out instead of passing.
   */
  it("never runs a second sweep while one is still in flight", async () => {
    const channel = randomUUID();
    channelTypes.byId.set(channel, "watch_party");
    const host = randomUUID();
    await join(host, channel);

    let release: (() => void) | undefined;
    watchPartyRow.pending = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });

    const first = sweepIdleAloneSeats(T0);
    await sweepIdleAloneSeats(T0 + 1_000); // must not hang behind `first`
    release?.();
    await first;
  });
});

/**
 * Requirement (c) of the multi-instance rebase: a batch `WORKER_MODE=worker`
 * process must never run this sweep — it is a per-socket timer that belongs
 * to the process holding the sockets (`peers` is this module's in-memory
 * map; a worker has none). The sweep is wired with a bare `setInterval` at
 * module scope in `server/src/index.ts`, alongside several other sweeps
 * that have always worked the same way (`rateLimitSweep`,
 * `communityHomeSweep`) — so what actually keeps a worker from running it is
 * not an `if (role !== "worker")` guard inside that file, it is that
 * `fly.worker.toml` runs `node server/dist/worker.js` as the worker's own
 * entry point (see its `worker =` line), a file that never imports
 * `index.js` or `ws/voice.js` at all (only `jobs.ts` and
 * `worker-health.ts` — see the banner comment at the top of
 * `server/src/worker.ts`). `WORKER_MODE=worker node dist/index.js` is a
 * second, secondary way in, for a single-process deployment that has not
 * split the two entry points; index.ts hands that case to `worker.js`
 * in-process once `main()` runs, which is enough to skip `/ws` and the
 * database-backed batch jobs gated by `runsColdJobs`, but does not un-create
 * a `setInterval` a module-level statement already fired before `main` was
 * ever called — that path is not what production deploys (`docs/deploy-fly.md`
 * §7f, `fly.worker.toml`), so it is out of scope for this fix.
 *
 * So the test that actually proves requirement (c), read against how the
 * worker really starts: `worker.ts`'s import list never reaches
 * `ws/voice.js`.
 */
describe("the idle sweep's reach", () => {
  it("worker.ts, the process fly.worker.toml actually runs, never imports the sweep", () => {
    const worker = readFileSync(
      fileURLToPath(new URL("../worker.ts", import.meta.url)),
      "utf8",
    );
    expect(worker).not.toMatch(/from ["']\.\/ws\/voice\.js["']/);
    expect(worker).not.toMatch(/from ["']\.\/index\.js["']/);
  });

  it("fly.worker.toml starts the worker via worker.js, not index.js", () => {
    const flyWorkerToml = readFileSync(
      fileURLToPath(new URL("../../../fly.worker.toml", import.meta.url)),
      "utf8",
    );
    expect(flyWorkerToml).toMatch(/worker\s*=\s*"node server\/dist\/worker\.js"/);
  });
});
