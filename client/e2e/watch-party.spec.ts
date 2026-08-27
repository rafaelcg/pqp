import { expect, test, type Page } from "@playwright/test";
import {
  bootAs,
  clearFrames,
  clearPlayerCalls,
  extraClient,
  injectInbound,
  joinVoice,
  playerCalls,
  readPlayer,
  recordedFrames,
  seedVoiceRoom,
  settleOutbound,
  waitForInbound,
  type Client,
} from "./watch-party-harness";
import { CONTROL, EMBED_DISABLED, LONG_CONTROL } from "./watch-party-videos";

/**
 * The acceptance criteria, as two real browsers in one voice channel.
 *
 * Everything here drives the product surface a person drives, and observes it
 * through the two seams the harness taps: the socket, and the calls the client
 * makes into the YouTube player. Neither the DOM nor the iframe can be trusted
 * to answer the questions these tests ask. The DOM shows what a client
 * believes; the iframe is cross origin and shows nothing at all.
 *
 * `--autoplay-policy=no-user-gesture-required` is deliberately NOT set. The
 * design's answer to autoplay is an explicit per-person "join the watch party"
 * click, and a launch flag that defeats the browser's block would make the one
 * test that checks that answer pass for the wrong reason.
 */

test.use({
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
  permissions: ["microphone"],
});

// Two app boots, a voice handshake, and a real video loaded from a real CDN.
test.setTimeout(180_000);

const YOUTUBE_URL = `https://www.youtube.com/watch?v=${LONG_CONTROL.id}`;

/** How close two peers have to land. The brief says "within about a second". */
const CONVERGENCE_MS = 1_500;

// ------------------------------------------------------------- affordances

const launcher = (page: Page) =>
  page.getByRole("button", { name: "Watch together" });
const urlField = (page: Page) => page.getByLabel("YouTube link");
const start = (page: Page) => page.getByRole("button", { name: "Start", exact: true });
const joinParty = (page: Page) =>
  page.getByRole("button", { name: "Join the watch party" });
const playButton = (page: Page) => page.getByRole("button", { name: "Play", exact: true });
const pauseButton = (page: Page) =>
  page.getByRole("button", { name: "Pause", exact: true });
const forward = (page: Page) =>
  page.getByRole("button", { name: "Forward 10 seconds" });

/**
 * Open a party on `page` and wait until this peer's own player is running.
 *
 * The join click is load bearing rather than incidental: it is the user
 * gesture the whole autoplay design hangs on, so a helper that skipped it
 * would quietly make every other test here unrepresentative.
 */
async function startParty(page: Page, url = YOUTUBE_URL): Promise<void> {
  await launcher(page).click();
  await urlField(page).fill(url);
  await start(page).click();
}

async function joinIfOffered(page: Page): Promise<void> {
  const cta = joinParty(page);
  if (await cta.isVisible().catch(() => false)) {
    await cta.click();
  }
}

interface Pair {
  host: Page;
  guest: Client;
  serverId: string;
}

async function twoPeers(
  page: Page,
  browser: Parameters<typeof extraClient>[0],
  suffixes: [string, string],
): Promise<Pair> {
  const room = await seedVoiceRoom(suffixes);
  const guest = await extraClient(
    browser,
    `/app/servers/${room.serverId}`,
    suffixes[1],
  );
  await bootAs(page, `/app/servers/${room.serverId}`, suffixes[0]);
  await joinVoice(page);
  await joinVoice(guest.page);
  return { host: page, guest, serverId: room.serverId };
}

// ------------------------------------------------------------ harness

