import { expect, type Browser, type Page } from "@playwright/test";

/**
 * Two real browser contexts, both signed in as different accounts, both sitting
 * in the same server voice channel. That is the fundamental shape of every
 * watch-party acceptance test, so it lives here once rather than in five specs.
 *
 * Built from the same parts `screen-reshare.spec.ts` uses: dev-bypass accounts
 * selected per context by the `pqp:dev-user-suffix` localStorage hook in
 * `client/src/lib/dev-auth.ts`, a server seeded over the API rather than driven
 * through the create-server form, and an invite redeemed for the guest.
 *
 * WHAT THIS FILE ADDS BEYOND THAT PATTERN, and why.
 *
 * A watch party is a state machine driven over the WebSocket and rendered by a
 * third party's iframe. Neither end of that is observable through the DOM with
 * any honesty: the iframe is cross origin, so its playback state cannot be read
 * from the page, and the DOM only ever shows what the client *believes*. So the
 * two recorders below tap the seams instead.
 *
 * `installFrameRecorder` wraps `WebSocket` before the app boots and keeps every
 * watch-party frame in both directions with a monotonic timestamp. That is the
 * only instrument that can answer the questions that actually matter here:
 * whether applying a remote update rebroadcasts it (oscillation), how long a
 * peer takes to converge, and whether two simultaneous writers settle on the
 * same `rev`/`actorId` pair rather than merely stopping.
 *
 * `installPlayerRecorder` wraps `YT.Player.prototype` once the IFrame API has
 * defined it, and records every `seekTo`, `setPlaybackRate`, `playVideo` and
 * `pauseVideo` the client asks for. The drift ladder is a claim about which of
 * those a given error produces, and this is the only way to check that claim
 * without taking the implementation's word for it.
 */

export const API = process.env.E2E_API_URL ?? "http://localhost:3101";
export const DEV_TOKEN = "dev-local-token";

export function headersFor(suffix: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

export interface DevAccount {
  id: string;
  displayName: string;
}

/** Age gate plus onboarding for one dev-bypass account, so the app is reachable. */
export async function materialiseAccount(suffix: string): Promise<DevAccount> {
  const headers = headersFor(suffix);
  const me = await fetch(`${API}/api/me`, { headers });
  const body = (await me.json()) as {
    id: string;
    displayName: string;
    ageGate?: string;
  };
  if (body.ageGate && body.ageGate !== "passed") {
    await fetch(`${API}/api/me/age-check`, {
      method: "POST",
      headers,
      body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
    });
  }
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      onboardedAt: new Date().toISOString(),
      firstRunDismissedAt: new Date().toISOString(),
    }),
  });
  return { id: body.id, displayName: body.displayName };
}

export interface VoiceRoom {
  serverId: string;
  voiceChannelId: string;
  suffixes: string[];
  names: string[];
}

/**
 * One server, one voice channel, and every named account a member of it.
 *
 * Takes a list rather than a pair because criterion 3 (a peer joining mid
 * video) and criterion 4 (the last person leaving) both want a third party in
 * the room, and a two-argument helper would have to be rewritten to get one.
 */
export async function seedVoiceRoom(
  suffixes: string[],
  name = "Watch",
): Promise<VoiceRoom> {
  const [hostSuffix, ...guestSuffixes] = suffixes;
  if (!hostSuffix) {
    throw new Error("seedVoiceRoom needs at least one account");
  }
  const accounts: DevAccount[] = [];
  for (const suffix of suffixes) {
    accounts.push(await materialiseAccount(suffix));
  }

  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(hostSuffix),
    body: JSON.stringify({ name }),
  });
  if (!created.ok) {
    throw new Error(`could not seed a server: ${created.status}`);
  }
  const { server } = (await created.json()) as { server: { id: string } };

  const channel = await fetch(`${API}/api/servers/${server.id}/channels`, {
    method: "POST",
    headers: headersFor(hostSuffix),
    body: JSON.stringify({ name: "cinema", type: "voice" }),
  });
  if (!channel.ok) {
    throw new Error(`could not seed a voice channel: ${channel.status}`);
  }
  const { channel: voice } = (await channel.json()) as {
    channel: { id: string };
  };

  if (guestSuffixes.length > 0) {
    const invited = await fetch(`${API}/api/servers/${server.id}/invites`, {
      method: "POST",
      headers: headersFor(hostSuffix),
      body: JSON.stringify({}),
    });
    const { invite } = (await invited.json()) as { invite: { code: string } };
    for (const suffix of guestSuffixes) {
      await fetch(`${API}/api/invites/${invite.code}/join`, {
        method: "POST",
        headers: headersFor(suffix),
        body: "{}",
      });
    }
  }

  return {
    serverId: server.id,
    voiceChannelId: voice.id,
    suffixes,
    names: accounts.map((account) => account.displayName),
  };
}

