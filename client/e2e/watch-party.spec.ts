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
 * WHAT IS STUBBED, AND WHERE THE LINE IS. CI has no LiveKit and no egress, so
 * no HLS playlist can exist. Exactly one field is substituted, in
 * `withFakeLiveStream`: the `stream` of a `channel-live` frame and of
 * `GET /api/channels/:id/live`, both of which are otherwise the real server's
 * real answers on the real socket. Nothing else is faked: the party rows, the
 * permissions, the broadcast, the seat and the roster are all genuine. The one
 * test that uses it (`a seated viewer does not get the player twice`) keeps
 * the substitution CONSTANT across both halves and moves only the seat, so it
 * cannot pass by the stub failing to arrive: the picture has to appear, then
 * go when the seat is taken, then come back when it is given up.
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

/**
 * Open the app as one of the two accounts, with the watch party flag on.
 *
 * `?watchParty=1` is the whole point: without it every watch party assertion
 * below would be looking at chrome the build never rendered.
 */
async function openAs(page: Page, path: string, suffix: string): Promise<void> {
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

test("a seated viewer does not get the player twice", async ({ browser }) => {
  const shared = await seedServer("wp-host3", "wp-seat");
  const here = `/app/server/${shared.serverId}/channel/${shared.textChannelId}`;

  const party = await createParty("wp-host3", shared.serverId, "Cinemoon 3");
  await setPartyState("wp-host3", party.partyId, "live");

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

    // Now take the seat. The presenter's screen arrives as a WebRTC track
    // with its own audio, so the HLS player must go: the same film twice,
    // seconds apart, with both soundtracks, is the bug.
    await viewer.getByTestId("watch-stage-join").click();
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
