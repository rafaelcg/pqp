import { expect, test, type Page } from "@playwright/test";
import {
  ensureServer,
  leaveVoiceIfConnected,
  openApp,
  waitUntilVoiceConnected,
} from "./fixtures";

/**
 * "Leave my mouse out of what I share", end to end.
 *
 * THE REPORT (QG, 5 Sep 2026): a film shared from one window while the person
 * played a game in another, and the pointer drawn over the film every time it
 * moved. Two claims are worth a real browser rather than a unit test:
 *
 *  1. The preference is REMEMBERED. It is the whole difference between this
 *     and the system-audio toggle beside it, which is session state on
 *     purpose, and a store that quietly forgets across a reload would look
 *     identical in every unit test and wrong every night to the person it is
 *     for.
 *  2. The app TELLS THE TRUTH when it could not keep the promise. No shipping
 *     engine implements the Screen Capture `cursor` constraint (measured, see
 *     `src/lib/screen-capture-cursor.ts`), so a whole-screen share here really
 *     does carry the pointer, and the presenter has to be told so rather than
 *     left believing a green button.
 *
 * Chromium is the only engine in this suite and it is the one that cannot
 * honour the constraint, which makes it exactly the right witness for (2).
 */

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      // getDisplayMedia otherwise blocks on a picker no headless run can
      // answer. "Entire screen" is also what makes the surface a monitor,
      // which is the case the warning is about.
      "--auto-select-desktop-capture-source=Entire screen",
      "--auto-accept-this-tab-capture",
    ],
  },
  permissions: ["microphone"],
  trace: "off",
});

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const headers = {
  "Content-Type": "application/json",
  Authorization: "Bearer dev-local-token",
};

async function ensureVoiceChannel(): Promise<void> {
  // The first server has to exist before it can be given a channel, and on a
  // fresh database nothing has made one yet.
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
  if (channels.some((c) => c.type === "voice" && c.name === "lobby")) {
    return;
  }
  await fetch(`${API}/api/servers/${serverId}/channels`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "lobby", type: "voice" }),
  });
}

async function joinLobby(page: Page): Promise<void> {
  await page.getByRole("button", { name: /lobby/ }).first().dblclick();
  await expect(page.getByTestId("call-stage-collapsed")).toBeVisible({
    timeout: 20_000,
  });
  await waitUntilVoiceConnected(page);
}

const storedPreference = (page: Page) =>
  page.evaluate(() => localStorage.getItem("pqp:share-cursor"));

test("the cursor preference is remembered across a reload", async ({
  page,
}) => {
  await ensureVoiceChannel();
  await openApp(page);
  await joinLobby(page);

  const toggle = page.getByTestId("share-cursor-toggle");
  // Shown, because presenting is the default and the person has to be able to
  // find the thing that changes it.
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(await storedPreference(page)).toBe("hide");

  await leaveVoiceIfConnected(page);
  await page.reload();
  await joinLobby(page);

  // The claim: still hidden, without being re-armed. A session-only store
  // would come back "false" here and pass every unit test on the way.
  await expect(page.getByTestId("share-cursor-toggle")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await leaveVoiceIfConnected(page);
});

test("a screen share says so when it carries the cursor anyway", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await ensureVoiceChannel();
  await openApp(page);
  await joinLobby(page);

  await page.getByTestId("share-cursor-toggle").click();
  await page.getByRole("button", { name: "Share your screen" }).click();
  await expect(page.getByText("You are presenting")).toBeVisible({
    timeout: 20_000,
  });

  // Chromium composites the pointer into every screen and window capture with
  // no route to it from the page, so this line is the honest half of the
  // control: it names the surface that does not carry one.
  await expect(page.getByText(/Your mouse goes out with a screen/)).toBeVisible(
    { timeout: 10_000 },
  );
  await leaveVoiceIfConnected(page);
});

test("a share nobody asked to hide the cursor on says nothing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await ensureVoiceChannel();
  await openApp(page);
  await joinLobby(page);

  // Presenting: the pointer is the content. A warning on every share anybody
  // ever starts is how a true warning gets trained into background noise.
  await expect(page.getByTestId("share-cursor-toggle")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.getByRole("button", { name: "Share your screen" }).click();
  await expect(page.getByText("You are presenting")).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.getByText(/Your mouse goes out with a screen/),
  ).toHaveCount(0);
  await leaveVoiceIfConnected(page);
});
