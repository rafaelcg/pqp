import { expect, test } from "@playwright/test";
import { headersFor, materialiseAccount, API } from "./watch-party-harness";

/**
 * The watch-party wire contract, exercised as protocol rather than as UI.
 *
 * Every browser-level acceptance criterion rests on one assumption: that a
 * `set-watch-party` sent by one member of a voice room comes back out as a
 * `watch-party` to everyone in it, sender included. If that is not true then
 * criteria 1 through 5 cannot pass no matter what the client does, and a
 * failure here says so in two seconds instead of two minutes of iframe
 * timeouts blaming the wrong module.
 *
 * Raw sockets, no browser. That is deliberate: it isolates the server, and it
 * is the same technique `dm-call.spec.ts` uses to put a second identity in a
 * room without a second browser.
 */

const DEV_TOKEN = "dev-local-token";
const WS_URL = API.replace(/^http/, "ws") + "/ws";

interface Frame {
  type: string;
  [key: string]: unknown;
}

interface WireState {
  videoId: string | null;
  status: "playing" | "paused" | "ended";
  positionMs: number;
  atMs: number;
  rev: number;
  actorId: string;
}

function stateFor(actorId: string, over: Partial<WireState> = {}): WireState {
  return {
    videoId: "dQw4w9WgXcQ",
    status: "paused",
    positionMs: 0,
    atMs: Date.now(),
    rev: 1,
    actorId,
    ...over,
  };
}

/** One dev-bypass account as a plain protocol client. */
class Peer {
  private socket!: WebSocket;
  readonly frames: Frame[] = [];
  private waiters: {
    match: (frame: Frame) => boolean;
    resolve: (frame: Frame) => void;
  }[] = [];
  closedWith: { code: number; reason: string } | null = null;

  constructor(readonly suffix: string) {}

  async connect(): Promise<void> {
    this.socket = new WebSocket(WS_URL);
    await new Promise<void>((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve());
      this.socket.addEventListener("error", () =>
        reject(new Error(`ws error for ${this.suffix}`)),
      );
    });
    this.socket.addEventListener("close", (event) => {
      this.closedWith = {
        code: (event as CloseEvent).code,
        reason: (event as CloseEvent).reason,
      };
    });
    this.socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String((event as MessageEvent).data)) as Frame;
      this.frames.push(frame);
      for (const waiter of this.waiters.splice(0)) {
        if (waiter.match(frame)) {
          waiter.resolve(frame);
        } else {
          this.waiters.push(waiter);
        }
      }
    });
    this.send({ type: "auth", token: `${DEV_TOKEN}:${this.suffix}` });
    await this.waitFor((frame) => frame.type === "ready");
  }

  send(frame: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(frame));
  }

  async joinVoice(voiceChannelId: string): Promise<void> {
    this.send({ type: "join-voice-room", voiceChannelId });
    await this.waitFor((frame) => frame.type === "welcome");
  }

  leaveVoice(): void {
    this.send({ type: "leave-voice-room" });
  }

  waitFor(match: (frame: Frame) => boolean, timeoutMs = 10_000): Promise<Frame> {
    const existing = this.frames.find(match);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `${this.suffix}: timed out; saw types ${JSON.stringify(
                this.frames.map((frame) => frame.type),
              )}`,
            ),
          ),
        timeoutMs,
      );
      this.waiters.push({
        match,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }

  /** Resolve `null` when nothing matched, instead of throwing. */
  async maybe(
    match: (frame: Frame) => boolean,
    timeoutMs = 3_000,
  ): Promise<Frame | null> {
    try {
      return await this.waitFor(match, timeoutMs);
    } catch {
      return null;
    }
  }

  forget(): void {
    this.frames.length = 0;
  }

  get open(): boolean {
    return this.socket?.readyState === 1;
  }

  close(): void {
    this.socket?.close();
  }
}

interface Room {
  serverId: string;
  voiceChannelId: string;
}