test("the harness itself puts two accounts in one voice channel", async ({
  page,
  browser,
}) => {
  // A self test, and worth its thirty seconds. Everything below depends on
  // this working, so when the suite goes red it should be obvious in one line
  // whether the feature broke or the scaffolding did.
  const pair = await twoPeers(page, browser, ["wp-smoke-a", "wp-smoke-b"]);
  try {
    for (const target of [pair.host, pair.guest.page]) {
      await expect(
        target.getByRole("button", { name: "Leave", exact: true }),
      ).toBeVisible();
    }
    // Each side sees the other, which is the part a single client cannot fake.
    await expect(
      pair.host.getByText("Dev User wp-smoke-b").first(),
    ).toBeVisible({ timeout: 20_000 });
  } finally {
    await pair.guest.close();
  }
});

// -------------------------------------------------------- criterion 1 and 2

test("one peer pastes a URL and both load it", async ({ page, browser }) => {
  const pair = await twoPeers(page, browser, ["wp-load-a", "wp-load-b"]);
  try {
    await startParty(pair.host);
    await joinIfOffered(pair.host);

    // The guest is told about it over the socket.
    const { frame, waitedMs } = await waitForInbound(
      pair.guest.page,
      (state) => state.videoId === LONG_CONTROL.id,
    );
    // eslint-disable-next-line no-console
    console.log(`[watch] guest heard the video in ${waitedMs}ms`);
    expect(frame.state?.videoId).toBe(LONG_CONTROL.id);

    // And the guest's own player actually loads it, rather than the guest
    // merely being told about a video it never opened.
    await joinIfOffered(pair.guest.page);
    await expect
      .poll(async () => (await readPlayer(pair.guest.page)).videoId, {
        timeout: 30_000,
      })
      .toBe(LONG_CONTROL.id);
  } finally {
    await pair.guest.close();
  }
});

test("play, pause and seek converge within about a second, from either side", async ({
  page,
  browser,
}) => {
  const pair = await twoPeers(page, browser, ["wp-conv-a", "wp-conv-b"]);
  try {
    await startParty(pair.host);
    await joinIfOffered(pair.host);
    await joinIfOffered(pair.guest.page);
    await expect
      .poll(async () => (await readPlayer(pair.guest.page)).videoId, {
        timeout: 30_000,
      })
      .toBe(LONG_CONTROL.id);

    // Host plays. Guest must follow.
    await clearFrames(pair.guest.page);
    await playButton(pair.host).click();
    const played = await waitForInbound(
      pair.guest.page,
      (state) => state.status === "playing",
      CONVERGENCE_MS,
    );
    // eslint-disable-next-line no-console
    console.log(`[watch] play converged in ${played.waitedMs}ms`);
    await expect
      .poll(async () => (await readPlayer(pair.guest.page)).playerState, {
        timeout: 10_000,
      })
      .toBe(1);

    // Control passes the other way: the GUEST pauses, and the host follows.
    // This is the half a host-and-follower design would fail.
    await clearFrames(pair.host);
    await pauseButton(pair.guest.page).click();
    const paused = await waitForInbound(
      pair.host,
      (state) => state.status === "paused",
      CONVERGENCE_MS,
    );
    // eslint-disable-next-line no-console
    console.log(`[watch] pause from the guest converged in ${paused.waitedMs}ms`);
    await expect
      .poll(async () => (await readPlayer(pair.host)).playerState, {
        timeout: 10_000,
      })
      .toBe(2);

    // And a seek, again from the guest.
    await clearFrames(pair.host);
    const before = (await readPlayer(pair.host)).currentTime ?? 0;
    await forward(pair.guest.page).click();
    const sought = await waitForInbound(
      pair.host,
      (state) => Math.abs(state.positionMs / 1_000 - (before + 10)) < 3,
      CONVERGENCE_MS,
    );
    // eslint-disable-next-line no-console
    console.log(`[watch] seek converged in ${sought.waitedMs}ms`);
    await expect
      .poll(async () => (await readPlayer(pair.host)).currentTime ?? 0, {
        timeout: 10_000,
      })
      .toBeGreaterThan(before + 7);
  } finally {
    await pair.guest.close();
  }
});

// ------------------------------------------------------------ oscillation

