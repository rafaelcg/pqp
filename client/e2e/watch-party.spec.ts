import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * The watch party journey, in a browser: create, go live, be seen, be
 * watched, end.
 *
 * WHY THIS EXISTS. The server half of this feature has real coverage
 * (`server/src/services/watch-parties.test.ts`, `watch-party-options.test.ts`,
 * `ws/voice-hls-audience.test.ts`) and was rehearsed on staging. The CLIENT
 * half had none: nobody had clicked Criar watch party, the setup surface, the
 * sidebar block or the viewer stage on a running build. Everything below is
 * about what a person sees, and every assertion is on a real server, a real
 * socket and a real second account.
 *
 * THE FLAG IS ON, AND THAT IS THE FIRST THING THIS SPEC HAS TO EARN.
 * `VITE_WATCH_PARTY_CHANNELS` is a BUILD flag and the e2e Vite server does not
 * set it, so a spec that forgot about it would render nothing and pass by
 * testing nothing, the failure this repo keeps hitting (pitfalls 9 and 12).
 * `?watchParty=1` is the documented dev-bypass override
 * (`lib/watch-party-channels.ts`), it is on every navigation here, and
 * `the create control is gated on the permission` asserts the flag-on chrome
 * and its absence side by side in one run, so a flag that stopped working
 * fails that test rather than quietly emptying every other one.
 *
 * WHAT IS STUBBED, AND WHERE THE LINE IS. CI has no LiveKit, no egress and no
 * `LIVE_HLS_S3_*` bucket, so two things it cannot produce are substituted and
 * nothing else is.
 *
 * 1. `withFakeLiveStream`: the `stream` of a `channel-live` frame and of
 *    `GET /api/channels/:id/live`, both of which are otherwise the real
 *    server's real answers on the real socket. The one test that uses it
 *    (`a seated viewer does not get the player twice`) keeps the
 *    substitution CONSTANT across both halves and moves only the seat, so it
 *    cannot pass by the stub failing to arrive: the picture has to appear,
 *    then go when the seat is taken, then come back when it is given up.
 * 2. `withLiveHlsConfig`: `GET /api/live-hls/config`, the operator's
 *    per-server `LIVE_HLS_SERVER_ALLOWLIST` answer. `openAs` sets it to
 *    `enabled: true`, because the create control now follows it as well as
 *    the permission bit (`canOfferWatchPartyCreate`) and a runner's API says
 *    `false` for every server. `the create control is absent on a server the
 *    operator has not allowlisted` is the test that runs it the other way, so
 *    the substitution is exercised in both directions rather than being a
 *    switch nobody ever turns off.
 *
 * Nothing else is faked: the party rows, the permissions, the broadcast, the
 * seat and the roster are all genuine.
 *
 * TWO ACCOUNTS, ALWAYS. The dev bypass signs every browser in as one shared
 * account unless `pqp:dev-user-suffix` is set, so a one-browser test of "the
 * member sees the party" would be the host looking at their own screen.
 *
 * SHARD. This file does not match `MEDIA_SPEC`, so it runs in the `chromium`
 * project. It takes no display capture; the fake device flags below are only
 * for the microphone the ordinary join opens.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

// Two app boots, a socket round trip each way, and a voice join.
test.setTimeout(120_000);

test.use({
  launchOptions: {
    args: [
      // `Join the call` from the watch stage is the ORDINARY join, which opens
      // a microphone. Without a fake device it falls back to listen-only,
      // which still works but adds a banner and a real permission timeout to
      // every run. Nothing here captures a display.
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
  permissions: ["microphone"],
});

function headersFor(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

/**
 * Make the account real, past the age gate and past onboarding.
 *
 * `firstRunDismissedAt` rides along for the reason `fixtures.ts` gives: a
 * fresh account's checklist would draw itself over the chrome these tests
 * measure.
 */
async function materialiseAccount(suffix: string): Promise<string> {
  const headers = headersFor(suffix);
  const me = await fetch(`${API}/api/me`, { headers });
  const body = (await me.json()) as { id: string; ageGate?: string };
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
  return body.id;
}

interface Shared {
  serverId: string;
  textChannelId: string;
}

/**
 * A server of its own, per test.
 *
 * NOT `servers[0]`. Two specs in this suite were recently found passing only
 * because a shard-mate had seeded the database first, and a watch party
 * mutates the server it runs in (a hidden `watch_party` room, SPEAK
 * overwrites, the channel's slow mode). Borrowing a shared server would leave
 * that behind for whatever runs next.
 */
async function seedServer(
  ownerSuffix: string,
  guestSuffix?: string,
): Promise<Shared> {
  await materialiseAccount(ownerSuffix);
  if (guestSuffix) {
    await materialiseAccount(guestSuffix);
  }

  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(ownerSuffix),
    body: JSON.stringify({ name: `Watch ${Date.now()}` }),
  });
  if (!created.ok) {
    throw new Error(`could not seed a server: ${created.status}`);
  }
  const { server } = (await created.json()) as { server: { id: string } };

  const channelsRes = await fetch(`${API}/api/servers/${server.id}/channels`, {
    headers: headersFor(ownerSuffix),
  });
  const { channels } = (await channelsRes.json()) as {
    channels: { id: string; type: string }[];
  };
  const text = channels.find((one) => one.type === "text")!;

  if (guestSuffix) {
    const inviteRes = await fetch(`${API}/api/servers/${server.id}/invites`, {
      method: "POST",
      headers: headersFor(ownerSuffix),
      body: JSON.stringify({}),
    });
    const { invite } = (await inviteRes.json()) as {
      invite: { code: string };
    };
    const joined = await fetch(`${API}/api/invites/${invite.code}/join`, {
      method: "POST",
      headers: headersFor(guestSuffix),
    });
    if (!joined.ok) {
      throw new Error(`the guest could not join: ${joined.status}`);
    }
  }

  return { serverId: server.id, textChannelId: text.id };
}

/** A draft party in the server's hidden room, through the real create route. */
async function createParty(
  suffix: string,
  serverId: string,
  name: string,
): Promise<{ partyId: string; channelId: string }> {
  const res = await fetch(`${API}/api/servers/${serverId}/watch-parties`, {
    method: "POST",
    headers: headersFor(suffix),
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(`could not create the party: ${res.status}`);
  }
  const { party } = (await res.json()) as {
    party: { id: string; channelId: string };
  };
  return { partyId: party.id, channelId: party.channelId };
}

async function setPartyState(
  suffix: string,
  partyId: string,
  state: "live" | "ended" | "cancelled",
): Promise<void> {
  const res = await fetch(`${API}/api/watch-parties/${partyId}/state`, {
    method: "POST",
    headers: headersFor(suffix),
    body: JSON.stringify({ state }),
  });
  if (!res.ok) {
    throw new Error(`could not move the party to ${state}: ${res.status}`);
  }
}

/** The host bringing somebody up to speak. The one path to a seat for a non-host. */
async function inviteToStage(
  suffix: string,
  partyId: string,
  userId: string,
): Promise<void> {
  const res = await fetch(`${API}/api/watch-parties/${partyId}/stage`, {
    method: "POST",
    headers: headersFor(suffix),
    body: JSON.stringify({ action: "invite", userId }),
  });
  if (!res.ok) {
    throw new Error(`could not put them on the stage: ${res.status}`);
  }
}

/**
 * The operator's per-server answer, which a runner cannot produce: with no
 * `LIVE_HLS_S3_*` bucket the real endpoint says `enabled: false` for every
 * server. `enabled` is the only field written; `delaySeconds`, `allowlisted`
 * and `ladder` stay exactly as the server sent them.
 */
async function withLiveHlsConfig(page: Page, enabled: boolean): Promise<void> {
  await page.route("**/api/live-hls/config*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, enabled } });
  });
}

/**
 * Open the app as one of the two accounts, with the watch party flag on and
 * the open server allowlisted for live HLS.
 *
 * `?watchParty=1` is the whole point: without it every watch party assertion
 * below would be looking at chrome the build never rendered. The config
 * substitution is the second half of the same point: the create control asks
 * the server whether a party can run here, and on a runner the honest answer
 * is no.
 */
async function openAs(
  page: Page,
  path: string,
  suffix: string,
  options: { hlsEnabled?: boolean } = {},
): Promise<void> {
  await withLiveHlsConfig(page, options.hlsEnabled ?? true);
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(`${path}?lang=en&watchParty=1`);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByPlaceholder(/^Message /)).toBeVisible({
    timeout: 20_000,
  });
}

