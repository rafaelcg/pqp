import { expect, test } from "@playwright/test";
import { openApp } from "./fixtures";

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${DEV_TOKEN}`,
};

// A real join needs a microphone; the fake device makes that deterministic and
// silent.
test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
  permissions: ["microphone"],
  // The mesh test drives eight browsers at once; tracing all of them races the
  // artifact writer and fails the run on an unrelated ENOENT. Screenshots on
  // failure stay on, and every assertion here is plain geometry anyway.
  trace: "off",
});

async function ensureVoiceChannel(): Promise<void> {
  const res = await fetch(`${API}/api/servers`, { headers });
  const { servers } = (await res.json()) as { servers: { id: string }[] };
  const serverId = servers[0]!.id;
  const list = await fetch(`${API}/api/servers/${serverId}/channels`, {
    headers,
  });
  const { channels } = (await list.json()) as {
    channels: { name: string; type: string }[];
  };
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

  test("desktop: the column is filled by the participant grid", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page);
    await page.getByRole("button", { name: /lobby/ }).first().click();
    await page.getByRole("button", { name: "Join Voice" }).click();
    await expect(page.getByText("Live")).toBeVisible({ timeout: 20_000 });

    // The controls are docked at the foot of the column, not floating in the
    // middle of it, and the grid sits between them and the header.
    const grid = page.locator("ul.grid").first();
    const leave = page.getByRole("button", { name: "Leave" });
    await expect(grid).toBeVisible();
    await expect(leave).toBeInViewport();
    const gridBox = (await grid.boundingBox())!;
    const leaveBox = (await leave.boundingBox())!;
    expect(gridBox.y + gridBox.height).toBeLessThan(leaveBox.y);
    // A call of one gets a stage, not a stray card: `min-h-[14rem]` at `lg`.
    // The loose 160px floor this used to assert was a workaround for
    // `resetPreferences` only resetting the theme — a spec that turned on
    // "compact peers" shrank every tile for whatever ran next. The fixture
    // resets the whole preference set now, so the real number can be pinned.
    expect(gridBox.height).toBeGreaterThanOrEqual(200);
  });

  test("phone: the same layout at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page);
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: /lobby/ }).first().click();
    await page.getByRole("button", { name: "Join Voice" }).click();
    await expect(page.getByText("Live")).toBeVisible({ timeout: 20_000 });

    // 390px is the narrowest phone worth caring about: the whole panel — tile,
    // controls and all — has to fit the short band above the chat.
    await expect(page.locator("ul.grid > li")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Leave" })).toBeInViewport();
    await expect(
      // Scoped to `main`: the user panel in the sidebar has a mute button too.
      page.getByRole("main").getByRole("button", { name: "Mute microphone" }),
    ).toBeInViewport();
  });

  test.describe("at the mesh ceiling", () => {
    test("scales to eight without pushing the controls off screen", async ({
      page,
      browser,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openApp(page);
      await page.getByRole("button", { name: /lobby/ }).first().click();
      await page.getByRole("button", { name: "Join Voice" }).click();
      await expect(page.getByText("Live")).toBeVisible({ timeout: 20_000 });

      // Seven more peers: the mesh ceiling, and the worst case for the grid.
      const extras = [];
      for (let i = 0; i < 7; i++) {
        const context = await browser.newContext({
          permissions: ["microphone"],
        });
        const other = await context.newPage();
        await other.goto("/app");
        await other.getByRole("button", { name: /lobby/ }).first().click();
        await other.getByRole("button", { name: "Join Voice" }).click();
        extras.push(context);
      }

      try {
        const tiles = page.locator("ul.grid > li");
        await expect(tiles).toHaveCount(8, { timeout: 30_000 });
        // The control bar stays docked; the grid scrolls instead of pushing it
        // below the fold.
        await expect(
          page.getByRole("button", { name: "Leave" }),
        ).toBeInViewport();

        await page.setViewportSize({ width: 390, height: 844 });
        await expect(
          page.getByRole("button", { name: "Leave" }),
        ).toBeInViewport();
      } finally {
        for (const context of extras) {
          // A context whose pages already went away can no longer be closed;
          // that is teardown noise, not a result.
          await context.close().catch(() => {});
        }
      }
    });
  });

  test("no getDisplayMedia: the control degrades quietly", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      // iOS Safari shape: mediaDevices exists, getDisplayMedia does not.
      Reflect.deleteProperty(MediaDevices.prototype, "getDisplayMedia");
    });
    await openApp(page);
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: /lobby/ }).first().click();
    await page.getByRole("button", { name: "Join Voice" }).click();
    await expect(page.getByText("Live")).toBeVisible({ timeout: 20_000 });

    await expect(page.getByRole("alert")).toHaveCount(0);
    const share = page.getByRole("button", {
      name: /Share your screen \(unavailable/,
    });
    await expect(share).toBeVisible();
    // `force` because the button is aria-disabled: browsers still deliver the
    // tap (that is the point — it is how a phone user asks why), but
    // Playwright's actionability check refuses on its own.
    await share.click({ force: true });
    await expect(
      page.getByText("Screen sharing isn't supported by this browser."),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});
