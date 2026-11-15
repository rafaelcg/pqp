import { expect, test, type Page } from "@playwright/test";

/**
 * `party_newcomer_experience`: a runtime flag, per server, that changes what a
 * stranger sees in the first minutes of a live watch party.
 *
 * WHY THIS EXISTS. Accounts created during MoonKase's party on 2026-09-26
 * stayed a median of 4 minutes; 65% were on phones, where the viewer saw the
 * film and none of the room (a 72px rail, the stage at 68% of the height, the
 * chat a sliver). This pins, through the real routes and the real flag:
 *
 *  1. flag OFF (the default): nothing changes, the rail is there, no strip;
 *  2. flag ON for that server: on a 390x844 phone the rail is put away and the
 *     chat keeps a usable height under the picture, and a new account gets a
 *     one-line "what is this" strip whose dismissal is remembered;
 *  3. flag ON on a laptop: the strip is there and the get-the-app strip is not.
 *
 * The flip is `PUT /api/admin/flag-overrides` with the suite's machine token,
 * the same call the dashboard makes. The stream is stubbed exactly as
 * `new-account-live-party.spec.ts` stubs it; the party, its state, the join
 * and the onboarding are real.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const WS_URL = API.replace("http", "ws") + "/ws";
const DEV_TOKEN = "dev-local-token";
/** `ADMIN_METRICS_TOKEN` of the suite's server, see `playwright.config.ts`. */
const ADMIN_TOKEN = "e2e-admin-token-0123456789abcdef";

test.setTimeout(120_000);

function headersFor(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

function suffixFor(name: string): string {
  return `${name}-${Date.now().toString(36)}`.toLowerCase().slice(0, 32);
}

/** Past the age gate, still owing the wizard: exactly a fresh sign-up. */
async function freshAccount(suffix: string): Promise<void> {
  const headers = headersFor(suffix);
  await fetch(`${API}/api/me`, { headers });
  await fetch(`${API}/api/me/age-check`, {
    method: "POST",
    headers,
    body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
  });
}

async function onboardedAccount(suffix: string): Promise<void> {
  await freshAccount(suffix);
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers: headersFor(suffix),
    body: JSON.stringify({
      onboardedAt: new Date().toISOString(),
      firstRunDismissedAt: new Date().toISOString(),
    }),
  });
}

async function communityWithLiveParty(
  hostSuffix: string,
): Promise<{ slug: string; channelId: string; serverId: string }> {
  await onboardedAccount(hostSuffix);
  const headers = headersFor(hostSuffix);
  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: `Sessao ${Date.now()}` }),
  });
  const { server } = (await created.json()) as { server: { id: string } };
  const slug = `sessao-${Date.now().toString(36)}`;
  const patched = await fetch(`${API}/api/servers/${server.id}/community`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      isCommunity: true,
      isListed: true,
      category: "games",
      tagline: "filme",
      slug,
    }),
  });
  if (!patched.ok) {
    throw new Error(`could not make it a community: ${patched.status}`);
  }
  const partyRes = await fetch(`${API}/api/servers/${server.id}/watch-parties`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Filme" }),
  });
  if (!partyRes.ok) {
    throw new Error(`could not create the party: ${partyRes.status}`);
  }
  const { party } = (await partyRes.json()) as {
    party: { id: string; channelId: string };
  };
  const live = await fetch(`${API}/api/watch-parties/${party.id}/state`, {
    method: "POST",
    headers,
    body: JSON.stringify({ state: "live" }),
  });
  if (!live.ok) {
    throw new Error(`could not go live: ${live.status}`);
  }
  return { slug, channelId: party.channelId, serverId: server.id };
}

async function setFlag(serverId: string, enabled: boolean | null) {
  const res = await fetch(`${API}/api/admin/flag-overrides`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify({ key: "party_newcomer_experience", serverId, enabled }),
  });
  expect(res.status).toBe(200);
}

/** Sending is a WebSocket frame; there is no HTTP route for a person. */
async function say(suffix: string, channelId: string, count: number) {
  const socket = new WebSocket(WS_URL);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("ws error")));
  });
  const ready = new Promise<void>((resolve) => {
    socket.addEventListener("message", (event) => {
      if ((JSON.parse(String(event.data)) as { type: string }).type === "ready") {
        resolve();
      }
    });
  });
  socket.send(JSON.stringify({ type: "auth", token: `${DEV_TOKEN}:${suffix}` }));
  await ready;
  for (let i = 0; i < count; i += 1) {
    socket.send(
      JSON.stringify({ type: "message-create", channelId, body: `oi gente ${i}` }),
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  socket.close();
}

/** See `withFakeLiveStream` in `watch-party.spec.ts`. */
async function withFakeLiveStream(page: Page, channelId: string): Promise<void> {
  const stream = {
    hlsUrl: `/api/voice/hls-playlist/${channelId}/e2e-session?t=e2e`,
    startedAt: Date.now(),
    presenterPeerId: "e2e-presenter",
    delaySeconds: 8,
  };
  await page.route("**/api/live-hls/config*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, enabled: true } });
  });
  await page.route(`**/api/channels/${channelId}/live`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, stream } });
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
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (typeof message === "string") {
        try {
          const frame = JSON.parse(message) as Record<string, unknown>;
          if (frame.type === "channel-live" && frame.channelId === channelId) {
            ws.send(JSON.stringify({ ...frame, stream }));
            return;
          }
        } catch {
          // Not ours.
        }
      }
      ws.send(message);
    });
  });
}