async function secondClient(browser: Browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    permissions: ["microphone"],
  });
  const page = await context.newPage();
  return { context, page };
}

/**
 * Count `getUserMedia` calls in the page, from before the app boots.
 *
 * "Nobody watching is ever asked for a microphone" is a product rule
 * (`docs/WATCH_PARTY.md`), and a screenshot cannot prove it: a prompt that was
 * asked for and auto-answered by the fake UI looks identical to one that was
 * never asked. Counting the calls is the only assertion that distinguishes
 * them, which is why it is installed before anything else runs.
 */
async function installGumCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const holder = window as unknown as { __e2eGum?: number };
    holder.__e2eGum = 0;
    const media = navigator.mediaDevices;
    if (!media) {
      return;
    }
    const original = media.getUserMedia.bind(media);
    media.getUserMedia = (constraints?: MediaStreamConstraints) => {
      holder.__e2eGum = (holder.__e2eGum ?? 0) + 1;
      return original(constraints);
    };
  });
}

/** How many microphone prompts this page has opened since it booted. */
function gumCalls(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __e2eGum?: number }).__e2eGum ?? -1,
  );
}

/**
 * The ONE thing CI cannot produce: an HLS playlist coming out of a LiveKit
 * egress. Both seams the client learns about a stream from are proxied rather
 * than replaced, and only the `stream` field is written; `watching`,
 * `participants` and every other frame stay exactly as the server sent them.
 *
 * The playlist itself answers a valid media manifest so hls.js parses
 * something real instead of going fatal on a 401 and drawing its dead overlay
 * over the stage. Its one segment 404s, which hls.js retries and which no
 * assertion here depends on: this spec is about who is offered a picture, not
 * about decoding one.
 */
async function withFakeLiveStream(
  page: Page,
  channelId: string,
): Promise<void> {
  const stream = {
    hlsUrl: `/api/voice/hls-playlist/${channelId}/e2e-session?t=e2e`,
    startedAt: Date.now(),
    presenterPeerId: "e2e-presenter",
    delaySeconds: 8,
  };

  await page.route(`**/api/channels/${channelId}/live`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      response,
      json: { ...body, stream },
    });
  });

  await page.route("**/api/voice/hls-playlist/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/vnd.apple.mpegurl",
      body: [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-TARGETDURATION:4",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXTINF:4.0,",
        "e2e0.ts",
        "",
      ].join("\n"),
    }),
  );
  await page.route("**/e2e0.ts", (route) => route.fulfill({ status: 404 }));

  // The socket is the seam that matters. The server answers every
  // `watch-live` with a `channel-live` of its own, and in CI that answer is
  // honestly `stream: null`, which would wipe the HTTP seed a beat after it
  // landed and leave the stage flickering out. Proxying lets the real frame
  // through with the one impossible field filled in.
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (typeof message !== "string") {
        ws.send(message);
        return;
      }
      try {
        const frame = JSON.parse(message) as Record<string, unknown>;
        if (frame.type === "channel-live" && frame.channelId === channelId) {
          ws.send(JSON.stringify({ ...frame, stream }));
          return;
        }
      } catch {
        // Not JSON, or not ours. Pass it through untouched.
      }
      ws.send(message);
    });
  });
}

// --------------------------------------------------------------- the journey

test("a host creates a watch party from the sidebar, names it, and goes live", async ({
  page,
}) => {
  const shared = await seedServer("wp-host");
  await openAs(
    page,
    `/app/server/${shared.serverId}/channel/${shared.textChannelId}`,
    "wp-host",
  );

  // Step one: the ONE control at the top of the sidebar. There is no watch
  // party section and no channel to find first, which is the whole shape of
  // the change.
  const create = page.locator("[data-live-party-create]");
  await expect(create).toBeVisible({ timeout: 20_000 });
  await create.click();

  await page.locator("[data-create-watch-party-name]").fill("Cinemoon");
  await page.locator("[data-create-watch-party-submit]").click();

  // Step two: the setup surface, which is a DRAFT. The host is now in a room
  // that did not exist a second ago, selected for them, holding the name they
  // typed. Nothing has been broadcast.
  const setup = page.getByTestId("watch-party-setup");
  await expect(setup).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-watch-party-name]")).toHaveValue("Cinemoon");
  await expect(page.getByText("Only you can see this")).toBeVisible();
  // A draft is private, so nothing about it is in the sidebar yet: the block
  // is what going live produces, and this is the assertion that says so.
  await expect(page.getByTestId("live-party-block")).toBeHidden();

  // THE DISCLOSURE, which only exists on a server that can actually
  // broadcast. The setup surface raises it once per server per session
  // (`hlsHostAckAskedRef` in App.tsx), so the host reads what they are
  // responsible for while nothing is being sent, rather than in the middle of
  // pressing Ir ao vivo. This spec used to skip it silently: a runner's
  // `/api/live-hls/config` says `enabled: false`, and the effect bails on an
  // explicit false. With `openAs` stubbing the operator answer to true, this
  // is the flow a real host on an allowlisted server walks.
  const ack = page.getByRole("dialog").filter({ hasText: "Before you go live" });
  await expect(ack).toBeVisible({ timeout: 20_000 });
  await ack.getByRole("button", { name: "Got it", exact: true }).click();
  await expect(ack).toBeHidden({ timeout: 20_000 });

  // Step three: Ir ao vivo. Deliberately with nothing picked, which is the
  // documented order (the party goes live first, the picture second) and the
  // case a host hits when the share fails. The room must still be told.
  await page.locator("[data-watch-party-go-live]").click();

  const bar = page.getByTestId("watch-party-bar");
  await expect(bar).toBeVisible({ timeout: 20_000 });
  await expect(bar.locator("[data-watch-party-name-label]")).toHaveText(
    "Cinemoon",
  );
  await expect(bar.getByText("LIVE")).toBeVisible();
  // Encerrar is on the bar from the first frame: a host who cannot end their
  // own show is the failure this bar exists to prevent.
  await expect(page.locator("[data-watch-party-end]")).toBeVisible();

  // And the sidebar block, above the categories, carrying the PARTY'S name
  // rather than the channel's.
  const block = page.getByTestId("live-party-block");
  await expect(block).toBeVisible({ timeout: 20_000 });
  await expect(block.getByText("Cinemoon")).toBeVisible();
  await expect(page.locator("[data-live-party-create]")).toBeHidden();
});

test("the create control is gated on the permission, and the block is not", async ({
  page,
  browser,
}) => {
  const shared = await seedServer("wp-owner", "wp-member");
  const here = `/app/server/${shared.serverId}/channel/${shared.textChannelId}`;

  await openAs(page, here, "wp-owner");
  // The flag-on half, in the same run and against the same build. Without
  // this the test below would pass on a build where watch parties do not
  // exist at all, which is exactly the way this repo's flag bugs hide.
  await expect(page.locator("[data-live-party-create]")).toBeVisible({
    timeout: 20_000,
  });

  const second = await secondClient(browser);
  try {
    await openAs(second.page, here, "wp-member");
    // The sidebar rendered for them: a member with no START_WATCH_PARTY sees
    // the room's channels and NOT a heading, an empty section or a
    // placeholder where a watch party would go.
    await expect(second.page.locator("[data-channel-type]").first()).toBeVisible(
      { timeout: 20_000 },
    );
    await expect(second.page.locator("[data-live-party-create]")).toHaveCount(0);
    await expect(second.page.getByTestId("live-party-create")).toHaveCount(0);
    await expect(second.page.getByTestId("live-party-block")).toHaveCount(0);

    // Now one goes live. The same member who may not START one must still SEE
    // it: the block is not permission gated, and if it were, an audience
    // would never find the show.
    const party = await createParty("wp-owner", shared.serverId, "Sessão QG");
    await setPartyState("wp-owner", party.partyId, "live");

    const block = second.page.getByTestId("live-party-block");
    await expect(block).toBeVisible({ timeout: 20_000 });
    await expect(block.getByText("Sessão QG")).toBeVisible();
    // Still no create button beside it.
    await expect(second.page.locator("[data-live-party-create]")).toHaveCount(0);
  } finally {
    await second.context.close();
  }
});