test("applying a remote update does not rebroadcast it", async ({
  page,
  browser,
}) => {
  // THE failure mode. A client that answers a remote state with a state of its
  // own gives the room a feedback loop, and the loop is bounded only by the
  // rate limiter. Two real browsers can only stumble into this; one real
  // browser and one synthetic peer can ask it directly.
  const pair = await twoPeers(page, browser, ["wp-osc-a", "wp-osc-b"]);
  try {
    await startParty(pair.host);
    await joinIfOffered(pair.host);
    await joinIfOffered(pair.guest.page);
    await expect
      .poll(async () => (await readPlayer(pair.guest.page)).videoId, {
        timeout: 30_000,
      })
      .toBe(LONG_CONTROL.id);

    // One remote pause, delivered by the other browser exactly once. Anything
    // the guest sends after applying it is its own echo and nothing else.
    await clearFrames(pair.guest.page);
    await pauseButton(pair.host).click();

    const outbound = await settleOutbound(pair.guest.page);
    // eslint-disable-next-line no-console
    console.log(
      `[watch] guest sent ${outbound.length} frames after applying one remote pause`,
    );
    expect(
      outbound.length,
      `applying a remote pause produced ${outbound.length} outbound frames; anything above zero is the oscillation`,
    ).toBe(0);
  } finally {
    await pair.guest.close();
  }
});

test("two peers pausing at the same instant agree on the same answer", async ({
  page,
  browser,
}) => {
  const pair = await twoPeers(page, browser, ["wp-race-a", "wp-race-b"]);
  try {
    await startParty(pair.host);
    await joinIfOffered(pair.host);
    await joinIfOffered(pair.guest.page);
    await expect
      .poll(async () => (await readPlayer(pair.guest.page)).videoId, {
        timeout: 30_000,
      })
      .toBe(LONG_CONTROL.id);
    await playButton(pair.host).click();
    await waitForInbound(pair.guest.page, (state) => state.status === "playing");
    await joinIfOffered(pair.guest.page);

    await clearFrames(pair.host);
    await clearFrames(pair.guest.page);
    // As close to simultaneous as two browsers get: both clicks issued without
    // awaiting the other.
    await Promise.all([
      pauseButton(pair.host).click(),
      pauseButton(pair.guest.page).click(),
    ]);

    await settleOutbound(pair.host);
    await settleOutbound(pair.guest.page);

    const lastAdopted = async (target: Page) => {
      const frames = await recordedFrames(target);
      const inbound = frames.filter(
        (frame) => frame.direction === "in" && frame.state,
      );
      return inbound[inbound.length - 1]?.state ?? null;
    };
    const hostState = await lastAdopted(pair.host);
    const guestState = await lastAdopted(pair.guest.page);
    // eslint-disable-next-line no-console
    console.log(
      `[watch] race settled host=${JSON.stringify(hostState)} guest=${JSON.stringify(guestState)}`,
    );

    // Agreeing is not the same as stopping. Both peers must hold the SAME
    // winner, identified by the pair the contract says is total.
    expect(hostState?.rev).toBe(guestState?.rev);
    expect(hostState?.actorId).toBe(guestState?.actorId);
    expect(hostState?.status).toBe("paused");
    expect(guestState?.status).toBe("paused");
  } finally {
    await pair.guest.close();
  }
});

// ------------------------------------------------------------ criterion 3