// ------------------------------------------------------------- WS recorder

export interface RecordedFrame {
  /** "out" is what this page sent, "in" is what the server delivered to it. */
  direction: "in" | "out";
  /** `performance.now()` at the moment the frame crossed the wrapper. */
  at: number;
  type: string;
  /** Present on server frames only; `set-watch-party` does not carry it. */
  channelId?: string;
  state: {
    videoId: string | null;
    status: string;
    positionMs: number;
    atMs: number;
    rev: number;
    actorId: string;
  } | null;
}

/**
 * Record every watch-party frame this page sends or receives.
 *
 * Must run before the app script, hence `addInitScript`: the client opens its
 * socket during boot and there is no later moment at which the constructor can
 * still be replaced.
 *
 * Only watch-party frames are kept. The socket also carries rosters, presence
 * and ICE, and a recorder that kept all of it would turn a ten second
 * oscillation window into tens of thousands of entries for no gain.
 */
export async function installFrameRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface Recorded {
      direction: "in" | "out";
      at: number;
      type: string;
      channelId?: string;
      state: unknown;
    }
    const log: Recorded[] = [];
    (window as unknown as { __wpFrames: Recorded[] }).__wpFrames = log;

    const keep = (direction: "in" | "out", raw: unknown) => {
      if (typeof raw !== "string") {
        return;
      }
      // Cheap reject before parsing. Almost every frame on this socket is
      // something else, and JSON.parse on all of them during a ten second
      // window is measurable.
      if (!raw.includes("watch-party")) {
        return;
      }
      try {
        const frame = JSON.parse(raw) as {
          type?: string;
          state?: unknown;
          channelId?: string;
        };
        if (frame.type !== "watch-party" && frame.type !== "set-watch-party") {
          return;
        }
        log.push({
          direction,
          at: performance.now(),
          type: frame.type,
          channelId: frame.channelId,
          state: frame.state ?? null,
        });
      } catch {
        // Not our frame.
      }
    };

    const sockets: WebSocket[] = [];
    (window as unknown as { __wpSockets: WebSocket[] }).__wpSockets = sockets;

    const Native = window.WebSocket;
    class Recording extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
        this.addEventListener("message", (event) => {
          keep("in", (event as MessageEvent).data);
        });
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        keep("out", data);
        super.send(data);
      }
    }
    window.WebSocket = Recording as unknown as typeof WebSocket;
  });
}

/**
 * Deliver a frame to the page as if the server had sent it.
 *
 * A synthetic peer, in other words, with the timing under the test's control
 * rather than the network's. Two things make this worth having even once the
 * server relays for real.
 *
 * The first is that it answers the oscillation question *deterministically*.
 * Oscillation is "applying a remote update rebroadcast it", and the honest way
 * to ask that is to hand the client exactly one remote update and then watch
 * its outbound side. Two real browsers can only ask it by hoping the timing
 * lines up.
 *
 * The second is simultaneity. "Both peers pause at the same instant" is not
 * reproducible by clicking two buttons; it is reproducible by injecting a
 * conflicting write into the same task in which the local one was made.
 *
 * The frame goes in below the app's own socket, so the app's handler sees it
 * through the ordinary `message` path and nothing about the client is stubbed.
 */
export async function injectInbound(
  page: Page,
  frame: Record<string, unknown>,
): Promise<void> {
  const delivered = await page.evaluate((payload) => {
    const sockets =
      (window as unknown as { __wpSockets?: WebSocket[] }).__wpSockets ?? [];
    const live = sockets.filter((socket) => socket.readyState === 1);
    if (live.length === 0) {
      return 0;
    }
    for (const socket of live) {
      socket.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(payload) }),
      );
    }
    return live.length;
  }, frame);
  if (delivered === 0) {
    throw new Error("no open socket on the page to inject into");
  }
}

export function recordedFrames(page: Page): Promise<RecordedFrame[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __wpFrames?: RecordedFrame[] }).__wpFrames ?? [],
  ) as Promise<RecordedFrame[]>;
}

export async function clearFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log = (window as unknown as { __wpFrames?: unknown[] }).__wpFrames;
    if (log) {
      log.length = 0;
    }
  });
}

