import { expect, test } from "@playwright/test";
import { ensureServer, openApp } from "./fixtures";

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${DEV_TOKEN}`,
};

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
  permissions: ["microphone"],
  trace: "off",
});

async function ensureVoiceChannel(): Promise<void> {
  await ensureServer();
  const res = await fetch(`${API}/api/servers`, { headers });
  const { servers } = (await res.json()) as { servers: { id: string }[] };
  const serverId = servers[0]!.id;
  const list = await fetch(`${API}/api/servers/${serverId}/channels`, {
    headers,
  });
  const { channels } = (await list.json()) as {
    channels: { name: string; type: string }[];
  };
  // Exact name, because every test below finds the channel with the
  // case-sensitive `/lobby/`. A case-insensitive check let the server's own
  // "Lobby" count as present, so on a fresh database nothing made "lobby"
  // and every dblclick waited out the test timeout (push-to-talk.spec.ts
  // already matches exactly).
  if (channels.some((c) => c.type === "voice" && c.name === "lobby")) {
    return;
  }
  await fetch(`${API}/api/servers/${serverId}/channels`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "lobby", type: "voice" }),
  });
}

test.describe("voice lobby", () => {
  test.beforeEach(async () => {
    await ensureVoiceChannel();
  });

  test("desktop: voice-only is a slim bar, not a participant column", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page);
    await page.getByRole("button", { name: /lobby/ }).first().dblclick();
    await expect(page.getByTestId("call-stage-collapsed")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("call-stage")).toHaveCount(0);

    const leave = page.getByRole("main").getByRole("button", { name: "Leave", exact: true });
    await expect(leave).toBeInViewport();
    // The dock's Leave is one way out. The sidebar card keeps its own red
    // hang-up, camera and share beside it, so both are on screen at once.
    await expect(
      page.getByRole("button", { name: "Disconnect from voice" }),
    ).toBeVisible();
    // Mute is in two places on purpose: the user panel, and the bar, where a
    // phone (whose panel is behind the drawer) can reach it. Deafen stays in
    // the panel alone.
    const bar = page.getByTestId("call-stage-collapsed");
    await expect(
      page.getByRole("button", { name: "Mute microphone" }),
    ).toHaveCount(2);
    await expect(
      bar.getByRole("button", { name: "Mute microphone" }),
    ).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Deafen" })).toHaveCount(1);

    // The bar is docked in the composer: inside the message form, under the
    // transcript, and the dock has finished opening. Still a bar's worth of
    // height, one row of 36px tiles.
    const dock = page.locator("[data-call-dock]");
    await expect(dock).toHaveAttribute("data-state", "open");
    const barBox = (await bar.boundingBox())!;
    expect(barBox.height).toBeLessThanOrEqual(80);
    const form = page.getByRole("main").locator("form").filter({ has: bar });
    await expect(form.locator("textarea")).toBeVisible();
    const formBox = (await form.boundingBox())!;
    expect(barBox.y).toBeGreaterThanOrEqual(formBox.y);
    const pane = (await page.locator("[data-call-split-chat]").boundingBox())!;
    expect(barBox.y).toBeGreaterThan(pane.y + pane.height / 2);
    // Nothing is left where the strip used to be, above the transcript.
    const stagePane = page.locator("[data-call-split-stage]");
    if ((await stagePane.count()) > 0) {
      expect((await stagePane.boundingBox())?.height ?? 0).toBeLessThan(2);
    }

    // The sidebar card keeps its camera button (and share, where the platform
    // can share a screen) under its status even with the composer's call bar
    // on screen, as Discord's Voice Connected panel does.
    await expect(
      page
        .locator("[data-voice-status-bar]")
        .getByRole("button", { name: "Turn camera on", exact: true }),
    ).toBeVisible();

    await expect(
      bar.getByRole("button", { name: "Mute microphone" }),
    ).toBeEnabled();
  });

  test("desktop: double-clicking a voice channel joins without the idle button", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page);
    await page.getByRole("button", { name: /lobby/ }).first().dblclick();
    await expect(page.getByTestId("call-stage-collapsed")).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByRole("button", { name: "Join Voice" }),
    ).toHaveCount(0);
  });

  test("phone: no empty band above the chat", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page);
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: /lobby/ }).first().dblclick();
    await expect(page.getByTestId("call-stage-collapsed")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("call-stage")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Leave", exact: true })).toBeInViewport();
  });

  test.describe("at the mesh ceiling", () => {
    test("eight voice-only peers keep the slim bar, not a tile grid", async ({
      page,
      browser,
    }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 1440, height: 900 });
      await openApp(page);
      await page.getByRole("button", { name: /lobby/ }).first().dblclick();
      await expect(page.getByTestId("call-stage-collapsed")).toBeVisible({
        timeout: 20_000,
      });

      const extras = [];
      for (let i = 0; i < 7; i++) {
        const context = await browser.newContext({
          permissions: ["microphone"],
        });
        const other = await context.newPage();
        await other.goto("/app");
        await other.getByRole("button", { name: /lobby/ }).first().dblclick();
        extras.push(context);
      }

      try {
        await expect(page.getByTestId("call-stage")).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "Leave", exact: true }),
        ).toBeInViewport();

        await page.setViewportSize({ width: 390, height: 844 });
        await expect(
          page.getByRole("button", { name: "Leave", exact: true }),
        ).toBeInViewport();
      } finally {
        for (const context of extras) {
          await context.close().catch(() => {});
        }
      }
    });
  });

  test("no getDisplayMedia: the control degrades quietly", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      Reflect.deleteProperty(MediaDevices.prototype, "getDisplayMedia");
    });
    await openApp(page);
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: /lobby/ }).first().dblclick();
    await expect(page.getByTestId("call-stage-collapsed")).toBeVisible({
      timeout: 20_000,
    });

    await expect(page.getByRole("alert")).toHaveCount(0);
    const share = page.getByRole("button", {
      name: /Share your screen \(unavailable/,
    });
    await expect(share).toBeVisible();
    // `force` because the button is `aria-disabled` (it stays focusable so it
    // can explain itself), and Playwright treats that as disabled and would
    // wait forever. But `force` also skips the checks that the button has
    // stopped moving and is the thing under the pointer, and it is neither
    // when the bar first shows: the dock opens by growing its row, and for
    // about 100 ms the share tile slides up from y 807 to y 713 on this
    // viewport. A click aimed at its box in that window landed on the
    // composer's toolbar or its textarea, so no hint ever appeared (seen on
    // main CI, and 14 of 15 locally). Waiting until a tap at the tile's centre
    // reaches the tile is exactly the check `force` skipped.
    await expect
      .poll(() =>
        share.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(
            r.x + r.width / 2,
            r.y + r.height / 2,
          );
          return hit !== null && el.contains(hit);
        }),
      )
      .toBe(true);
    await share.click({ force: true });
    await expect(
      page.getByText("Screen sharing isn't supported by this browser."),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});