/**
 * THE QUIET LAUNCH, and the reason the allowlist still exists after the
 * blast radius was narrowed away. `START_WATCH_PARTY` was backfilled onto
 * 2753 roles across 908 servers, so with the build flag on globally the
 * permission bit alone would put this button in front of every one of those
 * moderators. It follows the server's live HLS config as well, so on a server
 * the operator has not named there is nothing: no button, no heading, no
 * disabled control and no empty state.
 *
 * The owner half runs in the same test, against the same build and the same
 * account, with only the config answer moved. Without it this would pass on a
 * build where the sidebar renders no watch party chrome at all.
 */
test("the create control is absent on a server the operator has not allowlisted", async ({
  page,
  browser,
}) => {
  const shared = await seedServer("wp-quiet-a", "wp-quiet-b");
  const here = `/app/server/${shared.serverId}/channel/${shared.textChannelId}`;

  await openAs(page, here, "wp-quiet-a", { hlsEnabled: false });
  // The sidebar really rendered, so "nothing" below is an absence and not a
  // page that failed to load.
  await expect(page.locator("[data-channel-type]").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator("[data-live-party-create]")).toHaveCount(0);
  await expect(page.getByTestId("live-party-create")).toHaveCount(0);
  await expect(page.getByTestId("live-party-block")).toHaveCount(0);
  // Not a disabled control either: the label is not on the page at all.
  await expect(page.getByText("New watch party")).toHaveCount(0);

  // Same person, same permission, same build: allowlist the server and the
  // control appears. That is the whole rollout switch, in one run.
  const allowed = await secondClient(browser);
  try {
    await openAs(allowed.page, here, "wp-quiet-a", { hlsEnabled: true });
    await expect(allowed.page.locator("[data-live-party-create]")).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    await allowed.context.close();
  }
});