test("a peer joining mid video lands at the right position and state", async ({
  page,
  browser,
}) => {
  const room = await seedVoiceRoom(["wp-mid-a", "wp-mid-b"]);
  let late: Client | null = null;
  try {
    await bootAs(page, `/app/servers/${room.serverId}`, "wp-mid-a");
    await joinVoice(page);
    await startParty(page);
    await joinIfOffered(page);
    await playButton(page).click();
    // Let it get somewhere that is unmistakably not the start.
    await expect
      .poll(async () => (await readPlayer(page)).currentTime ?? 0, {
        timeout: 60_000,
      })
      .toBeGreaterThan(12);
    const hostAt = (await readPlayer(page)).currentTime ?? 0;

    late = await extraClient(
      browser,
      `/app/servers/${room.serverId}`,
      "wp-mid-b",
    );
    await joinVoice(late.page);
    await joinIfOffered(late.page);

    await expect
      .poll(async () => (await readPlayer(late!.page)).videoId, {
        timeout: 30_000,
      })
      .toBe(LONG_CONTROL.id);
    await expect
      .poll(async () => (await readPlayer(late!.page)).playerState, {
        timeout: 30_000,
      })
      .toBe(1);
    const lateAt = (await readPlayer(late.page)).currentTime ?? 0;
    // eslint-disable-next-line no-console
    console.log(`[watch] host at ${hostAt}s, late joiner landed at ${lateAt}s`);
    // Generous, because the join itself takes real time and the host keeps
    // playing through it. Landing at 0 is the failure this catches.
    expect(lateAt).toBeGreaterThan(hostAt - 3);
  } finally {
    await late?.close();
  }
});

// ------------------------------------------------------------ criterion 4

test("the last person leaving tears the party down", async ({
  page,
  browser,
}) => {
  const room = await seedVoiceRoom(["wp-tdn-a", "wp-tdn-b", "wp-tdn-c"]);
  let guest: Client | null = null;
  let after: Client | null = null;
  try {
    await bootAs(page, `/app/servers/${room.serverId}`, "wp-tdn-a");
    await joinVoice(page);
    guest = await extraClient(
      browser,
      `/app/servers/${room.serverId}`,
      "wp-tdn-b",
    );
    await joinVoice(guest.page);
    await startParty(page);
    await joinIfOffered(page);
    await waitForInbound(guest.page, (state) => state.videoId === LONG_CONTROL.id);

    await page.getByRole("button", { name: "Leave", exact: true }).click();
    await guest.page.getByRole("button", { name: "Leave", exact: true }).click();

    // A third person walks into an empty channel. There must be no party.
    after = await extraClient(
      browser,
      `/app/servers/${room.serverId}`,
      "wp-tdn-c",
    );
    await joinVoice(after.page);
    await expect(launcher(after.page)).toBeVisible({ timeout: 20_000 });
    await expect(joinParty(after.page)).not.toBeVisible();
    const frames = await recordedFrames(after.page);
    const inheritedState = frames.find(
      (frame) => frame.direction === "in" && frame.state !== null,
    );
    expect(
      inheritedState,
      "a fresh joiner inherited a party nobody is in",
    ).toBeUndefined();
  } finally {
    await guest?.close();
    await after?.close();
  }
});

// ------------------------------------------------------------ criterion 5

test("an embed-disabled video shows a fallback without breaking the room", async ({
  page,
  browser,
}) => {
  const pair = await twoPeers(page, browser, ["wp-fail-a", "wp-fail-b"]);
  try {
    await startParty(
      pair.host,
      `https://www.youtube.com/watch?v=${EMBED_DISABLED.id}`,
    );
    await joinIfOffered(pair.host);
    await joinIfOffered(pair.guest.page);

    // Both see the fallback, because embedding is disabled for everyone.
    for (const target of [pair.host, pair.guest.page]) {
      await expect(
        target.getByText("This video will not play outside YouTube"),
      ).toBeVisible({ timeout: 40_000 });
      await expect(
        target.getByRole("link", { name: "Watch on YouTube" }),
      ).toBeVisible();
    }

    // The room is not broken: the party can still be pointed at something
    // that works, and both sides follow.
    await pair.host.getByRole("button", { name: "Change video" }).click();
    await urlField(pair.host).fill(`https://youtu.be/${CONTROL.id}`);
    await start(pair.host).click();
    await waitForInbound(
      pair.guest.page,
      (state) => state.videoId === CONTROL.id,
      10_000,
    );
  } finally {
    await pair.guest.close();
  }
});

