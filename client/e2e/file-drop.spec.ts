import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureServer, openApp, waitUntilVoiceConnected } from "./fixtures";

/**
 * FILES DROPPED ON THE APP, from the operating system.
 *
 * Every drop here is a real one. `Input.dispatchDragEvent` is the protocol
 * command DevTools uses to simulate the OS handing the browser a file, so the
 * page sees the same `dragenter` / `dragover` / `drop` sequence, with the same
 * `DataTransfer` (a real `File`, a real `webkitGetAsEntry()` that says whether
 * it is a folder) it would get from Finder or Explorer. A `DataTransfer` built
 * inside the page cannot do that: its items have no entries, so the folder case
 * cannot be told apart from a file and would pass for the wrong reason.
 *
 * STORAGE. Attachments are off on a server with no `S3_*` (docs/ATTACHMENTS.md),
 * and CI has none, so the attachment config is stubbed to "on" for every test
 * here: what is under test is which surface takes a drop and what it does with
 * the files, and a staged chip (or a refusal) is the same with or without a
 * bucket behind it. The one test that needs the bytes to land is skipped
 * unless the API under test really has storage:
 *   docker compose --profile storage up -d minio minio-init
 *   S3_ENDPOINT=http://localhost:9000 S3_BUCKET=pqp-attachments \
 *   S3_ACCESS_KEY_ID=pqpminio S3_SECRET_ACCESS_KEY=pqpminio-dev-secret \
 *   S3_FORCE_PATH_STYLE=true pnpm --filter @pqp/client e2e file-drop
 *
 * Set `E2E_SHOT_DIR` to also write a screenshot of each overlay.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${DEV_TOKEN}`,
};
const SHOT_DIR = process.env.E2E_SHOT_DIR;

test.use({
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
  permissions: ["microphone"],
});
test.setTimeout(90_000);

test.beforeEach(async ({ page }) => {
  await page.route("**/api/attachments/config", (route) =>
    route.fulfill({ json: { enabled: true, maxBytes: 10 * 1024 * 1024 } }),
  );
});

/** A 1x1 PNG, which is all an attachment needs to be a real image. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function fixtureDir(testInfo: { outputPath: (...p: string[]) => string }): string {
  const dir = testInfo.outputPath("files");
  mkdirSync(path.join(dir, "a-folder"), { recursive: true });
  writeFileSync(path.join(dir, "a-folder", "inside.png"), PNG);
  return dir;
}

function makePng(dir: string, name: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, PNG);
  return file;
}

/**
 * Hand the browser files the way the OS does: enter, hover, (optionally look),
 * drop. `onHover` runs while the drag is over the target, which is when the
 * overlay is up.
 */
async function osDrop(
  page: Page,
  target: Locator,
  files: string[],
  onHover?: () => Promise<void>,
): Promise<void> {
  // A drag is aimed at pixels, so the target has to be on screen first.
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) {
    throw new Error("drop target has no box");
  }
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [], files, dragOperationsMask: 1 };
  await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", x, y, data });
  await cdp.send("Input.dispatchDragEvent", { type: "dragOver", x, y, data });
  await onHover?.();
  await cdp.send("Input.dispatchDragEvent", { type: "drop", x, y, data });
  await cdp.detach();
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOT_DIR) {
    // Past the overlay's 0.28s fade-in, or the picture is of nothing yet.
    await page.waitForTimeout(450);
    mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
  }
}

/**
 * Records, AFTER the page's own listeners have run, whether each file drag was
 * claimed. An unclaimed drop is the one a browser answers by navigating to the
 * file (and the desktop shell by trying to), so `claimed` is what "never leaves
 * the app" means at the level a test can see.
 */
async function recordDrags(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __drags: { type: string; claimed: boolean }[] };
    w.__drags = [];
    for (const type of ["dragover", "drop"]) {
      window.addEventListener(type, (event) => {
        if ([...(event as DragEvent).dataTransfer!.types].includes("Files")) {
          w.__drags.push({ type, claimed: event.defaultPrevented });
        }
      });
    }
  });
}

function drags(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __drags: { type: string; claimed: boolean }[] })
        .__drags,
  );
}

const overlay = (page: Page) => page.locator("[data-file-drop-overlay]");
const chips = (page: Page) =>
  page.getByRole("list", { name: "Attachments" }).getByRole("listitem");