test("a member opens the party from the sidebar, gets the audience surface without a seat, and keeps the chat", async ({
  page,
  browser,
}) => {
  const shared = await seedServer("wp-host2", "wp-viewer");
  const here = `/app/server/${shared.serverId}/channel/${shared.textChannelId}`;

  // The host takes it live before the viewer's browser is even open, which is
  // how most of an audience arrives: mid-show, into a room whose hidden
  // channel their client has never heard of.
  const party = await createParty("wp-host2", shared.serverId, "Cinemoon 2");
  await setPartyState("wp-host2", party.partyId, "live");

  const second = await secondClient(browser);
  try {
    const viewer = second.page;
    await installGumCounter(viewer);
    await openAs(viewer, here, "wp-viewer");

    const block = viewer.getByTestId("live-party-block");
    await expect(block).toBeVisible({ timeout: 20_000 });

    // ONE CLICK IS WATCHING. The block is the button; there is no chip inside
    // it and no second target for the same action.
    await block.locator("[data-live-party-row]").click();

    // The room the client had never seen is now selected, and the party says
    // in words that it has started and there is nothing on screen yet. This
    // is the pane Rafael's second browser found blank.
    const waiting = viewer.getByTestId("watch-party-waiting");
    await expect(waiting).toBeVisible({ timeout: 20_000 });
    await expect(waiting).toHaveAttribute("data-watch-party-waiting", "idle");
    await expect(waiting.getByText("The watch party has started")).toBeVisible();
    // The viewer's copy names the host, and is NOT the host's own copy.
    await expect(
      waiting.getByText("has not put anything on screen yet.", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      waiting.getByText("Share a window or a tab", { exact: false }),
    ).toHaveCount(0);

    // NOBODY WATCHING IS ASKED FOR A MICROPHONE, and nobody watching takes a
    // seat. Both are the same rule and both are asserted: no leave button
    // means no seat, and zero `getUserMedia` calls means no prompt.
    await expect(
      viewer.getByRole("button", { name: "Leave", exact: true }),
    ).toHaveCount(0);
    // -1 would mean the counter itself never installed, so a passing 0 here
    // is a real zero rather than a missing hook.
    expect(await gumCalls(viewer)).toBe(0);

    // The chat is what an audience does during a film, and it is beside the
    // picture in the party's own room like any other channel.
    const composer = viewer.getByPlaceholder(/^Message /);
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await composer.fill("que filme e esse");
    await composer.press("Enter");
    await expect(viewer.getByText("que filme e esse")).toBeVisible({
      timeout: 20_000,
    });

    // And the host sees it arrive in the same room, which is the other half
    // of "the chat is reachable": one transcript, not two.
    await openAs(page, here, "wp-host2");
    await page.locator("[data-live-party-row]").first().click();
    await expect(page.getByText("que filme e esse")).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    await second.context.close();
  }
});

test("an invited guest takes a seat and does not get the player twice", async ({
  browser,
}) => {
  const shared = await seedServer("wp-host3", "wp-seat");
  const here = `/app/server/${shared.serverId}/channel/${shared.textChannelId}`;

  const party = await createParty("wp-host3", shared.serverId, "Cinemoon 3");
  await setPartyState("wp-host3", party.partyId, "live");
  // THE ONLY WAY A NON-HOST GETS A SEAT NOW, and the reason this test moved
  // rather than being deleted: a plain viewer is offered nothing, so the
  // person who ends up seated is one the host brought up to speak. The
  // invariant underneath is unchanged and still worth pinning: the HLS
  // player must go when the WebRTC screen arrives, or it is the same film
  // twice, seconds apart, with both soundtracks.
  const guestId = await materialiseAccount("wp-seat");
  await inviteToStage("wp-host3", party.partyId, guestId);

  const second = await secondClient(browser);
  try {
    const viewer = second.page;
    await installGumCounter(viewer);
    await withFakeLiveStream(viewer, party.channelId);
    await openAs(viewer, here, "wp-seat");

    await viewer.getByTestId("live-party-block").waitFor({ timeout: 20_000 });
    await viewer.locator("[data-live-party-row]").click();

    // THE PICTURE, WITHOUT A SEAT. The stage mounts on the selection alone.
    const stage = viewer.getByTestId("watch-channel-stage");
    await expect(stage).toBeVisible({ timeout: 20_000 });
    await expect(viewer.getByTestId("watch-stage-live")).toBeVisible();
    await expect(stage.locator("video")).toHaveCount(1);
    // Watching still opened no microphone.
    expect(await gumCalls(viewer)).toBe(0);

    // Now take the seat, from the party bar, which for this person exists
    // only because the host invited them up. "a plain viewer is offered no
    // way into the call, anywhere" below is the other side of that.
    await viewer.locator("[data-watch-party-join-call]").click();
    await expect(stage).toHaveCount(0, { timeout: 20_000 });
    await expect(viewer.getByTestId("watch-stage-live")).toHaveCount(0);

    const leave = viewer.getByRole("button", { name: "Leave", exact: true });
    await expect(leave).toBeVisible({ timeout: 20_000 });
    // AND STILL NO MICROPHONE, EVEN SEATED. A live party's default
    // `stageMode` is `hosts_only`, which denies SPEAK to @everyone on the
    // channel, so this seat cannot speak and nothing asks it to prove that.
    // Speaking is the deliberate second act (`takeTheMicrophone`), and this
    // is the assertion that says the seat alone never triggers a prompt.
    expect(await gumCalls(viewer)).toBe(0);

    // NOT VACUOUS: the substituted stream never stopped arriving. Giving the
    // seat up brings the picture straight back, so what removed it was the
    // seat and nothing else.
    await leave.click();
    await expect(viewer.getByTestId("watch-channel-stage")).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    await second.context.close();
  }
});

/**
 * THE TAKEOVER, END TO END, AND IT IS THE ONE JOURNEY THAT HAD NO WAY IN.
 *
 * `POST /api/watch-parties/:id/cohosts`, `channel_session_cohosts` and
 * `setWatchPartyCohost` all shipped; nothing in the client ever called them.
 * So `Assumir` was rendered for `role === "cohost"` and there was no way to
 * become a co-host short of a curl, which `docs/WATCH_PARTY_QA.md` step 9 said
 * out loud. Every assertion below is on the real thing: a real promotion
 * through the real route, a real `watch-party-update` reaching a second
 * account's running client, a real socket close, and the real claim.
 *
 * THE HOST'S DROP IS NOT SIMULATED. The host's whole browser context is
 * closed, so their last socket goes and `onHostSocketClosed` stamps
 * `host_disconnected_at` the way it does in production. Nothing here writes
 * that column by hand, because the thing most likely to break is the path
 * between a closed tab and a stamped row.
 *
 * WHAT THIS DOES NOT PROVE, and `docs/WATCH_PARTY.md` says why: the PICTURE
 * does not survive the host dropping. The egress follows whoever is sharing,
 * not whoever is host, so a host who was presenting takes the stream with
 * them and the co-host has to share again. CI has no LiveKit and no egress, so
 * this spec could not assert that either way; it asserts that the party and
 * its controls survive, which is the half a button can deliver.
 */
test("the host appoints a co-host, drops, and the co-host takes the party over", async ({
  page,
  browser,
}) => {
  const shared = await seedServer("wp-hand-host", "wp-hand-guest");
  const here = `/app/server/${shared.serverId}/channel/${shared.textChannelId}`;
  const guestId = await materialiseAccount("wp-hand-guest");

  const party = await createParty("wp-hand-host", shared.serverId, "Cinemoon 5");
  await setPartyState("wp-hand-host", party.partyId, "live");

  // THE GUEST IS THE ONE ON THE DEFAULT PAGE, deliberately. The host goes in a
  // context of its own so the whole browser can be closed, which is the only
  // way to make the drop real rather than a row written by the test.
  const guest = page;
  await openAs(guest, here, "wp-hand-guest");
  await guest.locator("[data-live-party-row]").first().click();
  await expect(guest.getByTestId("watch-party-bar")).toBeVisible({
    timeout: 20_000,
  });

  // A plain viewer runs nothing. This is the baseline the promotion has to
  // move, and without it a later "Encerrar is visible" would prove nothing:
  // it might have been there all along.
  await expect(guest.locator("[data-watch-party-end]")).toHaveCount(0);
  await expect(guest.locator("[data-watch-party-options-toggle]")).toHaveCount(0);
  await expect(guest.locator("[data-watch-party-claim]")).toHaveCount(0);

  const hostClient = await secondClient(browser);
  let hostOpen = true;
  try {
    const host = hostClient.page;
    await openAs(host, here, "wp-hand-host");
    await host.locator("[data-live-party-row]").first().click();
    await expect(host.getByTestId("watch-party-bar")).toBeVisible({
      timeout: 20_000,
    });

    // THE CONTROL THAT DID NOT EXIST. Opções, which the host already knows
    // from the setup surface, and the co-host list inside it.
    await host.locator("[data-watch-party-options-toggle]").click();
    const cohosts = host.locator("[data-watch-party-cohosts]");
    await expect(cohosts).toBeVisible({ timeout: 20_000 });

    // The host is never offered their own badge, so the guest is the only row.
    await expect(
      cohosts.locator("[data-watch-party-cohost-promote]"),
    ).toHaveCount(1);
    await cohosts
      .locator(`[data-watch-party-cohost-promote="${guestId}"]`)
      .click();

    // The badge landed: the same person is now offered a Remove rather than a
    // Promote, which is the list and the party agreeing.
    await expect(
      cohosts.locator(`[data-watch-party-cohost-demote="${guestId}"]`),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      cohosts.locator("[data-watch-party-cohost-promote]"),
    ).toHaveCount(0);

    // AND IT REACHED THE OTHER BROWSER, on the socket, with nothing reloaded.
    // `watch-party-update` is resolved per recipient, so this is the guest's
    // own client learning its new role: a co-host may end the party, and a
    // viewer may not.
    await expect(guest.locator("[data-watch-party-end]")).toBeVisible({
      timeout: 20_000,
    });

    // THE DROP. Not a stamped column: the host's browser goes away.
    await hostClient.context.close();
    hostOpen = false;
  } finally {
    if (hostOpen) {
      await hostClient.context.close();
    }
  }

  // The audience is NOT cut off, which is the rule the grace window exists
  // for: the party stays live and says in words what is happening.
  await expect(guest.getByTestId("watch-party-host-gone")).toBeVisible({
    timeout: 30_000,
  });
  await expect(guest.getByTestId("watch-party-bar")).toBeVisible();

  const claim = guest.locator("[data-watch-party-claim]");
  await expect(claim).toBeVisible({ timeout: 30_000 });
  await claim.click();

  // The party is theirs. The grace strip goes because the row's
  // `host_disconnected_at` was cleared by the claim, and Assumir goes with it:
  // both are the server's answer, not a local optimism.
  await expect(claim).toHaveCount(0, { timeout: 20_000 });
  await expect(guest.getByTestId("watch-party-host-gone")).toHaveCount(0);
  // And the bar names the new host, so the room can see who is running it.
  await expect(
    guest.getByTestId("watch-party-bar").getByText("with Dev User wp-hand-guest"),
  ).toBeVisible({ timeout: 20_000 });
  // Still live. A takeover is a change of hands, never an end.
  await expect(
    guest.getByTestId("watch-party-bar").getByText("LIVE"),
  ).toBeVisible();
});

test("the three states a real event produces read differently", async ({
  page,
  browser,
}) => {
  const shared = await seedServer("wp-host4", "wp-watcher");
  const here = `/app/server/${shared.serverId}/channel/${shared.textChannelId}`;

  await openAs(page, here, "wp-host4");

  // NOT STARTED YET. A time on the create dialog is the fork in the road: the
  // party is announced rather than private, and the host's pane is a card
  // with a countdown and a way to start early, never a live bar.
  await page.locator("[data-live-party-create]").click();
  await page.locator("[data-create-watch-party-name]").fill("Sessão coruja");
  await page.locator("[data-create-watch-party-schedule]").check();
  await page.locator("[data-create-watch-party-submit]").click();

  await expect(page.getByTestId("watch-party-scheduled")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("Go live now")).toBeVisible();
  await expect(page.getByTestId("watch-party-bar")).toHaveCount(0);
  await expect(page.getByTestId("watch-party-waiting")).toHaveCount(0);
  // A scheduled party is not a live one, so the sidebar has no block. The
  // create button being back in its place is the same fact from the other
  // side, and catches a block that renders for every state.
  await expect(page.getByTestId("live-party-block")).toHaveCount(0);
  await expect(page.locator("[data-live-party-create]")).toBeVisible();

  const second = await secondClient(browser);
  try {
    await openAs(second.page, here, "wp-watcher");
    // The member sees no block either while it is only scheduled. A viewer
    // shown a live badge for a show that has not started leaves before it
    // does.
    await expect(second.page.getByTestId("live-party-block")).toHaveCount(0);

    // LIVE.
    await page.locator("[data-watch-party-go-live]").click();
    await expect(page.getByTestId("watch-party-bar")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("watch-party-scheduled")).toHaveCount(0);
    const block = second.page.getByTestId("live-party-block");
    await expect(block).toBeVisible({ timeout: 20_000 });
    await expect(block.getByText("Sessão coruja")).toBeVisible();

    // ENDED. `live -> ended` is the only move out of live; there is no
    // un-happening a show. The block goes for the member on the socket, and
    // the host's own pane goes back to offering a new one.
    await page.locator("[data-watch-party-end]").click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "End", exact: true })
      .click();

    await expect(second.page.getByTestId("live-party-block")).toHaveCount(0, {
      timeout: 20_000,
    });
    await expect(page.getByTestId("watch-party-bar")).toHaveCount(0, {
      timeout: 20_000,
    });
    await expect(page.locator("[data-live-party-create]")).toBeVisible({
      timeout: 20_000,
    });
    // The member's chat did not go with it: the room is still a room.
    await expect(second.page.getByPlaceholder(/^Message /)).toBeVisible();
  } finally {
    await second.context.close();
  }
});