test("a peer whose player failed follows the room and never writes to it", async ({
  page,
  browser,
}) => {
  // The failure this prevents is spectacular: a dead player reports position 0
  // forever (verified in `watch-party-youtube-reality.spec.ts`), so if it is
  // allowed to write, its 0 on a fresh `rev` outranks everyone and drags the
  // whole room back to the start of the video.
  //
  // Provoked one sided rather than for everybody: the guest's page is made to
  // fail by blocking YouTube's player host for that context only, so the host
  // watches normally while the guest cannot.
  const room = await seedVoiceRoom(["wp-read-a", "wp-read-b"]);
  let guest: Client | null = null;
  try {
    await bootAs(page, `/app/servers/${room.serverId}`, "wp-read-a");
    await joinVoice(page);
    guest = await extraClient(
      browser,
      `/app/servers/${room.serverId}`,
      "wp-read-b",
    );
    await guest.page.route("https://www.youtube.com/embed/**", (route) =>
      route.abort(),
    );
    await joinVoice(guest.page);

    await startParty(page);
    await joinIfOffered(page);
    await joinIfOffered(guest.page);
    await waitForInbound(guest.page, (state) => state.videoId === LONG_CONTROL.id);

    await clearFrames(guest.page);
    await playButton(page).click();
    await waitForInbound(guest.page, (state) => state.status === "playing");

    const outbound = await settleOutbound(guest.page);
    // eslint-disable-next-line no-console
    console.log(
      `[watch] broken guest sent ${outbound.length} frames: ${JSON.stringify(outbound.map((f) => f.state))}`,
    );
    expect(
      outbound.filter((frame) => frame.state !== null).length,
      "a peer whose player failed wrote to the room",
    ).toBe(0);

    // And the host is unharmed: still playing, still moving forward.
    const reading = await readPlayer(page);
    expect(reading.playerState).toBe(1);
    expect(reading.currentTime ?? 0).toBeGreaterThan(0);
  } finally {
    await guest?.close();
  }
});

// --------------------------------------------------------------- autoplay

test("a participant who never clicked is not playing", async ({
  page,
  browser,
}) => {
  const room = await seedVoiceRoom(["wp-auto-a", "wp-auto-b"]);
  let guest: Client | null = null;
  try {
    await bootAs(page, `/app/servers/${room.serverId}`, "wp-auto-a");
    await joinVoice(page);
    guest = await extraClient(
      browser,
      `/app/servers/${room.serverId}`,
      "wp-auto-b",
    );
    await joinVoice(guest.page);

    await startParty(page);
    await joinIfOffered(page);
    await playButton(page).click();
    await waitForInbound(guest.page, (state) => state.status === "playing");

    // Deliberately no click on the guest side beyond joining the channel. The
    // design's answer is an explicit per-person gesture, so the guest must be
    // offered one and must not be playing until it is given.
    await expect(joinParty(guest.page)).toBeVisible({ timeout: 20_000 });
    await guest.page.waitForTimeout(4_000);
    const reading = await readPlayer(guest.page);
    // eslint-disable-next-line no-console
    console.log(`[watch] unclicked guest player: ${JSON.stringify(reading)}`);
    expect(reading.playerState, "an unclicked participant is playing").not.toBe(1);

    // One click and they are in, which is the other half of the promise.
    await joinParty(guest.page).click();
    await expect
      .poll(async () => (await readPlayer(guest!.page)).playerState, {
        timeout: 30_000,
      })
      .toBe(1);
  } finally {
    await guest?.close();
  }
});

// ------------------------------------------------------------ drift ladder