async function ensureChannel(name: string, type: "text" | "voice"): Promise<void> {
  await ensureServer();
  const res = await fetch(`${API}/api/servers`, { headers });
  const { servers } = (await res.json()) as { servers: { id: string }[] };
  const serverId = servers[0]!.id;
  const list = await fetch(`${API}/api/servers/${serverId}/channels`, { headers });
  const { channels } = (await list.json()) as {
    channels: { name: string; type: string }[];
  };
  if (!channels.some((c) => c.type === type && c.name === name)) {
    await fetch(`${API}/api/servers/${serverId}/channels`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name, type }),
    });
  }
}

/** The pane every chat surface drops into: the main column. */
const pane = (page: Page) => page.getByRole("main");

test.describe("dropping files", () => {
  test("a server text channel takes a drop, shows the overlay, and stages the file", async ({
    page,
  }, testInfo) => {
    const dir = fixtureDir(testInfo);
    await openApp(page);
    await recordDrags(page);

    await osDrop(page, pane(page), [makePng(dir, "screenshot.png")], async () => {
      await expect(overlay(page)).toHaveAttribute("data-file-drop-overlay", "accept");
      await expect(overlay(page)).toContainText("Drop to attach");
      // Decorative: the attach button stays the accessible path.
      await expect(overlay(page)).toHaveAttribute("aria-hidden", "true");
      await shot(page, "text-channel-overlay");
    });

    await expect(chips(page)).toHaveCount(1);
    await expect(chips(page).first()).toContainText("screenshot.png");
    await expect(overlay(page)).toHaveCount(0);
    await shot(page, "text-channel-dropped");
    expect((await drags(page)).every((d) => d.claimed)).toBe(true);
  });

  test("a VOICE channel takes a drop while you are only looking at it", async ({
    page,
  }, testInfo) => {
    const dir = fixtureDir(testInfo);
    await ensureChannel("lobby", "voice");
    await openApp(page);
    // One click opens the channel's page; a double click would join it.
    await page.getByRole("button", { name: /lobby/ }).first().click();
    // Viewing, not joined: the header offers "Join Voice" and there is no stage.
    await expect(page.getByRole("button", { name: "Join Voice" })).toBeVisible();
    await expect(page.getByTestId("call-stage-collapsed")).toHaveCount(0);

    await osDrop(page, pane(page), [makePng(dir, "from-voice.png")], async () => {
      await expect(overlay(page)).toHaveAttribute("data-file-drop-overlay", "accept");
      await shot(page, "voice-viewing-overlay");
    });

    await expect(chips(page)).toHaveCount(1);
    await expect(chips(page).first()).toContainText("from-voice.png");
    await shot(page, "voice-viewing-dropped");
  });

  test("a VOICE channel takes a drop while you are IN the call", async ({
    page,
  }, testInfo) => {
    const dir = fixtureDir(testInfo);
    await ensureChannel("lobby", "voice");
    await openApp(page);
    await page.getByRole("button", { name: /lobby/ }).first().dblclick();
    await expect(page.getByTestId("call-stage-collapsed")).toBeVisible({
      timeout: 20_000,
    });
    await waitUntilVoiceConnected(page);
    await recordDrags(page);

    // Over the call stage itself, not over the transcript: the stage is the
    // biggest thing on screen and the one people aim at.
    await osDrop(
      page,
      page.getByTestId("call-stage-collapsed"),
      [makePng(dir, "in-call.png")],
      async () => {
        await expect(overlay(page)).toHaveAttribute("data-file-drop-overlay", "accept");
        await shot(page, "voice-in-call-overlay");
      },
    );

    await expect(chips(page)).toHaveCount(1);
    await expect(chips(page).first()).toContainText("in-call.png");
    await shot(page, "voice-in-call-dropped");
    expect((await drags(page)).every((d) => d.claimed)).toBe(true);
    await page.getByRole("button", { name: "Leave", exact: true }).first().click();
  });

  test("a drop ONTO the stage video attaches to the call's chat and never navigates", async ({
    page,
  }, testInfo) => {
    const dir = fixtureDir(testInfo);
    await ensureChannel("lobby", "voice");
    await openApp(page);
    await page.getByRole("button", { name: /lobby/ }).first().dblclick();
    await expect(page.getByTestId("call-stage-collapsed")).toBeVisible({
      timeout: 20_000,
    });
    await waitUntilVoiceConnected(page);
    await page
      .getByRole("main")
      .getByRole("button", { name: "Turn camera on", exact: true })
      .click();
    await expect(page.getByTestId("call-stage")).toBeVisible({ timeout: 20_000 });
    await recordDrags(page);

    // Aimed at the <video> itself: the element a browser would otherwise
    // treat as a file handler of its own.
    const video = page.locator('[aria-label="Your camera"]').first();
    await osDrop(page, video, [makePng(dir, "onto-the-video.png")], async () => {
      await expect(overlay(page)).toHaveAttribute("data-file-drop-overlay", "accept");
      await shot(page, "voice-stage-video-overlay");
    });
    await expect(chips(page)).toHaveCount(1);
    await expect(chips(page).first()).toContainText("onto-the-video.png");
    expect((await drags(page)).every((d) => d.claimed)).toBe(true);
    expect(page.url()).toContain("/app");
    await page.getByRole("button", { name: "Leave", exact: true }).first().click();
  });

  test("a watch party's stage is not a drop zone, and the drop is still claimed", async ({
    page,
  }, testInfo) => {
    const dir = fixtureDir(testInfo);
    await ensureServer();
    // A server of its own, so the party does not leak into the shared one. The
    // room a party creates is a hidden `watch_party` channel until it is live.
    const made = await fetch(`${API}/api/servers`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `Drop ${Date.now()}` }),
    });
    const { server } = (await made.json()) as { server: { id: string } };
    const party = await fetch(`${API}/api/servers/${server.id}/watch-parties`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Cinemoon" }),
    });
    const { party: created } = (await party.json()) as {
      party: { id: string; channelId: string };
    };
    await fetch(`${API}/api/watch-parties/${created.id}/state`, {
      method: "POST",
      headers,
      body: JSON.stringify({ state: "live" }),
    });
    // The create control and the party chrome follow the operator's answer, and
    // a runner's API says no; the same substitution watch-party.spec.ts makes.
    await page.route("**/api/live-hls/config*", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, enabled: true } });
    });
    await page.goto(
      `/app/server/${server.id}/channel/${created.channelId}?lang=en&watchParty=1`,
    );
    await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByPlaceholder(/^Message /)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("watch-party-bar")).toBeVisible({ timeout: 20_000 });
    await recordDrags(page);

    // Stream chat has no attach control by design, so a drop zone over the
    // film would be the only door to one. It must still not open the file.
    await osDrop(page, pane(page), [makePng(dir, "onto-the-film.png")], async () => {
      await expect(overlay(page)).toHaveCount(0);
    });
    await expect(chips(page)).toHaveCount(0);
    const seen = await drags(page);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((d) => d.claimed)).toBe(true);
  });

  test("a thread's panel takes its own drop, and the parent channel does not", async ({
    page,
  }, testInfo) => {
    const dir = fixtureDir(testInfo);
    await openApp(page);
    const body = `thread root ${Date.now()}`;
    await page.getByPlaceholder(/^Message /).fill(body);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(body).first()).toBeVisible();

    // Start the thread through the API: the menu path is another spec's job.
    const servers = (await (await fetch(`${API}/api/servers`, { headers })).json()) as {
      servers: { id: string }[];
    };
    const chans = (await (
      await fetch(`${API}/api/servers/${servers.servers[0]!.id}/channels`, { headers })
    ).json()) as { channels: { id: string; name: string; type: string }[] };
    const general = chans.channels.find((c) => c.type === "text")!;
    const msgs = (await (
      await fetch(`${API}/api/channels/${general.id}/messages`, { headers })
    ).json()) as { messages: { id: string; body: string }[] };
    const root = msgs.messages.find((m) => m.body === body)!;
    await fetch(`${API}/api/messages/${root.id}/threads`, { method: "POST", headers });

    await page.reload();
    await page.getByRole("button", { name: /Open thread|1 repl|thread/i }).first().click();
    const panel = page.locator('aside[aria-label^="Thread"]');
    await expect(panel).toBeVisible();

    await osDrop(page, panel, [makePng(dir, "into-the-thread.png")], async () => {
      await expect(overlay(page)).toHaveCount(1);
      await expect(panel.locator("[data-file-drop-overlay]")).toHaveCount(1);
      await shot(page, "thread-overlay");
    });
    await expect(panel.getByRole("list", { name: "Attachments" }).getByRole("listitem")).toHaveCount(1);
    // The parent channel's composer stays empty.
    await expect(
      pane(page).getByRole("list", { name: "Attachments" }),
    ).toHaveCount(0);
  });

  test("with real storage, a dropped file shows progress and then lands", async ({
    page,
  }, testInfo) => {
    const real = (await (
      await fetch(`${API}/api/attachments/config`, { headers })
    ).json()) as { enabled: boolean };
    test.skip(!real.enabled, "no S3_* on the API under test: see the note at the top of this file");
    // The stub above is for the tests that need no bytes; this one wants the
    // real answer, so it is taken off.
    await page.unroute("**/api/attachments/config");
    const dir = fixtureDir(testInfo);
    await openApp(page);
    const put = page.waitForResponse(
      (response) => response.request().method() === "PUT" && response.url().includes("9000"),
    );
    await osDrop(page, pane(page), [makePng(dir, "lands.png")]);
    await expect(chips(page)).toHaveCount(1);
    expect((await put).status()).toBe(200);
    // Settled: no progress bar left and no error on the chip.
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    await expect(chips(page).first()).not.toContainText(/fail|refused|rejected/i);
    await shot(page, "upload-landed");
  });

  test("a DM takes a drop through the same composer", async ({ page }, testInfo) => {
    const dir = fixtureDir(testInfo);
    const calleeHeaders = { ...headers, Authorization: `Bearer ${DEV_TOKEN}:dropdm` };
    await ensureServer();
    for (const h of [headers, calleeHeaders]) {
      await fetch(`${API}/api/me/age-check`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
      });
    }
    const them = (await (await fetch(`${API}/api/me`, { headers: calleeHeaders })).json()) as {
      id: string;
    };
    await fetch(`${API}/api/me`, {
      method: "PATCH",
      headers: calleeHeaders,
      body: JSON.stringify({ dmPrivacy: "everyone" }),
    });
    await fetch(`${API}/api/dms`, {
      method: "POST",
      headers,
      body: JSON.stringify({ userIds: [them.id] }),
    });

    await openApp(page);
    await page.getByRole("button", { name: "Direct messages" }).click();
    await page.getByText(/dropdm|Dropdm|Dev User/).first().click();
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();

    await osDrop(page, pane(page), [makePng(dir, "to-a-friend.png")], async () => {
      await expect(overlay(page)).toHaveAttribute("data-file-drop-overlay", "accept");
      await shot(page, "dm-overlay");
    });
    await expect(chips(page)).toHaveCount(1);
    await expect(chips(page).first()).toContainText("to-a-friend.png");
  });

  test("a folder is refused with a message, not swallowed", async ({ page }, testInfo) => {
    const dir = fixtureDir(testInfo);
    await openApp(page);
    await osDrop(page, pane(page), [path.join(dir, "a-folder")]);
    await expect(page.getByRole("status").filter({ hasText: "a-folder is a folder" })).toBeVisible();
    await expect(chips(page)).toHaveCount(0);
    await shot(page, "folder-refused");
  });

  test("a file and a folder together: the file is staged, the folder is named", async ({
    page,
  }, testInfo) => {
    const dir = fixtureDir(testInfo);
    await openApp(page);
    await osDrop(page, pane(page), [makePng(dir, "kept.png"), path.join(dir, "a-folder")]);
    await expect(chips(page)).toHaveCount(1);
    await expect(chips(page).first()).toContainText("kept.png");
    await expect(page.getByRole("status").filter({ hasText: "a-folder is a folder" })).toBeVisible();
  });

  test("an over-limit file, a wrong type and a pile of files each say why", async ({
    page,
  }, testInfo) => {
    const dir = fixtureDir(testInfo);
    await openApp(page);

    const big = path.join(dir, "huge.png");
    writeFileSync(big, Buffer.alloc(11 * 1024 * 1024));
    const exe = path.join(dir, "setup.exe");
    writeFileSync(exe, "MZ");
    await osDrop(page, pane(page), [big, exe]);
    const strip = page.getByRole("status").filter({ hasText: "huge.png" });
    await expect(strip).toContainText("larger than the");
    await expect(strip).toContainText("setup.exe");
    await expect(chips(page)).toHaveCount(0);
    await shot(page, "over-limit");

    // Twelve small files against a cap of ten per message.
    const many = Array.from({ length: 12 }, (_, i) => makePng(dir, `p${i}.png`));
    await osDrop(page, pane(page), many);
    await expect(chips(page)).toHaveCount(10);
    await expect(page.getByRole("status").filter({ hasText: "only 10 attachments" }).first()).toBeVisible();
  });

  test("with uploads off, the overlay says so, nothing is staged, and the drop is still claimed", async ({
    page,
  }, testInfo) => {
    const dir = fixtureDir(testInfo);
    // Stubbed before the app asks. The probe is memoised per page load.
    await page.route("**/api/attachments/config", (route) =>
      route.fulfill({
        json: { enabled: false, maxBytes: 10485760 },
      }),
    );
    await openApp(page).catch(async () => {
      // `openApp` waits for a Send button, which is there with uploads off too.
    });
    await recordDrags(page);

    await osDrop(page, pane(page), [makePng(dir, "nope.png")], async () => {
      await expect(overlay(page)).toHaveAttribute("data-file-drop-overlay", "refuse");
      await expect(overlay(page)).toContainText("File uploads are turned off on this server");
      await shot(page, "uploads-off-overlay");
    });
    await expect(chips(page)).toHaveCount(0);
    await expect(overlay(page)).toHaveCount(0);
    // A refused drag is answered "none" and still claimed: the browser is
    // never left to open the file.
    const seen = await drags(page);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((d) => d.claimed)).toBe(true);
  });

  test("a drop on the channel list or a dialog attaches nothing, shows no overlay, and is claimed", async ({
    page,
  }, testInfo) => {
    const dir = fixtureDir(testInfo);
    await openApp(page);
    await recordDrags(page);
    const file = makePng(dir, "stray.png");

    // The channel sidebar: not a drop zone, so the page-wide guard answers.
    await osDrop(page, page.locator("[data-server-menu-trigger]").first(), [file], async () => {
      await expect(overlay(page)).toHaveCount(0);
    });
    await expect(chips(page)).toHaveCount(0);

    // A dialog over the chat: a drop on IT must not reach the conversation
    // behind it (React bubbles events through portals).
    await page.getByRole("button", { name: "Open settings" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await osDrop(page, dialog, [file], async () => {
      await expect(overlay(page)).toHaveCount(0);
    });
    await expect(chips(page)).toHaveCount(0);

    const seen = await drags(page);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((d) => d.claimed)).toBe(true);
    expect(page.url()).toContain("/app");
  });

  test("the avatar picker takes a dropped image through its own upload", async ({
    page,
  }, testInfo) => {
    const dir = fixtureDir(testInfo);
    // Uploads on for this test and refused at the first request: what is under
    // test is that a drop starts the PICKER's upload (the crop, then the mint),
    // not that storage answers.
    await page.route("**/api/avatars/config", (route) =>
      route.fulfill({ json: { enabled: true, maxBytes: 524288, size: 512 } }),
    );
    await page.route("**/api/me/avatar", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 503, json: { error: "no storage in this test" } })
        : route.continue(),
    );
    await openApp(page);
    await page.getByRole("button", { name: "Open settings" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // The picker's own upload button sits inside its drop zone (the link
    // field is folded away until "Use a link" is pressed).
    const picker = dialog.getByRole("button", { name: /upload a photo/i }).first();
    await expect(picker).toBeVisible();

    const mint = page.waitForRequest(
      (request) => request.url().endsWith("/api/me/avatar") && request.method() === "POST",
    );
    await osDrop(page, picker, [makePng(dir, "me.png")], async () => {
      await expect(overlay(page)).toHaveAttribute("data-file-drop-overlay", "accept");
      await expect(overlay(page)).toContainText("Drop an image to use it");
      await shot(page, "avatar-picker-overlay");
    });
    // The same mint request a picked file makes, for the cropped JPEG.
    const body = (await mint).postDataJSON() as { contentType: string };
    expect(body.contentType).toBe("image/jpeg");
    // And nothing was attached to the chat behind the dialog.
    await expect(chips(page)).toHaveCount(0);
  });

  test("a drag that starts inside pqp never raises the file overlay", async ({ page }) => {
    await openApp(page);
    // The browser dresses an <img> drag as a file; pqp's own drags must not
    // be mistaken for one. A synthetic sequence is enough here because what is
    // under test is the page's decision, not the browser's.
    const sawOverlay = await page.evaluate(async () => {
      const pane = document.querySelector("main")!;
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([1])], "inside.png", { type: "image/png" }));
      // The page's own dragstart, then a file-typed drag over the pane.
      pane.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
      pane.dispatchEvent(
        new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      const seen = !!document.querySelector("[data-file-drop-overlay]");
      pane.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
      return seen;
    });
    expect(sawOverlay).toBe(false);
  });
});