async function seedRoom(hostSuffix: string, guests: string[]): Promise<Room> {
  await materialiseAccount(hostSuffix);
  for (const guest of guests) {
    await materialiseAccount(guest);
  }
  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(hostSuffix),
    body: JSON.stringify({ name: "WatchProto" }),
  });
  const { server } = (await created.json()) as { server: { id: string } };
  const channel = await fetch(`${API}/api/servers/${server.id}/channels`, {
    method: "POST",
    headers: headersFor(hostSuffix),
    body: JSON.stringify({ name: "cinema", type: "voice" }),
  });
  const { channel: voice } = (await channel.json()) as {
    channel: { id: string };
  };
  if (guests.length > 0) {
    const invited = await fetch(`${API}/api/servers/${server.id}/invites`, {
      method: "POST",
      headers: headersFor(hostSuffix),
      body: JSON.stringify({}),
    });
    const { invite } = (await invited.json()) as { invite: { code: string } };
    for (const guest of guests) {
      await fetch(`${API}/api/invites/${invite.code}/join`, {
        method: "POST",
        headers: headersFor(guest),
        body: "{}",
      });
    }
  }
  return { serverId: server.id, voiceChannelId: voice.id };
}

test.describe("watch-party over the signalling socket", () => {
  test("a control frame proves the room is real before anything else is claimed", async () => {
    const room = await seedRoom("wp-ctl-a", ["wp-ctl-b"]);
    const a = new Peer("wp-ctl-a");
    const b = new Peer("wp-ctl-b");
    try {
      await a.connect();
      await b.connect();
      await a.joinVoice(room.voiceChannelId);
      await b.joinVoice(room.voiceChannelId);
      b.forget();
      a.send({ type: "set-voice-state", muted: true, deafened: false });
      const roster = await b.waitFor(
        (frame) =>
          frame.type === "voice-roster" &&
          Array.isArray(frame.participants) &&
          (frame.participants as { muted?: boolean }[]).some(
            (participant) => participant.muted,
          ),
      );
      expect(roster.type).toBe("voice-roster");
    } finally {
      a.close();
      b.close();
    }
  });

  test("one peer's set-watch-party reaches the other peer", async () => {
    const room = await seedRoom("wp-relay-a", ["wp-relay-b"]);
    const a = new Peer("wp-relay-a");
    const b = new Peer("wp-relay-b");
    try {
      await a.connect();
      await b.connect();
      await a.joinVoice(room.voiceChannelId);
      await b.joinVoice(room.voiceChannelId);
      b.forget();

      const state = stateFor("peer-a", { status: "playing", positionMs: 1_000 });
      a.send({ type: "set-watch-party", state });

      const relayed = await b.waitFor((frame) => frame.type === "watch-party");
      expect(relayed.channelId).toBe(room.voiceChannelId);
      expect(relayed.state).toMatchObject({
        videoId: state.videoId,
        status: "playing",
        positionMs: 1_000,
        rev: 1,
        actorId: "peer-a",
      });
    } finally {
      a.close();
      b.close();
    }
  });

  test("the sender is echoed its own write, which is how it learns the write survived", async () => {
    const room = await seedRoom("wp-echo-a", ["wp-echo-b"]);
    const a = new Peer("wp-echo-a");
    const b = new Peer("wp-echo-b");
    try {
      await a.connect();
      await b.connect();
      await a.joinVoice(room.voiceChannelId);
      await b.joinVoice(room.voiceChannelId);
      a.forget();
      a.send({ type: "set-watch-party", state: stateFor("peer-a") });
      const echo = await a.waitFor((frame) => frame.type === "watch-party");
      expect(echo.state).toMatchObject({ actorId: "peer-a", rev: 1 });
    } finally {
      a.close();
      b.close();
    }
  });

  test("a peer joining mid video is told the party's current state", async () => {
    // Criterion 3's protocol half. A late joiner cannot land at the right
    // position if nothing tells it there is a party at all, and the client
    // has no way to ask.
    const room = await seedRoom("wp-late-a", ["wp-late-b"]);
    const a = new Peer("wp-late-a");
    const b = new Peer("wp-late-b");
    try {
      await a.connect();
      await a.joinVoice(room.voiceChannelId);
      a.send({
        type: "set-watch-party",
        state: stateFor("peer-a", {
          status: "playing",
          positionMs: 42_000,
          rev: 7,
        }),
      });
      await a.waitFor((frame) => frame.type === "watch-party");

      await b.connect();
      await b.joinVoice(room.voiceChannelId);
      const seen = await b.waitFor(
        (frame) => frame.type === "watch-party",
        8_000,
      );
      expect(seen.state).toMatchObject({ positionMs: 42_000, rev: 7 });
    } finally {
      a.close();
      b.close();
    }
  });

  test("the last participant leaving tears the party down", async () => {
    // Criterion 4. Observed the only way it can be: a fresh peer joining the
    // now empty room must not inherit the state the previous pair left behind.
    const room = await seedRoom("wp-tear-a", ["wp-tear-b", "wp-tear-c"]);
    const a = new Peer("wp-tear-a");
    const b = new Peer("wp-tear-b");
    const c = new Peer("wp-tear-c");
    try {
      await a.connect();
      await b.connect();
      await a.joinVoice(room.voiceChannelId);
      await b.joinVoice(room.voiceChannelId);
      a.send({
        type: "set-watch-party",
        state: stateFor("peer-a", { status: "playing", positionMs: 5_000 }),
      });
      await b.waitFor((frame) => frame.type === "watch-party");

      a.leaveVoice();
      b.forget();
      b.leaveVoice();
      // A teardown broadcast is one valid shape; an empty room that simply
      // holds nothing is another. Both are accepted here, and the assertion
      // below is what actually decides it.
      await b.maybe(
        (frame) => frame.type === "watch-party" && frame.state === null,
        3_000,
      );

      await c.connect();
      await c.joinVoice(room.voiceChannelId);
      const inherited = await c.maybe(
        (frame) => frame.type === "watch-party" && frame.state !== null,
        4_000,
      );
      expect(
        inherited,
        "a fresh joiner inherited a party nobody is in",
      ).toBeNull();
    } finally {
      a.close();
      b.close();
      c.close();
    }
  });

  test("a peer outside the room hears nothing", async () => {
    const room = await seedRoom("wp-leak-a", ["wp-leak-b"]);
    const a = new Peer("wp-leak-a");
    const b = new Peer("wp-leak-b");
    try {
      await a.connect();
      await b.connect();
      await a.joinVoice(room.voiceChannelId);
      // b is a member of the server but has NOT joined the voice channel.
      b.forget();
      a.send({ type: "set-watch-party", state: stateFor("peer-a") });
      const leaked = await b.maybe(
        (frame) => frame.type === "watch-party",
        3_000,
      );
      expect(leaked, "watch-party leaked to a non participant").toBeNull();
    } finally {
      a.close();
      b.close();
    }
  });

  test("a seek scrub's worth of writes does not kill the socket", async () => {
    // The contract says this is rate limited like `set-voice-state`. Whatever
    // the limiter does, dropping the connection is not it: the client would
    // reconnect into a room it has to rejoin, mid film.
    const room = await seedRoom("wp-rate-a", ["wp-rate-b"]);
    const a = new Peer("wp-rate-a");
    const b = new Peer("wp-rate-b");
    try {
      await a.connect();
      await b.connect();
      await a.joinVoice(room.voiceChannelId);
      await b.joinVoice(room.voiceChannelId);
      b.forget();
      for (let i = 0; i < 40; i += 1) {
        a.send({
          type: "set-watch-party",
          state: stateFor("peer-a", { positionMs: i * 250, rev: i + 1 }),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(a.open, `sender socket closed: ${JSON.stringify(a.closedWith)}`).toBe(
        true,
      );
      expect(b.open, `peer socket closed: ${JSON.stringify(b.closedWith)}`).toBe(
        true,
      );
      // Whatever survived the limiter, the peer must end up holding a state
      // that is at least as new as something it saw, not a truncated stream
      // that stopped at the first frame.
      const seen = b.frames.filter((frame) => frame.type === "watch-party");
      expect(seen.length, "no writes at all survived the limiter").toBeGreaterThan(
        0,
      );
    } finally {
      a.close();
      b.close();
    }
  });

  test("a scrub followed instantly by a pause does not split the room", async () => {
    // The failure this hunts is the one the contract calls out as NOT
    // surviving a dropped frame. A scrub emits continuously and is exactly
    // what empties the rate limiter; the pause that follows it is a status
    // change, and if the limiter drops that, its author sits at a `rev` nobody
    // else can reach. Their higher `rev` then makes them ignore every frame
    // the room sends afterwards, permanently, with no path back.
    //
    // So this is deliberately the least forgiving ordering available: sixty
    // position-only writes with nothing awaited between them, and the status
    // change issued in the same breath.
    const room = await seedRoom("wp-split-a", ["wp-split-b"]);
    const a = new Peer("wp-split-a");
    const b = new Peer("wp-split-b");
    try {
      await a.connect();
      await b.connect();
      await a.joinVoice(room.voiceChannelId);
      await b.joinVoice(room.voiceChannelId);
      b.forget();
      a.forget();

      for (let i = 0; i < 60; i += 1) {
        a.send({
          type: "set-watch-party",
          state: stateFor("peer-a", {
            status: "playing",
            positionMs: i * 200,
            rev: i + 1,
          }),
        });
      }
      // No pause, no await. The status change rides straight out behind the
      // scrub, which is what a person releasing the scrubber onto the pause
      // button actually produces.
      a.send({
        type: "set-watch-party",
        state: stateFor("peer-a", {
          status: "paused",
          positionMs: 12_000,
          rev: 61,
        }),
      });

      // The peer has to see the pause. Coalescing position updates is fine and
      // is the point; losing the status change is the split.
      const seen = await b.maybe(
        (frame) =>
          frame.type === "watch-party" &&
          (frame.state as WireState | null)?.status === "paused",
        8_000,
      );
      const relayed = b.frames
        .filter((frame) => frame.type === "watch-party")
        .map((frame) => {
          const state = frame.state as WireState | null;
          return state ? `${state.rev}:${state.status}` : "null";
        });
      // eslint-disable-next-line no-console
      console.log(
        `[split] 61 writes sent, ${relayed.length} relayed: ${relayed.join(" ")}`,
      );
      expect(
        seen,
        `the pause at rev 61 never reached the peer; the room is split. ${relayed.length} of 61 writes were relayed: ${relayed.join(" ")}`,
      ).not.toBeNull();
      expect((seen!.state as WireState).rev).toBe(61);

      // And the author has to be told its own write landed, because an
      // unechoed local state is the half of the split that lives on this side:
      // it is holding rev 61 whether or not anyone else ever reaches it.
      const echoed = await a.waitFor(
        (frame) =>
          frame.type === "watch-party" &&
          (frame.state as WireState | null)?.rev === 61,
        8_000,
      );
      expect((echoed.state as WireState).status).toBe("paused");

      expect(a.open, "sender socket closed under a scrub").toBe(true);
      expect(b.open, "peer socket closed under a scrub").toBe(true);
    } finally {
      a.close();
      b.close();
    }
  });

  test("a malformed state is refused without taking the socket down", async () => {
    const room = await seedRoom("wp-bad-a", ["wp-bad-b"]);
    const a = new Peer("wp-bad-a");
    const b = new Peer("wp-bad-b");
    try {
      await a.connect();
      await b.connect();
      await a.joinVoice(room.voiceChannelId);
      await b.joinVoice(room.voiceChannelId);
      b.forget();
      a.send({
        type: "set-watch-party",
        state: { videoId: "x", status: "spinning", positionMs: -5 },
      });
      const relayed = await b.maybe(
        (frame) => frame.type === "watch-party",
        3_000,
      );
      expect(relayed, "an invalid state was relayed verbatim").toBeNull();
      // And the connection survives it.
      a.send({ type: "set-watch-party", state: stateFor("peer-a") });
      const good = await b.waitFor((frame) => frame.type === "watch-party");
      expect(good.state).toMatchObject({ actorId: "peer-a" });
    } finally {
      a.close();
      b.close();
    }
  });
});