// ---------------------------------------------- the host's pane, in a browser

/**
 * Every box the layout defects were measured in, in one read.
 *
 * `getBoundingClientRect` is the point: these bugs are about a surface's
 * height DISAGREEING with the pane's, and a class-name assertion cannot see a
 * disagreement. `client/src/components/watch-party/watch-party-panel.test.tsx`
 * pins the classes; this pins the pixels.
 */
async function paneBoxes(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        height: Math.round(rect.height),
        width: Math.round(rect.width),
      };
    };
    return {
      pane: box("[data-call-split]"),
      stagePane: box("[data-call-split-stage]"),
      setup: box('[data-testid="watch-party-setup"]'),
      goLive: box("[data-watch-party-go-live]"),
    };
  });
}

/** Put the chat away from the divider, the way a person does. */
async function hideTheChat(page: Page): Promise<void> {
  const divider = page.getByTestId("call-split-divider");
  await expect(divider).toBeVisible({ timeout: 20_000 });
  const grip = (await divider.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.getByTestId("call-split-collapse-chat").click();
  await expect(page.getByTestId("call-split-restore")).toBeVisible({
    timeout: 20_000,
  });
}

test("the setup surface fills the pane when the chat is put away, and after a reload", async ({
  page,
}) => {
  /**
   * REPORTED FROM PRODUCTION, 12 Sep 2026: "hid the chat and got this bugged
   * UI". Measured here before the fix at 1440x900: the pane handed the stage
   * slot 803px and the setup surface stayed at 612px, its own `68svh` of the
   * WINDOW, leaving Ir ao vivo stranded in mid-screen over a 191px band of
   * empty pane with the restore strip at the bottom of it.
   *
   * BOTH DIRECTIONS ARE ASSERTED, and that is not belt and braces. The
   * existing collapse spec in `call-split-layout.spec.ts` checks
   * `paneHeight - stageHeight <= 24`, which a surface OVERFLOWING its pane
   * passes trivially with a negative number. A surface too short and a
   * surface too tall are the same defect seen from two sides and only one of
   * them was catchable.
   *
   * AND THE RELOAD PATH, because the preference persists: this is the state
   * the app LOADS INTO until the person finds the restore strip, and the
   * collapse is applied from storage before anything has measured itself. A
   * spec that only clicked the control would pass on a build where the
   * restored state is the broken one.
   */
  const shared = await seedServer("wp-collapse");
  const party = await createParty("wp-collapse", shared.serverId, "Cinemoon");
  await openAs(
    page,
    `/app/server/${shared.serverId}/channel/${party.channelId}`,
    "wp-collapse",
  );

  await expect(page.getByTestId("watch-party-setup")).toBeVisible({
    timeout: 20_000,
  });
  const ack = page.getByRole("dialog").filter({ hasText: "Before you go live" });
  if (await ack.isVisible({ timeout: 5000 }).catch(() => false)) {
    await ack.getByRole("button", { name: "Got it", exact: true }).click();
    await expect(ack).toBeHidden({ timeout: 20_000 });
  }

  await hideTheChat(page);
  await expect(page.getByPlaceholder(/^Message /)).toBeHidden();

  const assertItFits = async (when: string) => {
    const boxes = await paneBoxes(page);
    const pane = boxes.pane!;
    const stagePane = boxes.stagePane!;
    const setup = boxes.setup!;
    const goLive = boxes.goLive!;

    // The pane gives the stage slot everything but the restore strip.
    expect(pane.height - stagePane.height, `${when}: pane vs slot`).toBeLessThanOrEqual(24);
    // AND the surface takes what it was given. This is the number that was
    // 612 against 803.
    expect(
      Math.abs(stagePane.height - setup.height),
      `${when}: slot vs surface`,
    ).toBeLessThanOrEqual(2);
    // Nothing runs out of the pane, in either axis.
    expect(setup.bottom, `${when}: surface past the pane`).toBeLessThanOrEqual(
      pane.bottom,
    );
    expect(setup.right, `${when}: surface past the pane`).toBeLessThanOrEqual(
      pane.right + 1,
    );
    // And Go live is inside the window, whole, without scrolling to it.
    expect(goLive.bottom, `${when}: go live below the fold`).toBeLessThanOrEqual(
      page.viewportSize()!.height,
    );
    expect(goLive.top, `${when}: go live above the pane`).toBeGreaterThanOrEqual(
      pane.top,
    );
  };

  await assertItFits("after hiding the chat");

  // F5. The collapse comes back from `localStorage` before the pane, the
  // party or any stage has measured anything.
  await page.reload();
  await expect(page.getByTestId("watch-party-setup")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("call-split-restore")).toBeVisible({
    timeout: 20_000,
  });
  await assertItFits("after a reload");
});

test("a host who has not gone live is told so, in words", async ({ page }) => {
  /**
   * A host on production announced "im live" to a room while the server
   * reported `sharingScreen: 0` and no transcode running. He had picked a
   * window and was looking at his own preview; the only thing saying
   * otherwise was a 10px uppercase badge in the corner of it.
   */
  const shared = await seedServer("wp-notlive");
  const party = await createParty("wp-notlive", shared.serverId, "Cinemoon");
  await openAs(
    page,
    `/app/server/${shared.serverId}/channel/${party.channelId}`,
    "wp-notlive",
  );

  const notLive = page.getByTestId("watch-party-not-live");
  await expect(notLive).toBeVisible({ timeout: 20_000 });
  await expect(notLive.getByText("Not live yet")).toBeVisible();
  // The state and the control that changes it are the same row, so reading
  // one puts the other under the pointer.
  await expect(notLive.locator("[data-watch-party-go-live]")).toBeVisible();

  const ack = page.getByRole("dialog").filter({ hasText: "Before you go live" });
  if (await ack.isVisible({ timeout: 5000 }).catch(() => false)) {
    await ack.getByRole("button", { name: "Got it", exact: true }).click();
    await expect(ack).toBeHidden({ timeout: 20_000 });
  }

  // And it goes the moment it stops being true, which is the half that makes
  // it a state rather than decoration.
  await page.locator("[data-watch-party-go-live]").click();
  await expect(page.getByTestId("watch-party-bar")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("watch-party-not-live")).toHaveCount(0);
});

test("opening the options does not move the picture", async ({ page }) => {
  /**
   * "need to improve this ui. settings is messy. maybe a popup or pulldown
   * menu?" The options were a `shrink-0` block above the split, so opening
   * them pushed the split down by their own height: measured at 1440x900
   * with a live party, a 586px drawer took the pane holding the picture from
   * 735px to 149px. They are a `Dialog` now, which is portalled, so the pane
   * does not move at all.
   */
  const shared = await seedServer("wp-options");
  const party = await createParty("wp-options", shared.serverId, "Cinemoon");
  await setPartyState("wp-options", party.partyId, "live");
  await openAs(
    page,
    `/app/server/${shared.serverId}/channel/${party.channelId}`,
    "wp-options",
  );

  await expect(page.getByTestId("watch-party-bar")).toBeVisible({
    timeout: 20_000,
  });
  const before = (await paneBoxes(page)).pane!;

  await page.locator("[data-watch-party-options-toggle]").click();
  const options = page.getByTestId("watch-party-options-drawer");
  await expect(options).toBeVisible({ timeout: 20_000 });

  const during = (await paneBoxes(page)).pane!;
  expect(during.top, "the pane was pushed down").toBe(before.top);
  expect(during.height, "the pane was squeezed").toBe(before.height);

  // THE LIST IS A SHORTLIST. `cohostCandidates` is the whole membership, and
  // every member used to be drawn with an avatar and a Promote button: 104
  // rows on a 106-member sandbox. Five, and a count for the rest.
  const candidates = options.locator("[data-watch-party-cohost-candidate]");
  expect(await candidates.count()).toBeLessThanOrEqual(5);

  // Escape puts the host back where they were, with nothing having moved.
  await page.keyboard.press("Escape");
  await expect(options).toBeHidden({ timeout: 20_000 });
  const after = (await paneBoxes(page)).pane!;
  expect(after.top).toBe(before.top);
  expect(after.height).toBe(before.height);
});

// ------------------------------------------------- arriving by link, and reloading

/**
 * HOW AN AUDIENCE ACTUALLY ARRIVES, which is not how any other test in this
 * file arrives.
 *
 * Every assertion above reaches the party by clicking the sidebar block. That
 * is one code path (`handleWatchLiveParty`, which refetches the channel list
 * when it does not recognise the id) and it hides a whole class of failure:
 * a room the client cannot resolve from a URL. `applyChannelRoute` looks the
 * id up in `GET /api/servers/:id/channels` and, when it is not there, sets
 * "That channel no longer exists or is private" and lands the person on the
 * first text channel instead. On a link-driven Saturday that is the event.
 *
 * Reported from production web on 12 Sep 2026: opening the room drew "Pick a
 * channel", and a reload redirected to #general with the watch party gone
 * from the sidebar. One cause found and fixed is server side and is pinned in
 * `server/src/services/watch-parties.test.ts` ("makes the room visible to a
 * plain member on a server whose @everyone cannot see channels by default");
 * these two are the client half, so a future regression in the ROUTE is
 * caught here rather than in a browser on the day.
 */
test("a viewer arrives by link, with no sidebar click anywhere", async ({
  browser,
}) => {
  const shared = await seedServer("wp-link", "wp-link-guest");
  const party = await createParty("wp-link", shared.serverId, "Cinemoon");
  await setPartyState("wp-link", party.partyId, "live");

  const second = await secondClient(browser);
  try {
    const viewer = second.page;
    await withFakeLiveStream(viewer, party.channelId);
    // Straight at the room. Nothing is clicked, so nothing can paper over a
    // route that cannot resolve it.
    await openAs(
      viewer,
      `/app/server/${shared.serverId}/channel/${party.channelId}`,
      "wp-link-guest",
    );

    // The URL is still the one they were given: no silent redirect.
    expect(new URL(viewer.url()).pathname).toContain(party.channelId);
    // The party is on screen, not the "pick a channel" empty state.
    await expect(viewer.getByTestId("watch-party-bar")).toBeVisible({
      timeout: 20_000,
    });
    await expect(viewer.getByText("Pick a channel")).toHaveCount(0);
    await expect(viewer.getByTestId("watch-channel-stage")).toBeVisible({
      timeout: 20_000,
    });
    // And the error the fallback path sets on its way past.
    await expect(
      viewer.getByText("no longer exists or is private", { exact: false }),
    ).toHaveCount(0);
  } finally {
    await second.context.close();
  }
});

test("a reload on the party channel stays on it", async ({ browser }) => {
  /**
   * The second half of the same report: after a reload the deep link
   * redirected to #general and the watch party vanished from the sidebar.
   * A reload is a cold boot, so it runs `applyChannelRoute` from nothing,
   * with no client state to fall back on and no click to trigger a refetch.
   */
  const shared = await seedServer("wp-reload", "wp-reload-guest");
  const party = await createParty("wp-reload", shared.serverId, "Cinemoon");
  await setPartyState("wp-reload", party.partyId, "live");

  const second = await secondClient(browser);
  try {
    const viewer = second.page;
    await withFakeLiveStream(viewer, party.channelId);
    await openAs(
      viewer,
      `/app/server/${shared.serverId}/channel/${party.channelId}`,
      "wp-reload-guest",
    );
    await expect(viewer.getByTestId("watch-party-bar")).toBeVisible({
      timeout: 20_000,
    });

    await viewer.reload();

    await expect(viewer.getByTestId("watch-party-bar")).toBeVisible({
      timeout: 20_000,
    });
    expect(
      new URL(viewer.url()).pathname,
      "the reload redirected somewhere else",
    ).toContain(party.channelId);
    await expect(viewer.getByText("Pick a channel")).toHaveCount(0);
    // And the sidebar block is still there, which is the third symptom.
    await expect(viewer.getByTestId("live-party-block")).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    await second.context.close();
  }
});

// --------------------------------------------- what a viewer is offered, and how loudly

/**
 * Every visible control on this page that offers to join the call, with the
 * fill it is painted in.
 *
 * COUNTED RATHER THAN NAMED, because the defect was arithmetic. A viewer with
 * a picture playing was offered the one expensive action three times on one
 * screen: the channel header's Entre na call, the party bar's Entrar na call
 * and a third on the watch stage, two of them in the app's primary green.
 * Three components that did not know about each other, each correct on its
 * own. Only a count across the whole page can see that, which is why this
 * reads the document rather than a locator per component.
 *
 * WHY IT IS NOT COSMETIC. Watching is seatless: one socket, nothing on the
 * media box. Joining takes a seat, a LiveKit participant and forwarded
 * streams, and the measured envelope is roughly 600 interactive users against
 * an effectively unbounded HLS audience. A Saturday of 500 viewers, a modest
 * fraction of them pressing the most prominent thing on screen, is the load
 * the egress exists to avoid, in the first minute.
 */
async function joinOffers(page: Page) {
  return page.evaluate(() => {
    const out: { text: string; bg: string }[] = [];
    document.querySelectorAll("button").forEach((element) => {
      const text = (element.textContent ?? "").trim();
      if (!/\bjoin\b/i.test(text)) {
        return;
      }
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) {
        return;
      }
      out.push({ text, bg: getComputedStyle(element).backgroundColor });
    });
    return out;
  });
}