async function arriveOnTheParty(
  page: Page,
  slug: string,
  newcomer: string,
  channelId: string,
) {
  await withFakeLiveStream(page, channelId);
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
    localStorage.setItem("pqp:watch-party-channels", "1");
  }, newcomer);
  await page.goto(`/c/${slug}?lang=en`);
  await page.locator('a[href*="join="]').first().click();
  await expect(page.locator("[data-onboarding-arrival]")).toBeVisible({
    timeout: 20_000,
  });
  await page.locator("[data-onboarding-primary]").click();
  await expect(page.getByTestId("watch-channel-stage")).toBeVisible({
    timeout: 20_000,
  });
}

const PHONE = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  colorScheme: "dark" as const,
};
const LAPTOP = {
  viewport: { width: 1366, height: 768 },
  colorScheme: "dark" as const,
};

test("flag off: a phone viewer of a live party sees exactly what it always did", async ({
  browser,
}) => {
  const { slug, channelId } = await communityWithLiveParty(suffixFor("nx-off-h"));
  const newcomer = suffixFor("nx-off-n");
  await freshAccount(newcomer);
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  try {
    await arriveOnTheParty(page, slug, newcomer, channelId);
    await expect(page.locator("[data-party-newcomer-strip]")).toHaveCount(0);
    await expect(page.locator("[data-rail-phone-hidden]")).toHaveCount(0);
    await expect(page.locator("[data-call-split-phone-floor]")).toHaveCount(0);
    const rail = await page.locator("nav[data-immersive-hide]").first().boundingBox();
    expect(rail?.width).toBe(72);
  } finally {
    await context.close();
  }
});

test("flag on for the server: a phone newcomer gets the room, and the strip remembers", async ({
  browser,
}) => {
  const host = suffixFor("nx-on-h");
  const { slug, channelId, serverId } = await communityWithLiveParty(host);
  await say(host, channelId, 20);
  await setFlag(serverId, true);
  const newcomer = suffixFor("nx-on-n");
  await freshAccount(newcomer);
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  try {
    await arriveOnTheParty(page, slug, newcomer, channelId);

    // The rail is out of the flow: the party has the whole width.
    await expect(page.locator("[data-rail-phone-hidden]")).toBeHidden();
    // The chat has a usable height under the picture, composer included.
    const pane = page.locator("[data-call-split-phone-floor]");
    await expect(pane).toHaveCount(1);
    const chat = await page.locator("[data-call-split-chat]").boundingBox();
    expect(chat?.height ?? 0).toBeGreaterThanOrEqual(220);
    const composer = page.getByPlaceholder(/./).last();
    await expect(composer).toBeInViewport();

    // What is this, once, and closing it sticks across a reload.
    const strip = page.locator("[data-party-newcomer-strip]");
    await expect(strip).toBeVisible();
    await expect(strip).toContainText("Live watch party");
    await expect(strip).toContainText("right below");
    await page.locator("[data-party-newcomer-dismiss]").click();
    await expect(strip).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("watch-channel-stage")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator("[data-party-newcomer-strip]")).toHaveCount(0);

    // The hamburger brings the rail back over the page.
    await page.getByRole("button", { name: "Open navigation" }).click();
    const rail = page.locator("nav[data-rail-phone-hidden]");
    await expect(rail).toBeVisible();
    expect((await rail.boundingBox())?.x).toBe(0);
  } finally {
    await context.close();
  }
});

test("flag on: a laptop newcomer gets the strip and no get-the-app invite, a regular keeps it", async ({
  browser,
}) => {
  const host = suffixFor("nx-lap-h");
  const { slug, channelId, serverId } = await communityWithLiveParty(host);
  await setFlag(serverId, true);
  const newcomer = suffixFor("nx-lap-n");
  await freshAccount(newcomer);
  const context = await browser.newContext(LAPTOP);
  const page = await context.newPage();
  try {
    await arriveOnTheParty(page, slug, newcomer, channelId);
    const strip = page.locator("[data-party-newcomer-strip]");
    await expect(strip).toBeVisible();
    await expect(strip).toContainText("on the right");
    await expect(page.getByText("Get the app")).toHaveCount(0);
  } finally {
    await context.close();
  }

  // The same party, an account that finished first-run long ago: no strip,
  // and the invite it has always had.
  const regular = suffixFor("nx-lap-r");
  await onboardedAccount(regular);
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers: headersFor(regular),
    body: JSON.stringify({
      onboardedAt: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(),
    }),
  });
  const joined = await fetch(`${API}/api/communities/${serverId}/join`, {
    method: "POST",
    headers: headersFor(regular),
  });
  expect(joined.status).toBeLessThan(300);
  const second = await browser.newContext(LAPTOP);
  const other = await second.newPage();
  try {
    await withFakeLiveStream(other, channelId);
    await other.addInitScript((value) => {
      localStorage.setItem("pqp:dev-user-suffix", value);
      localStorage.setItem("pqp:watch-party-channels", "1");
    }, regular);
    await other.goto(`/app/server/${serverId}/channel/${channelId}`);
    await expect(other.getByTestId("watch-channel-stage")).toBeVisible({
      timeout: 20_000,
    });
    await expect(other.locator("[data-party-newcomer-strip]")).toHaveCount(0);
    await expect(other.getByText("Get the app")).toBeVisible();
  } finally {
    await second.close();
  }
});
