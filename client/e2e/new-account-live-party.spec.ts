import { expect, test, type Page } from "@playwright/test";

/**
 * A brand-new account that arrives from a community's link while a watch
 * party is on air lands ON the party.
 *
 * WHY THIS EXISTS. MoonKase's party on 2026-09-26: 93 accounts were created
 * mid-show from `pqp.gg/c/moonkase`. They watched a median of 4 minutes
 * against 90 for everybody else. Every newcomer session that reached the
 * party went through the server's Overview first (median 45 s to find it),
 * the wizard offered them "create your own server" (7 did, and were moved
 * into it), and the Overview's start cards pointed at `#general` and the
 * voice lobby. This walks the same journey a person does, from the public
 * page's button, and pins the three things that changed:
 *
 *  1. the first run has the invite's shape (the room named, no "sala" doors);
 *  2. entering it opens the live party, not the Overview;
 *  3. no arrival strip sits over the film.
 *
 * WHAT IS STUBBED is exactly what `watch-party.spec.ts` stubs and for the same
 * reason: CI has no egress, so the `stream` of the live frame and a playlist
 * are substituted. The party row, its state, the community, the join and the
 * onboarding are all real.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

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

/** A listed community with a live party in it, through the real routes. */
async function communityWithLiveParty(
  hostSuffix: string,
): Promise<{ slug: string; channelId: string }> {
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
  return { slug, channelId: party.channelId };
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

for (const shape of ["desktop", "phone"] as const) {
  test(`a new account from a community link mid-show lands on the live party (${shape})`, async ({
    browser,
  }) => {
    const host = suffixFor(`lph-${shape}`);
    const newcomer = suffixFor(`lpn-${shape}`);
    const { slug, channelId } = await communityWithLiveParty(host);
    await freshAccount(newcomer);

    const context = await browser.newContext(
      shape === "phone"
        ? {
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
            colorScheme: "dark",
          }
        : { viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
    );
    const page = await context.newPage();
    try {
      await withFakeLiveStream(page, channelId);
      await page.addInitScript((value) => {
        localStorage.setItem("pqp:dev-user-suffix", value);
        // `?watchParty=1` persisted, as production's build flag is on.
        localStorage.setItem("pqp:watch-party-channels", "1");
      }, newcomer);

      // The public page and its button, the way a stream's viewer arrives.
      await page.goto(`/c/${slug}?lang=en`);
      await page.locator('a[href*="join="]').first().click();

      // The first run names the room waiting for them and offers no doors
      // to a server of their own.
      await expect(page.locator("[data-onboarding-arrival]")).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.locator('[data-onboarding-step="room"]')).toHaveCount(0);
      await page.locator("[data-onboarding-primary]").click();
      await expect(page.locator('[data-onboarding-step="room"]')).toHaveCount(0);

      // And they are on the party, not the Overview.
      await expect(page).toHaveURL(new RegExp(`/channel/${channelId}`), {
        timeout: 20_000,
      });
      await expect(page.getByTestId("watch-party-bar").first()).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByTestId("watch-channel-stage")).toBeVisible({
        timeout: 20_000,
      });
      // No "pick a channel on the left" strip over the film.
      await expect(page.locator("[data-arrival-banner]")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
}