test("a plain viewer is offered no way into the call, anywhere", async ({
  browser,
}) => {
  /**
   * ZERO, AND ZERO IS THE POINT. Rafael, on being shown one quiet join
   * control where there had been three: "NO. A VIEWER CANT JOIN A WATCH
   * PARTY BRO". Demoting the control and labelling its consequence was still
   * the wrong shape: it kept saying that joining is a thing an audience does,
   * and it still cost every reader the moment it takes to decide against it.
   *
   * A count across the whole document rather than a locator per component,
   * because the defect was arithmetic: three components that did not know
   * about each other, each correct on its own. Only the page can see that.
   *
   * "One" would have been a weak assertion, satisfied by any of the three
   * surviving. Zero cannot be satisfied by accident, so this is what keeps a
   * join from creeping back in through a component nobody was looking at.
   */
  const shared = await seedServer("wp-offer", "wp-offer-guest");
  const party = await createParty("wp-offer", shared.serverId, "Cinemoon");
  await setPartyState("wp-offer", party.partyId, "live");

  const second = await secondClient(browser);
  try {
    const viewer = second.page;
    await withFakeLiveStream(viewer, party.channelId);
    await openAs(
      viewer,
      `/app/server/${shared.serverId}/channel/${party.channelId}`,
      "wp-offer-guest",
    );
    await expect(viewer.getByTestId("watch-channel-stage")).toBeVisible({
      timeout: 20_000,
    });

    const offers = await joinOffers(viewer);
    expect(offers, JSON.stringify(offers)).toHaveLength(0);

    // Named individually as well, so a regression says WHICH surface brought
    // it back rather than only that the count moved.
    await expect(viewer.locator("[data-watch-party-join-call]")).toHaveCount(0);
    await expect(viewer.getByTestId("watch-stage-join")).toHaveCount(0);
    await expect(
      viewer.getByRole("button", { name: "Join Voice", exact: true }),
    ).toHaveCount(0);

    // NOT VACUOUS: the party surfaces this viewer SHOULD have are all there,
    // so a zero above is "no join offered" and not "nothing rendered".
    await expect(viewer.getByTestId("watch-party-bar")).toBeVisible();
    await expect(viewer.getByTestId("watch-stage-state")).toBeVisible();
  } finally {
    await second.context.close();
  }
});