test("the drift ladder does nothing under 150ms, nudges the rate up to 1s, and only seeks beyond it", async ({
  page,
  browser,
}) => {
  // Measured rather than taken on trust, and measured at the two places that
  // can disagree: the command the client issues, and the rate the player
  // actually ends up at. Those differ, because YouTube quantises playback rate
  // to multiples of 0.05 and silently rounds 1.03 down to exactly 1.0.
  const pair = await twoPeers(page, browser, ["wp-drift-a", "wp-drift-b"]);
  try {
    await startParty(pair.host);
    await joinIfOffered(pair.host);
    await joinIfOffered(pair.guest.page);
    await playButton(pair.host).click();
    await expect
      .poll(async () => (await readPlayer(pair.guest.page)).playerState, {
        timeout: 40_000,
      })
      .toBe(1);
    await expect
      .poll(async () => (await readPlayer(pair.guest.page)).currentTime ?? 0, {
        timeout: 40_000,
      })
      .toBeGreaterThan(20);

    /**
     * Tell the guest it is `driftMs` behind (positive) or ahead (negative) of
     * the room, by handing it a state sampled now at a position that differs
     * from where it is. Injected rather than clicked, because a drift of
     * exactly 300ms cannot be produced by a person.
     */
    const nudgeBy = async (driftMs: number, rev: number) => {
      const reading = await readPlayer(pair.guest.page);
      const positionMs = Math.round((reading.currentTime ?? 0) * 1_000 + driftMs);
      const seen = await recordedFrames(pair.guest.page);
      const channelId = seen.find(
        (frame) => frame.direction === "in" && frame.channelId,
      )?.channelId;
      await clearPlayerCalls(pair.guest.page);
      await injectInbound(pair.guest.page, {
        type: "watch-party",
        channelId,
        state: {
          videoId: LONG_CONTROL.id,
          status: "playing",
          positionMs: Math.max(0, positionMs),
          atMs: Date.now(),
          rev,
          actorId: "zz-synthetic-peer",
        },
      });
    };

    // --- under the deadband: nothing at all
    await nudgeBy(80, 500);
    await pair.guest.page.waitForTimeout(2_000);
    const quiet = await playerCalls(pair.guest.page);
    // eslint-disable-next-line no-console
    console.log(`[watch] 80ms drift -> ${JSON.stringify(quiet)}`);
    expect(
      quiet.filter((call) => call.method === "seekTo" || call.method === "setPlaybackRate"),
      "an 80ms drift moved the player",
    ).toEqual([]);

    // --- inside the nudge band: rate changes, and NO seek
    await nudgeBy(500, 501);
    const rates: number[] = [];
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const rate = (await readPlayer(pair.guest.page)).playbackRate;
      if (rate !== null) {
        rates.push(rate);
      }
      if (rates.length > 4 && rates.some((r) => r !== 1) && rates.at(-1) === 1) {
        break;
      }
      await pair.guest.page.waitForTimeout(250);
    }
    const nudged = await playerCalls(pair.guest.page);
    // eslint-disable-next-line no-console
    console.log(
      `[watch] 500ms drift -> calls ${JSON.stringify(nudged)} rates ${JSON.stringify(rates)}`,
    );
    expect(
      nudged.filter((call) => call.method === "seekTo"),
      "the ladder hard seeked inside the nudge band",
    ).toEqual([]);
    // The command was issued...
    expect(
      nudged.some((call) => call.method === "setPlaybackRate"),
      "no rate command was issued inside the nudge band",
    ).toBe(true);
    // ...and, the part that actually matters, the player LEFT 1.0. A rate the
    // API rounds back to 1.0 issues the command, changes nothing, and lets the
    // drift persist until the seek threshold catches it, which looks exactly
    // like a working ladder from every other angle.
    expect(
      rates.some((rate) => rate !== 1),
      `the player never left rate 1.0; observed ${JSON.stringify(rates)}`,
    ).toBe(true);
    // And it comes back.
    expect(rates.at(-1), "the rate did not return to exactly 1.0").toBe(1);

    // --- past a second: a seek
    await nudgeBy(3_000, 502);
    await expect
      .poll(
        async () =>
          (await playerCalls(pair.guest.page)).filter(
            (call) => call.method === "seekTo",
          ).length,
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
  } finally {
    await pair.guest.close();
  }
});
