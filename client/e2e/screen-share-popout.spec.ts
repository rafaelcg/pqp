import { expect, test, type Browser, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";

/**
 * THE SHARE POPOUT (issue 1736), with two real clients in a DM call.
 *
 * With `share_popout` on (the global answer, which is what a DM call reads):
 *
 *  - a share that starts arrives as an "Assistir" chip in the call's bar, with
 *    no video bound and no popout;
 *  - pressing it opens the popout over the conversation area, rendering
 *    frames, while the chat keeps the pane (the stage stays folded);
 *  - the popout stays on screen, same <video>, when the viewer walks to
 *    another conversation;
 *  - closing it sends the share back to "Assistir";
 *  - maximizing from another conversation goes back to the call's and opens
 *    the theater (the stage, with nothing floating over it); Escape returns
 *    to the popout.
 *
 * The flag is turned on the way the operator does it and handed back after.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--auto-select-desktop-capture-source=Entire screen",
      "--auto-accept-this-tab-capture",
    ],
  },
  permissions: ["microphone", "camera"],
  // Wide enough for the popout (`lg`).
  viewport: { width: 1280, height: 800 },
});

test.setTimeout(120_000);

function headersFor(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

async function materialiseAccount(suffix: string) {
  const headers = headersFor(suffix);
  const me = await fetch(`${API}/api/me`, { headers });
  const body = (await me.json()) as { id: string; displayName: string; ageGate?: string };
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
  await fetch(`${API}/api/me`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ dmPrivacy: "everyone" }),
  });
  return body;
}

async function openDm(fromSuffix: string, toUserId: string): Promise<string> {
  const opened = await fetch(`${API}/api/dms`, {
    method: "POST",
    headers: headersFor(fromSuffix),
    body: JSON.stringify({ userIds: [toUserId] }),
  });
  const { conversation } = (await opened.json()) as { conversation: { channelId: string } };
  return conversation.channelId;
}

async function setSharePopoutFlag(enabled: boolean | null): Promise<void> {
  const res = await fetch(`${API}/api/admin/flags`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${E2E_ADMIN_TOKEN}` },
    body: JSON.stringify({ key: "share_popout", enabled }),
  });
  expect(res.status).toBe(200);
}

async function openConversation(page: Page, conversationId: string, suffix: string) {
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(`/app/dm/${conversationId}`);
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 20_000 });
}

async function openViewer(browser: Browser, conversationId: string, suffix: string) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
  });
  await context.grantPermissions(["microphone", "camera"]);
  const page = await context.newPage();
  await openConversation(page, conversationId, suffix);
  return { context, page };
}

test.afterAll(async () => {
  await setSharePopoutFlag(null);
});

test("a share waits for Assistir, plays in the popout, and follows the viewer", async ({
  page,
  browser,
}) => {
  await setSharePopoutFlag(true);
  const presenter = await materialiseAccount("popout-a");
  const viewerAccount = await materialiseAccount("popout-b");
  const other = await materialiseAccount("popout-c");
  const callDm = await openDm("popout-a", viewerAccount.id);
  const otherDm = await openDm("popout-b", other.id);

  const viewer = await openViewer(browser, callDm, "popout-b");
  try {
    await openConversation(page, callDm, "popout-a");
    await page.getByRole("button", { name: "Start voice call", exact: true }).click();
    await viewer.page.getByRole("button", { name: "Accept" }).click({ timeout: 20_000 });

    await page.getByRole("button", { name: "Share your screen", exact: true }).click();
    await expect(page.getByText("You are presenting")).toBeVisible({ timeout: 20_000 });

    // The share arrives as an invitation, not a picture.
    const chip = viewer.page.locator("[data-share-invite]");
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await expect(chip).toContainText(presenter.displayName);
    await expect(viewer.page.getByTestId("share-popout")).toHaveCount(0);

    await chip.getByRole("button").click();
    const popout = viewer.page.getByTestId("share-popout");
    await expect(popout).toBeVisible({ timeout: 20_000 });
    const video = popout.locator("video");
    await expect
      .poll(() => video.evaluate((el) => (el as HTMLVideoElement).videoWidth > 0), {
        timeout: 30_000,
      })
      .toBe(true);
    // The chip is gone, and the chat keeps the pane: no expanded stage.
    await expect(viewer.page.locator("[data-share-invite]")).toHaveCount(0);
    await expect(
      viewer.page.locator('[data-testid="call-stage"] video.object-contain'),
    ).toHaveCount(0);

    // The popout sits inside the conversation area, above the composer.
    const box = await popout.boundingBox();
    const composer = await viewer.page.locator("[data-chat-composer]").boundingBox();
    expect(box && composer && box.y + box.height <= composer.y + 1).toBe(true);

    // Walk to another conversation: same popout, same <video>, still playing.
    await video.evaluate((el) => {
      (el as HTMLVideoElement & { __popoutMarker?: boolean }).__popoutMarker = true;
    });
    await viewer.page.evaluate((id) => {
      window.history.pushState({}, "", `/app/dm/${id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, otherDm);
    await expect(viewer.page).toHaveURL(new RegExp(`/app/dm/${otherDm}`));
    await expect(viewer.page.getByTestId("share-popout-call")).toBeEnabled({ timeout: 20_000 });
    await expect(popout).toBeVisible();
    expect(
      await popout
        .locator("video")
        .evaluate((el) => (el as HTMLVideoElement & { __popoutMarker?: boolean }).__popoutMarker === true),
    ).toBe(true);

    // Closing it sends the share back to Assistir.
    await popout.hover();
    await viewer.page.getByTestId("share-popout-close").click();
    await expect(viewer.page.getByTestId("share-popout")).toHaveCount(0);
    await viewer.page.getByTestId("share-popout-call").count();
    await viewer.page.evaluate((id) => {
      window.history.pushState({}, "", `/app/dm/${id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, callDm);
    await expect(viewer.page.locator("[data-share-invite]")).toBeVisible({ timeout: 20_000 });

    // THE THEATER. Watch again, walk away, and maximize from there: back in
    // the call's DM, the stage takes the conversation area with the share on
    // it, and nothing floats over it.
    await viewer.page.locator("[data-share-invite]").getByRole("button").click();
    await expect(viewer.page.getByTestId("share-popout")).toBeVisible({ timeout: 20_000 });
    await viewer.page.evaluate((id) => {
      window.history.pushState({}, "", `/app/dm/${id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, otherDm);
    await expect(viewer.page.getByTestId("share-popout-call")).toBeEnabled({ timeout: 20_000 });
    await viewer.page.getByTestId("share-popout").hover();
    await viewer.page.getByTestId("share-popout-maximize").click();
    await expect(viewer.page).toHaveURL(new RegExp(`/app/dm/${callDm}`), { timeout: 20_000 });
    const stageShare = viewer.page.locator('[data-testid="call-stage"] video.object-contain');
    await expect(stageShare).toBeVisible({ timeout: 20_000 });
    await expect(viewer.page.getByTestId("share-popout")).toHaveCount(0);
    await expect(viewer.page.getByTestId("stage-minimize-to-popout")).toBeVisible();

    // Escape goes back to the popout.
    await viewer.page.locator("body").click({ position: { x: 5, y: 5 } });
    await viewer.page.keyboard.press("Escape");
    await expect(viewer.page.getByTestId("share-popout")).toBeVisible({ timeout: 20_000 });
    await expect(stageShare).toHaveCount(0);
  } finally {
    await viewer.context.close();
  }
});