test("the people running the party keep their way into the room", async ({
  page,
}) => {
  /**
   * The other half of the rule, and the half that makes it a rule rather than
   * a blanket removal. A host has to be able to get back into their own room:
   * a browser reload, a dropped call, a co-host arriving after the show
   * started. What changed is who is offered it, not that it exists.
   */
  const shared = await seedServer("wp-host-join");
  const party = await createParty("wp-host-join", shared.serverId, "Cinemoon");
  await setPartyState("wp-host-join", party.partyId, "live");

  await openAs(
    page,
    `/app/server/${shared.serverId}/channel/${party.channelId}`,
    "wp-host-join",
  );
  await expect(page.getByTestId("watch-party-bar")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator("[data-watch-party-join-call]")).toBeVisible();
});

test("a viewer can tell they are watching, and can stop", async ({
  browser,
}) => {
  /**
   * Watching starts by itself when the channel is opened. That is the right
   * default and is not what is being changed: it is the cheap path and the
   * one almost everybody should be on, and putting a click in front of it
   * while prominent buttons offered the expensive one would be exactly
   * backwards. What was missing is that nothing said it was happening and
   * nothing could stop it, so a person could not tell whether they were
   * watching, in the call, both or neither.
   */
  const shared = await seedServer("wp-state", "wp-state-guest");
  const party = await createParty("wp-state", shared.serverId, "Cinemoon");
  await setPartyState("wp-state", party.partyId, "live");

  const second = await secondClient(browser);
  try {
    const viewer = second.page;
    await withFakeLiveStream(viewer, party.channelId);
    await openAs(
      viewer,
      `/app/server/${shared.serverId}/channel/${party.channelId}`,
      "wp-state-guest",
    );

    // WHAT IS TRUE, AND NOT WHAT IS NOT. This row used to be headed
    // "Watching without joining the call", which describes the
    // implementation (a voice room with an HLS audience attached) and frames
    // the thing everybody came for as an abstention. Rafael: "how's that even
    // a thing in watch party lol". A playing film says they are watching; the
    // row says the two things it cannot: how many people, and how far behind.
    const state = viewer.getByTestId("watch-stage-state");
    await expect(state).toBeVisible({ timeout: 20_000 });
    await expect(state).toContainText("watching");
    await expect(viewer.getByTestId("watch-stage")).toContainText("delay");
    await expect(viewer.getByText("without joining the call")).toHaveCount(0);

    // And the way out is beside the statement, which is honest about what
    // stopping is: leaving the room.
    await viewer.getByTestId("watch-stage-leave").click();
    await expect(viewer.getByTestId("watch-channel-stage")).toHaveCount(0, {
      timeout: 20_000,
    });
    // Landed somewhere real rather than on "pick a channel": the party room
    // is never in the sidebar, so leaving it has to go somewhere.
    await expect(viewer.getByPlaceholder(/^Message /)).toBeVisible();
  } finally {
    await second.context.close();
  }
});

test("the film still fills the window on a platform with no element fullscreen", async ({
  browser,
}) => {
  /**
   * THE PATH ELECTRON AND AN IPHONE TAKE, and the one most likely to be
   * shipped broken, because Chromium on a laptop never walks it.
   * `element-fullscreen.ts` exists because an Electron shell can refuse a
   * request without resolving it, rejecting it or firing an event, so a
   * caller that gets `false` back still owes the person a filled viewport.
   * An untested fallback in this repo is the "working and silently not
   * working look identical" trap, so the API is removed from the page and
   * the in-page `expand` is asserted for real.
   */
  const shared = await seedServer("wp-fs2", "wp-fs2-guest");
  const party = await createParty("wp-fs2", shared.serverId, "Cinemoon");
  await setPartyState("wp-fs2", party.partyId, "live");

  const second = await secondClient(browser);
  try {
    const viewer = second.page;
    // Both spellings, before anything boots. A platform that has neither is
    // exactly what `requestElementFullscreen` throws for.
    await viewer.addInitScript(() => {
      // @ts-expect-error deleting a platform API is the point
      delete Element.prototype.requestFullscreen;
      // @ts-expect-error the prefixed spelling too
      delete Element.prototype.webkitRequestFullscreen;
    });
    await withFakeLiveStream(viewer, party.channelId);
    await openAs(
      viewer,
      `/app/server/${shared.serverId}/channel/${party.channelId}`,
      "wp-fs2-guest",
    );
    await expect(viewer.getByTestId("watch-channel-stage")).toBeVisible({
      timeout: 20_000,
    });

    await viewer.getByTestId("watch-stage-fullscreen").click();

    // No element went fullscreen, and the pane covers the window anyway.
    await expect
      .poll(
        () =>
          viewer.evaluate(() => {
            const pane = document.querySelector<HTMLElement>(
              "[data-call-split]",
            );
            return pane?.hasAttribute("data-watch-expanded") ?? false;
          }),
        { timeout: 15_000 },
      )
      .toBe(true);
    const filled = await viewer.evaluate(() => {
      const pane = document.querySelector<HTMLElement>("[data-call-split]")!;
      const film = document.querySelector<HTMLElement>(
        "[data-testid='watch-stage'] video",
      );
      const chat = document.querySelector<HTMLElement>(
        "[data-call-split-chat]",
      );
      const rect = pane.getBoundingClientRect();
      const filmRect = film?.getBoundingClientRect();
      return {
        fullscreenElement: document.fullscreenElement !== null,
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        height: Math.round(rect.height),
        width: Math.round(rect.width),
        viewport: { w: window.innerWidth, h: window.innerHeight },
        cinema: pane.hasAttribute("data-watch-cinema"),
        filmWidth: filmRect ? Math.round(filmRect.width) : 0,
        chatDisplay: chat ? getComputedStyle(chat).display : "missing",
      };
    });
    expect(filled.fullscreenElement).toBe(false);
    expect(filled.top).toBe(0);
    expect(filled.left).toBe(0);
    expect(filled.height).toBe(filled.viewport.h);
    expect(filled.width).toBe(filled.viewport.w);
    expect(filled.cinema).toBe(true);
    expect(filled.filmWidth).toBe(filled.viewport.w);
    expect(filled.chatDisplay).toBe("none");

    // AND ESCAPE WORKS HERE TOO. In element fullscreen the browser owns it
    // and never tells the page; in this mode nothing does, so the hook binds
    // it. A full-window layout whose only exit is a control somebody has to
    // find is the state this is meant to avoid being stuck in.
    await viewer.keyboard.press("Escape");
    await expect
      .poll(() =>
        viewer.evaluate(
          () =>
            document
              .querySelector("[data-call-split]")
              ?.hasAttribute("data-watch-expanded") ?? false,
        ),
      )
      .toBe(false);
  } finally {
    await second.context.close();
  }
});

