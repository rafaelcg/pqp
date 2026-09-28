import { expect, test, type Page } from "@playwright/test";
import { ensureServer, leaveVoiceIfConnected, openApp } from "./fixtures";

/**
 * Turning a camera on in a server voice channel must grow the shared stage,
 * not a sidebar tile. Voice-only stays a slim bar.
 */

// This spec never used to hang up, unlike its siblings (call-stage-strip,
// mobile-immersive-stage, and others): it turns the camera off but never
// clicks Leave, so the lobby seat stayed held. Invisible while a run
// finished clean, but a run that fails partway (anywhere between "camera
// on" and the end) leaves the page abandoned mid-call. Playwright's own
// teardown skips `pagehide`, so the seat orphans for up to 90s with the
// camera still attached (`voice.orphan` in the server log). CI retries
// once, and the retry's fresh page joins that SAME still-live room:
// `planStage` then correctly sees a SECOND camera already on the stage
// and floats ours in the self-preview pip instead. Not a rendering race,
// a real second publisher. `getByLabel("Your camera")` inside
// `stage-grid` then never resolves, which is the exact "element(s) not
// found" failure this was chasing. Confirmed locally: a page abandoned
// right after "camera on" (simulating a failed, unhung-up attempt)
// leaves a peer whose camera a fresh join can actually see, while 35
// straight repeats of this spec on its own (15 at normal speed, 20 more
// under 6x CPU throttling) never failed. It takes a prior attempt's
// leftover seat to do it. Hanging up here, like every sibling voice spec
// already does, is what keeps a single bad run from poisoning its own
// retry.
test.afterEach(async ({ page }) => {
  await leaveVoiceIfConnected(page).catch(() => {});
});

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
  permissions: ["microphone", "camera"],
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
  if (
    channels.some(
      (c) => c.type === "voice" && c.name.toLowerCase() === "lobby",
    )
  ) {
    return;
  }
  await fetch(`${API}/api/servers/${serverId}/channels`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "lobby", type: "voice" }),
  });
}

test("camera on expands the lobby stage; camera off returns the slim bar", async ({
  page,
}) => {
  await ensureVoiceChannel();
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await page.getByRole("button", { name: /lobby/i }).first().dblclick();
  await expect(page.getByTestId("call-stage-collapsed")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("call-stage")).toHaveCount(0);
  // Camera is a no-op until status is connected (toggleCamera returns early).
  await expect(page.getByText("Voice connected")).toBeVisible({
    timeout: 20_000,
  });

  await page
    .getByRole("main")
    .getByRole("button", { name: "Turn camera on", exact: true })
    .click();
  await expect(page.getByTestId("call-stage")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("call-stage-collapsed")).toHaveCount(0);

  // Scoped to the stage grid, not `page.getByLabel` at large: our own
  // camera also matches inside the floating self-preview pip
  // (`stage-layout.ts`'s `selfPreview`, a few dozen px² at this viewport),
  // which is where it lands whenever somebody else is already publishing
  // exactly one picture. Alone in the room that never happens (see the
  // top-of-file note on why a stale room sometimes is not alone), so
  // `stage-grid` is where our camera belongs and this scoping rules the
  // pip out rather than racing it.
  const stageGrid = page.getByTestId("stage-grid");
  await expect(stageGrid).toBeVisible({ timeout: 20_000 });
  const video = stageGrid.getByLabel("Your camera");
  await expect(video).toBeVisible({ timeout: 20_000 });
  const viewport = page.viewportSize()!;
  // The tile is already the right element; what is still settling is its
  // layout box (the stage's own height class lands in the same React commit,
  // but the browser's layout pass and this poll are two different clocks).
  // Poll instead of reading `boundingBox()` once so the assertion waits for
  // the box to actually reach the expanded size instead of racing it.
  await expect
    .poll(
      async () => {
        const box = await video.boundingBox();
        return box ? box.width * box.height : 0;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(viewport.width * viewport.height * 0.15);

  await expect(page.getByTestId("camera-fullscreen")).toBeVisible();
  await video.dblclick();
  await expect(page.getByTestId("camera-fullscreen")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByTestId("camera-fullscreen").click();
  await expect(page.getByTestId("camera-fullscreen")).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  await page.getByRole("button", { name: "Collapse call" }).click();
  await expect(page.getByTestId("call-stage-collapsed")).toBeVisible();
  await expect(page.getByTestId("call-stage")).toHaveCount(0);

  await page.getByRole("button", { name: "Expand call" }).click();
  await expect(page.getByTestId("call-stage")).toBeVisible();
  await expect(video).toBeVisible();

  await page.getByTestId("camera-fullscreen").click();
  await expect(page.getByTestId("camera-fullscreen")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page
    .getByRole("main")
    .getByRole("button", { name: "Turn camera off", exact: true })
    .click();
  await expect(page.getByTestId("call-stage-collapsed")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("call-stage")).toHaveCount(0);
});

/**
 * Every call control on the expanded stage, and in whose hands a press at
 * its centre lands. The stage clips (`overflow-hidden`), so a tile outside
 * its box is not drawn, and a tile under the server rail or the strip is
 * drawn and cannot be pressed. Both are the same bug to a thumb.
 */
async function unreachableStageControls(
  page: Page,
): Promise<string[]> {
  return page.evaluate(() => {
    const stage = document.querySelector('[data-testid="call-stage"]');
    const bar = document.querySelector('[data-testid="call-controls-bar"]');
    if (!stage || !bar) {
      return ["no stage"];
    }
    const box = stage.getBoundingClientRect();
    const out: string[] = [];
    for (const button of Array.from(bar.querySelectorAll("button"))) {
      const r = button.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) {
        continue; // hidden at this width on purpose, like the bell
      }
      const name = button.getAttribute("aria-label") ?? "?";
      if (
        r.left < box.left - 0.5 ||
        r.right > box.right + 0.5 ||
        r.top < box.top - 0.5 ||
        r.bottom > box.bottom + 0.5
      ) {
        out.push(`${name}: outside the stage`);
        continue;
      }
      const hit = document.elementFromPoint(
        r.left + r.width / 2,
        r.top + r.height / 2,
      );
      if (hit?.closest("button") !== button) {
        out.push(`${name}: covered`);
      }
    }
    return out;
  });
}

test("a phone-width stage keeps every call control on screen", async ({
  page,
}) => {
  await ensureVoiceChannel();
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await page.getByRole("button", { name: /lobby/i }).first().dblclick();
  await expect(page.getByText("Voice connected")).toBeVisible({
    timeout: 20_000,
  });
  await page
    .getByRole("main")
    .getByRole("button", { name: "Turn camera on", exact: true })
    .click();
  await expect(page.getByTestId("call-stage")).toBeVisible({ timeout: 20_000 });

  // The stage's pill was one unbreakable row of ~33rem, centred in a stage
  // of ~20rem on a 390 phone: mute and raise hand sat under the server rail,
  // hang-up past the right edge. 320 is the narrowest phone still sold.
  const bar = page.getByTestId("call-controls-bar");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(bar.getByRole("button", { name: "Leave" })).toBeAttached();
    await expect
      .poll(() => unreachableStageControls(page), { timeout: 5_000 })
      .toEqual([]);
  }
  // And the wide stage still draws them on one line.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect
    .poll(async () => {
      const tops = await bar
        .getByRole("button")
        .evaluateAll((buttons) =>
          buttons
            .map((b) => b.getBoundingClientRect())
            .filter((r) => r.width > 0)
            .map((r) => Math.round(r.top)),
        );
      return new Set(tops).size;
    })
    .toBe(1);
});