/**
 * Wait until this page has sent nothing for `quietMs`, then report what it sent.
 *
 * This is the oscillation instrument. A correct client answers a local action
 * with a bounded number of `set-watch-party` frames and then goes quiet; a
 * client that rebroadcasts what it applies never does, so this either returns
 * a short list or fails on `budgetMs` with a long one, and both outcomes are
 * the answer.
 */
export async function settleOutbound(
  page: Page,
  quietMs = 2_500,
  budgetMs = 20_000,
): Promise<RecordedFrame[]> {
  const deadline = Date.now() + budgetMs;
  let lastCount = -1;
  let quietSince = Date.now();
  for (;;) {
    const frames = await recordedFrames(page);
    const outbound = frames.filter((frame) => frame.direction === "out");
    if (outbound.length !== lastCount) {
      lastCount = outbound.length;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) {
      return outbound;
    }
    if (Date.now() > deadline) {
      return outbound;
    }
    await page.waitForTimeout(200);
  }
}

// --------------------------------------------------------- player recorder

export interface PlayerCall {
  at: number;
  method: string;
  args: unknown[];
}

/**
 * Record what the client asks the YouTube player to do.
 *
 * The iframe is cross origin, so its real playback state is unreadable from
 * the page and the only honest observation point is the call the client makes
 * into `YT.Player`. The API defines those methods on the prototype after its
 * script loads, which is well after `addInitScript` runs, so this polls for the
 * prototype rather than assuming it is there.
 *
 * `getCurrentTime` and friends are deliberately left alone: wrapping a getter
 * that the drift loop calls several times a second would bury the four calls
 * that matter.
 */
export async function installPlayerRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface Call {
      at: number;
      method: string;
      args: unknown[];
    }
    const calls: Call[] = [];
    (window as unknown as { __wpPlayerCalls: Call[] }).__wpPlayerCalls = calls;
    // Every player instance the client drives, captured off `this` rather than
    // by wrapping the constructor. Wrapping the constructor would race the
    // app's own capture of `YT.Player`; catching `this` on the first call it
    // makes cannot, because by then the instance exists.
    const players: unknown[] = [];
    (window as unknown as { __wpPlayers: unknown[] }).__wpPlayers = players;

    const WATCHED = [
      "seekTo",
      "setPlaybackRate",
      "playVideo",
      "pauseVideo",
      "loadVideoById",
      "cueVideoById",
      "stopVideo",
    ];

    let patched = false;
    const patch = () => {
      if (patched) {
        return true;
      }
      const yt = (window as unknown as { YT?: { Player?: { prototype?: Record<string, unknown> } } }).YT;
      const proto = yt?.Player?.prototype;
      if (!proto) {
        return false;
      }
      for (const name of WATCHED) {
        const original = proto[name];
        if (typeof original !== "function") {
          continue;
        }
        const fn = original as (...args: unknown[]) => unknown;
        proto[name] = function (this: unknown, ...args: unknown[]) {
          calls.push({ at: performance.now(), method: name, args });
          if (!players.includes(this)) {
            players.push(this);
          }
          return fn.apply(this, args);
        };
      }
      patched = true;
      return true;
    };

    if (!patch()) {
      const timer = setInterval(() => {
        if (patch()) {
          clearInterval(timer);
        }
      }, 50);
      // Give up quietly rather than spinning forever in a test that never
      // opens a player at all.
      setTimeout(() => clearInterval(timer), 60_000);
    }
  });
}

export function playerCalls(page: Page): Promise<PlayerCall[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __wpPlayerCalls?: PlayerCall[] })
        .__wpPlayerCalls ?? [],
  ) as Promise<PlayerCall[]>;
}

export interface PlayerReading {
  /** Seconds, as YouTube reports them, or null when no player was captured. */
  currentTime: number | null;
  /** -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued. */
  playerState: number | null;
  playbackRate: number | null;
  muted: boolean | null;
  videoId: string | null;
}

/**
 * Ask the real player what it is doing.
 *
 * The iframe is cross origin so nothing can be read out of its document, but
 * the IFrame API keeps a cached copy of playback state on the parent side and
 * these getters answer from it. That makes them the only way to check the
 * claim that matters for autoplay: whether this participant is actually
 * producing sound, as opposed to whether the client believes it should be.
 */
