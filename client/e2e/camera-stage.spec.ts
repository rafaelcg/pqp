import { expect, test } from "@playwright/test";
import { ensureServer, openApp } from "./fixtures";

/**
 * Turning a camera on in a server voice channel must grow the shared stage,
 * not a sidebar tile. Voice-only stays a slim bar.
 */

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

  // Scoped to the stage grid, not `page.getByLabel` at large: alone in the
  // room our camera is also briefly a match inside the floating self-preview
  // pip (`stage-layout.ts`'s `selfPreview`, a few dozen px² at this
  // viewport) the instant the stream attaches and before `planStage`
  // settles on the solo tile taking the whole grid. `stage-grid` only
  // exists once `planStage` has put a tile on the big stage, so scoping here
  // rules that element out rather than racing it.
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