test("a viewer can put the film on the whole screen", async ({
  browser,
}) => {
  /**
   * "i dont think i can make it full screen as a viewer", and he could not:
   * the player had a fit toggle, a quality menu, a volume slider and
   * Picture-in-Picture, and no fullscreen control at all. A watch party is a
   * film and people watch films fullscreen for two hours.
   *
   * NATIVE FULLSCREEN, PICTURE FIRST. The request still goes to the split
   * pane so a hover overlay can show the existing transcript, but cinema
   * layout means the film fills the screen and chat does not own a column.
   * A composer that still takes a third of the monitor is the bug this
   * asserts against.
   */
  const shared = await seedServer("wp-fs", "wp-fs-guest");
  const party = await createParty("wp-fs", shared.serverId, "Cinemoon");
  await setPartyState("wp-fs", party.partyId, "live");

  const second = await secondClient(browser);
  try {
    const viewer = second.page;
    await withFakeLiveStream(viewer, party.channelId);
    await openAs(
      viewer,
      `/app/server/${shared.serverId}/channel/${party.channelId}`,
      "wp-fs-guest",
    );
    await expect(viewer.getByTestId("watch-channel-stage")).toBeVisible({
      timeout: 20_000,
    });

    const control = viewer.getByTestId("watch-stage-fullscreen");
    await expect(control).toBeVisible();
    await control.click();

    await expect
      .poll(
        () =>
          viewer.evaluate(
            () =>
              document.fullscreenElement?.hasAttribute("data-call-split") ??
              false,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);

    const box = await viewer.evaluate(() => {
      const pane = document.querySelector<HTMLElement>("[data-call-split]")!;
      const stage = document.querySelector<HTMLElement>(
        "[data-testid='watch-stage']",
      )!;
      const film = stage.querySelector("video")!;
      const chat = document.querySelector<HTMLElement>(
        "[data-call-split-chat]",
      );
      const paneRect = pane.getBoundingClientRect();
      const filmRect = film.getBoundingClientRect();
      const chatRect = chat?.getBoundingClientRect();
      const chatVisible =
        !!chat &&
        getComputedStyle(chat).display !== "none" &&
        (chatRect?.width ?? 0) > 8 &&
        (chatRect?.height ?? 0) > 8;
      return {
        paneHeight: Math.round(paneRect.height),
        viewportHeight: window.innerHeight,
        filmWidth: Math.round(filmRect.width),
        viewportWidth: window.innerWidth,
        cinema: pane.hasAttribute("data-watch-cinema"),
        chatVisible,
      };
    });
    expect(box.paneHeight).toBe(box.viewportHeight);
    expect(box.cinema).toBe(true);
    expect(box.filmWidth).toBe(box.viewportWidth);
    expect(box.chatVisible, "chat must not own a column of the film").toBe(
      false,
    );

    const overlay = viewer.getByTestId("watch-stage-chat-overlay");
    await expect(overlay).toBeVisible();
    await overlay.click();
    const withChat = await viewer.evaluate(() => {
      const film = document.querySelector<HTMLElement>(
        "[data-testid='watch-stage'] video",
      )!;
      const chat = document.querySelector<HTMLElement>(
        "[data-call-split-chat]",
      )!;
      const exit = document.querySelector<HTMLElement>(
        "[data-testid='watch-stage-fullscreen']",
      );
      const filmRect = film.getBoundingClientRect();
      const chatRect = chat.getBoundingClientRect();
      const exitRect = exit?.getBoundingClientRect();
      const hit =
        exitRect &&
        document.elementFromPoint(
          exitRect.left + exitRect.width / 2,
          exitRect.top + exitRect.height / 2,
        );
      return {
        filmWidth: Math.round(filmRect.width),
        viewportWidth: window.innerWidth,
        chatVisible:
          getComputedStyle(chat).display !== "none" && chatRect.width > 8,
        chatOverlapsFilm:
          chatRect.left < filmRect.right && chatRect.right > filmRect.left,
        exitHitsControl: !!exit && !!hit && exit.contains(hit),
      };
    });
    expect(withChat.filmWidth).toBe(withChat.viewportWidth);
    expect(withChat.chatVisible).toBe(true);
    expect(withChat.chatOverlapsFilm).toBe(true);
    expect(
      withChat.exitHitsControl,
      "chat overlay must not cover Leave fullscreen",
    ).toBe(true);

    await expect(control).toHaveAttribute("aria-pressed", "true");
    await viewer.getByTestId("watch-stage").hover();
    await control.click({ timeout: 10_000 });
    await expect
      .poll(() =>
        viewer.evaluate(() => document.fullscreenElement !== null),
      )
      .toBe(false);
  } finally {
    await second.context.close();
  }
});

test("a party has no voice until the host turns it on, and the audience follows on the socket", async ({
  page,
  browser,
}) => {
  /**
   * THE MODEL, END TO END, THROUGH THE ONE CONTROL THAT SETS IT.
   *
   * A watch party has no voice by default: the audience is seatless, the
   * transcode carries no microphone, and a room of five hundred with open
   * microphones is not a watch party. The rest of this file proves the
   * DEFAULT (`a plain viewer is offered no way into the call, anywhere`), and
   * every one of those assertions is now resting on it. What is missing is
   * the other half: that a host can turn voice ON, that it is one click, and
   * that the audience finds out without reloading anything.
   *
   * TWO REAL ACCOUNTS AND NO RELOAD BETWEEN THE HALVES. The guest's client
   * boots once and stays up, so an appearing control is the socket
   * (`watch-party-update`) carrying an options change to a running page. A
   * test that reloaded in the middle would pass with no broadcast at all,
   * which is the failure this repo keeps shipping.
   *
   * THE CONTROL IS THE PRODUCT ARGUMENT. Six friends watching a film want to
   * talk over it and get there in one click, exactly what it cost before this
   * change; five hundred people watching a presentation pay zero clicks for
   * the thing they want. That is why it is one select and not a switch plus a
   * stage picker.
   */
  const shared = await seedServer("wp-voz-host", "wp-voz-guest");
  const party = await createParty("wp-voz-host", shared.serverId, "Cinemoon");
  await setPartyState("wp-voz-host", party.partyId, "live");
  const room = `/app/server/${shared.serverId}/channel/${party.channelId}`;

  const guest = page;
  await openAs(guest, room, "wp-voz-guest");
  await expect(guest.getByTestId("watch-party-bar")).toBeVisible({
    timeout: 20_000,
  });
  // The default, from the guest's side: nothing offers a seat, anywhere on
  // the page. Same count as `a plain viewer is offered no way into the call`,
  // restated here because it is the baseline the two flips below have to
  // move, and without it an appearing control proves nothing.
  expect(await joinOffers(guest)).toHaveLength(0);
  await expect(guest.locator("[data-watch-party-join-call]")).toHaveCount(0);

  const hostClient = await secondClient(browser);
  try {
    const host = hostClient.page;
    await openAs(host, room, "wp-voz-host");
    await host.locator("[data-watch-party-options-toggle]").click();
    await expect(host.getByTestId("watch-party-options-drawer")).toBeVisible({
      timeout: 20_000,
    });

    // OFF IS WHAT THE HOST SEES, on a party they created with no options at
    // all. The select carries the server's answer, so this is the stored
    // default read back through the API rather than a client constant.
    const voice = host.locator("[data-watch-party-voice]");
    await expect(voice).toHaveValue("off");
    // And the stage machinery is not drawn under it: a queue for a party
    // nobody can speak in is a control with nothing behind it.
    await expect(host.locator("[data-watch-party-raise-hand]")).toHaveCount(0);

    // ONE CLICK. The film night.
    await voice.selectOption("everyone");

    // THE GUEST'S PAGE HAS NOT RELOADED. This appearing is the PATCH, the
    // broadcast and the affordance, in a client that was already open.
    await expect(guest.locator("[data-watch-party-join-call]")).toHaveCount(1, {
      timeout: 20_000,
    });

    // And back off again, which is the path that also has to lift whatever
    // the party wrote on the channel (`watch-party-options.test.ts` owns that
    // half; this owns the affordance following it).
    await voice.selectOption("off");
    await expect(guest.locator("[data-watch-party-join-call]")).toHaveCount(0, {
      timeout: 20_000,
    });
    expect(await joinOffers(guest)).toHaveLength(0);

    // The stage mode was remembered rather than reset, so a host who changes
    // their mind twice does not have to pick the floor again.
    await expect(voice).toHaveValue("off");
    await voice.selectOption("everyone");
    await expect(voice).toHaveValue("everyone");
  } finally {
    await hostClient.context.close();
  }
});