export async function readPlayer(page: Page): Promise<PlayerReading> {
  return page.evaluate(() => {
    const players =
      (window as unknown as { __wpPlayers?: unknown[] }).__wpPlayers ?? [];
    const player = players[players.length - 1] as
      | {
          getCurrentTime?: () => number;
          getPlayerState?: () => number;
          getPlaybackRate?: () => number;
          isMuted?: () => boolean;
          getVideoData?: () => { video_id?: string };
        }
      | undefined;
    if (!player) {
      return {
        currentTime: null,
        playerState: null,
        playbackRate: null,
        muted: null,
        videoId: null,
      };
    }
    const safely = <T>(read: () => T): T | null => {
      try {
        return read();
      } catch {
        return null;
      }
    };
    return {
      currentTime: safely(() => player.getCurrentTime?.() ?? null),
      playerState: safely(() => player.getPlayerState?.() ?? null),
      playbackRate: safely(() => player.getPlaybackRate?.() ?? null),
      muted: safely(() => player.isMuted?.() ?? null),
      videoId: safely(() => player.getVideoData?.().video_id ?? null),
    };
  });
}

export async function clearPlayerCalls(page: Page): Promise<void> {
  await page.evaluate(() => {
    const calls = (window as unknown as { __wpPlayerCalls?: unknown[] })
      .__wpPlayerCalls;
    if (calls) {
      calls.length = 0;
    }
  });
}

// ------------------------------------------------------------------- boot

export interface BootOptions {
  /** Forward the page console into the run. Media and iframe failures are silent otherwise. */
  debug?: boolean;
}

export async function bootAs(
  page: Page,
  path: string,
  suffix: string,
  options: BootOptions = {},
): Promise<void> {
  if (options.debug || process.env.WATCH_PARTY_DEBUG) {
    page.on("console", (message) => {
      // eslint-disable-next-line no-console
      console.log(`[${suffix}:${message.type()}]`, message.text());
    });
    page.on("pageerror", (error) => {
      // eslint-disable-next-line no-console
      console.log(`[${suffix}:pageerror]`, error.message);
    });
  }
  await installFrameRecorder(page);
  await installPlayerRecorder(page);
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(`${path}?lang=en`);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({
    timeout: 20_000,
  });
}

export interface Client {
  page: Page;
  close: () => Promise<void>;
}

/**
 * An extra browser context, signed in as `suffix`.
 *
 * Its own context rather than its own page, because two pages in one context
 * share localStorage and would therefore share the dev-user suffix, which is
 * exactly the thing that has to differ.
 */
export async function extraClient(
  browser: Browser,
  path: string,
  suffix: string,
  options: BootOptions = {},
): Promise<Client> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
  });
  await context.grantPermissions(["microphone"]);
  const page = await context.newPage();
  await bootAs(page, path, suffix, options);
  return { page, close: () => context.close() };
}

export async function joinVoice(page: Page): Promise<void> {
  await page.getByRole("button", { name: /cinema/ }).first().click();
  await page.getByRole("button", { name: "Join Voice" }).click();
  // The "Live" badge is what the older specs wait for, but it is transient:
  // it can be gone again by the time a second client has finished joining, so
  // a test that reads it later sees nothing and blames the wrong thing. The
  // Leave button is present for as long as this client is actually in the
  // room, which is the condition every caller here means.
  await expect(
    page.getByRole("button", { name: "Leave", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
}

export async function leaveVoice(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Leave", exact: true }).click();
  await expect(page.getByText("Live")).not.toBeVisible({ timeout: 20_000 });
}

// ------------------------------------------------------------- assertions

/** The last state either direction of the socket saw, or null if none. */
export function latestState(frames: RecordedFrame[]): RecordedFrame["state"] {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const frame = frames[i];
    if (frame) {
      return frame.state;
    }
  }
  return null;
}

/**
 * Poll a page's inbound frames until one satisfies `match`, and report how long
 * that took from `since`. Convergence criteria are stated in milliseconds, so
 * the harness has to measure milliseconds rather than assert eventual truth.
 */
export async function waitForInbound(
  page: Page,
  match: (state: NonNullable<RecordedFrame["state"]>) => boolean,
  timeoutMs = 10_000,
): Promise<{ frame: RecordedFrame; waitedMs: number }> {
  const started = Date.now();
  for (;;) {
    const frames = await recordedFrames(page);
    const hit = frames.find(
      (frame) => frame.direction === "in" && frame.state && match(frame.state),
    );
    if (hit) {
      return { frame: hit, waitedMs: Date.now() - started };
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `no inbound watch-party frame matched within ${timeoutMs}ms; saw ${JSON.stringify(
          frames.filter((frame) => frame.direction === "in").slice(-5),
        )}`,
      );
    }
    await page.waitForTimeout(100);
  }
}
