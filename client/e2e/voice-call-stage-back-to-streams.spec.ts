import { expect, test, type Page } from "@playwright/test";
import { ensureServer, leaveVoiceIfConnected, openApp, waitUntilVoiceConnected } from "./fixtures";

/**
 * Picking one stream and clicking away from it, with no obvious way back.
 *
 * Reported verbatim, pt-BR, a 3-star call rating: after joining a voice
 * channel, picking one of several streams and clicking away from it, "it is
 * very counter-intuitive (even obscure) how to get back to the streams".
 *
 * A tile click on a stage with two or more pictures blows the tile up alone
 * on the stage (`tileClickFullscreens`), in real browser fullscreen wherever
 * Chromium offers it. The browser already owned Escape there, and the corner
 * icon already called the right handler — the gap was that neither was
 * discoverable: an unlabeled icon that only reveals on hover, and no keyboard
 * hint at all outside real fullscreen.
 *
 * Two tiles, one real second participant: they publish BOTH a camera and a
 * screen share, which is two pictures on the stage without a third live peer.
 * A third camera in one mesh room hits `meshCameraLimit` and the SFU
 * promotion it asks for (refused locally with no LiveKit configured), which
 * is a real product rule and not what this spec is about — see
 * `packages/shared/src/voice-backend.ts`.
 *
 * The watching page has the Fullscreen API deleted before anything boots
 * (the same trick `watch-party.spec.ts` uses for its own "Escape works in
 * `expand` too" case): the stage's `useStageFullscreen` then resolves to the
 * in-page `expand` fallback deterministically, which is the path a CDP-
 * dispatched Escape key cannot be trusted to exit on its own — Chromium's
 * built-in "Escape leaves real fullscreen" behaviour is not reliably
 * reproducible from a synthetic key event, so proving Escape works here
 * means proving OUR OWN listener does, on the mode that has no help from
 * the platform.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const SUFFIX = "backtostreams2";

function headersFor(suffix?: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${suffix ? `${DEV_TOKEN}:${suffix}` : DEV_TOKEN}`,
  };
}

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      // getDisplayMedia otherwise blocks on a picker no headless run can answer.
      "--auto-select-desktop-capture-source=Entire screen",
      "--auto-accept-this-tab-capture",
    ],
  },
  permissions: ["microphone", "camera"],
  viewport: { width: 1440, height: 900 },
});

test.setTimeout(90_000);

/** Age gate, onboarding and server membership for the second participant. */
async function materialiseMember(inviteCode: string): Promise<void> {
  const headers = headersFor(SUFFIX);
  const me = await fetch(`${API}/api/me`, { headers });
  const body = (await me.json()) as { ageGate?: string };
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
    body: JSON.stringify({ onboardedAt: new Date().toISOString() }),
  });
  await fetch(`${API}/api/invites/${inviteCode}/join`, {
    method: "POST",
    headers,
  });
}

/** The lobby voice channel, and an invite the second participant can redeem. */
async function seedRoom(): Promise<{ inviteCode: string }> {
  await ensureServer();
  const headers = headersFor();
  const list = await fetch(`${API}/api/servers`, { headers });
  const { servers } = (await list.json()) as { servers: { id: string }[] };
  const serverId = servers[0]!.id;
  const channelsRes = await fetch(`${API}/api/servers/${serverId}/channels`, {
    headers,
  });
  const { channels } = (await channelsRes.json()) as {
    channels: { name: string; type: string }[];
  };
  if (!channels.some((c) => c.type === "voice" && c.name.toLowerCase() === "lobby")) {
    await fetch(`${API}/api/servers/${serverId}/channels`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "lobby", type: "voice" }),
    });
  }
  const invite = await fetch(`${API}/api/servers/${serverId}/invites`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  const { invite: created } = (await invite.json()) as {
    invite: { code: string };
  };
  return { inviteCode: created.code };
}

async function openWithSuffix(target: Page): Promise<void> {
  await target.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, SUFFIX);
  await target.goto("/app?lang=en");
  await expect(target.getByText("Dev auth bypass")).toBeVisible({
    timeout: 20_000,
  });
  await expect(target.getByRole("button", { name: "Send" })).toBeVisible({
    timeout: 20_000,
  });
}

async function joinLobby(target: Page): Promise<void> {
  await target.getByRole("button", { name: /lobby/i }).first().dblclick();
  await expect(target.getByTestId("call-stage-collapsed")).toBeVisible({
    timeout: 20_000,
  });
  await waitUntilVoiceConnected(target);
}

test("focusing one stream and clicking away comes back in one click", async ({
  page,
  browser,
}) => {
  const { inviteCode } = await seedRoom();
  await materialiseMember(inviteCode);

  const context = await browser.newContext({
    permissions: ["microphone", "camera"],
    viewport: { width: 1440, height: 900 },
  });
  const second = await context.newPage();
  try {
    // Forces `useStageFullscreen` onto the in-page `expand` fallback (see
    // the file header), so Escape below exercises this fix's own listener
    // rather than hoping Chromium's native Escape survives a synthetic key.
    await page.addInitScript(() => {
      // @ts-expect-error deleting a platform API is the point
      delete Element.prototype.requestFullscreen;
      // @ts-expect-error the prefixed spelling too
      delete Element.prototype.webkitRequestFullscreen;
    });
    // The watching account never publishes anything itself, so its stage is
    // a plain two-tile grid rather than one tile plus its own floating
    // preview (`stage-layout.ts`'s `selfPreview`).
    await openApp(page);
    await openWithSuffix(second);

    await joinLobby(page);
    await joinLobby(second);

    // Two pictures from one real peer: a camera and a screen share, which
    // is two stage tiles without a third live participant.
    await second
      .getByRole("main")
      .getByRole("button", { name: "Turn camera on", exact: true })
      .click();
    await second.getByRole("button", { name: "Share your screen" }).click();
    await expect(page.getByText(/is presenting/)).toBeVisible({
      timeout: 30_000,
    });

    const stageGrid = page.getByTestId("stage-grid");
    await expect(stageGrid).toBeVisible({ timeout: 20_000 });
    await expect(stageGrid.locator("video")).toHaveCount(2, {
      timeout: 20_000,
    });
    // Nothing focused yet: the persistent control has nothing to do.
    await expect(page.getByTestId("stage-show-all-streams")).toHaveCount(0);

    // Pick one stream: a click on either tile focuses it alone.
    await stageGrid.getByTestId("tile-click-target").first().click();
    await expect(page.getByTestId("stage-grid")).toHaveCount(0);
    await expect(page.locator("video")).toHaveCount(1);

    // The labelled, persistent way back — not an icon alone, not hidden
    // behind hover, drawn every time one picture is alone on the stage.
    const backControl = page.getByTestId("stage-show-all-streams");
    await expect(backControl).toBeVisible();
    await expect(backControl).toHaveText("Show all streams");

    await backControl.click();
    await expect(page.getByTestId("stage-grid")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("stage-grid").locator("video")).toHaveCount(
      2,
    );

    // Escape gets back to the grid too, from whichever tile was picked.
    await page
      .getByTestId("stage-grid")
      .getByTestId("tile-click-target")
      .last()
      .click();
    await expect(page.getByTestId("stage-show-all-streams")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("stage-grid")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("stage-grid").locator("video")).toHaveCount(
      2,
    );
    await expect(page.getByTestId("stage-show-all-streams")).toHaveCount(0);
  } finally {
    await leaveVoiceIfConnected(page).catch(() => {});
    await leaveVoiceIfConnected(second).catch(() => {});
    await context.close().catch(() => {});
  }
});
