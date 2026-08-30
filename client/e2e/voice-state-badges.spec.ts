import { expect, test } from "@playwright/test";
import { openApp } from "./fixtures";

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${DEV_TOKEN}`,
};

/**
 * Voice state visibility, end to end: one browser mutes inside the call, and a
 * *different* browser — not in the call at all — sees the mic-off badge on the
 * channel-list occupant row. This is the exact gap the roster's muted/deafened
 * fields exist to close, and nothing below the UI is mocked: the badge only
 * appears if the `set-voice-state` frame, the roster fan-out and the occupant
 * row all hold hands.
 */

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
  permissions: ["microphone"],
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

test.describe("voice state badges", () => {
  test.beforeEach(async () => {
    await ensureVoiceChannel();
  });

  test("a mute in one browser shows in another browser's channel list", async ({
    page,
    browser,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page);
    await page.getByRole("button", { name: /lobby/ }).first().click();
    await page.getByRole("button", { name: "Join Voice" }).click();
    await expect(page.getByTestId("call-stage-collapsed")).toBeVisible({ timeout: 20_000 });

    // The observer is a separate browser context that never joins voice.
    const context = await browser.newContext();
    const observer = await context.newPage();
    try {
      await observer.setViewportSize({ width: 1440, height: 900 });
      await observer.goto("/app");
      await expect(observer.getByText("Dev auth bypass")).toBeVisible({
        timeout: 20_000,
      });

      // The occupant row exists before any mute — and carries no mute badge.
      const occupants = observer.locator("aside ul li");
      await expect(occupants.first()).toBeVisible({ timeout: 20_000 });
      await expect(observer.getByLabel("Muted")).toHaveCount(0);

      // The participant mutes; the observer's sidebar badge follows.
      await page.getByRole("button", { name: "Mute microphone" }).click();
      await expect(observer.getByLabel("Muted")).toBeVisible({
        timeout: 10_000,
      });

      // Deafen replaces it — one badge, the stronger one.
      await page.getByRole("button", { name: "Deafen" }).click();
      await expect(observer.getByLabel("Deafened")).toBeVisible({
        timeout: 10_000,
      });
      await expect(observer.getByLabel("Muted")).toHaveCount(0);

      // And clearing it clears the badge rather than leaving it stuck.
      await page.getByRole("button", { name: "Undeafen" }).click();
      await expect(observer.getByLabel("Deafened")).toHaveCount(0, {
        timeout: 10_000,
      });
    } finally {
      await context.close().catch(() => {});
    }
  });
});
