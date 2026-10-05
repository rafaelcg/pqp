import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Re-records the three product screenshots on `pqp.gg/streamers`
 * (`client/public/images/streamers/<step>-<locale>[-720].webp`).
 *
 * NOT A TEST. Skipped unless `STREAMERS_SHOTS_DIR` names an output directory,
 * like `bau-demo-record.spec.ts`, and for the same reason it lives here: it
 * needs the suite's webServer pair (API on 3101, Vite on 5174) and the
 * dev-bypass identities.
 *
 *   cd client
 *   STREAMERS_SHOTS_DIR=/tmp/streamers-shots E2E_DATABASE_URL=... \
 *     npx playwright test e2e/streamers-shots.spec.ts --project=chromium
 *
 * then, per file, two widths of webp into `client/public/images/streamers/`:
 *
 *   cwebp -q 78 setup-pt-BR.png -o setup-pt-BR.webp
 *   cwebp -q 78 -resize 720 0 setup-pt-BR.png -o setup-pt-BR-720.webp
 *
 * WHAT IS REAL AND WHAT IS NOT, said once so nobody has to guess from a
 * picture. The server, the accounts, the party, its options, the go-live, the
 * chat and every piece of chrome are the real app. Two things a laptop cannot
 * produce are generated, and both are deliberately abstract so nobody can
 * mistake them for anything anybody owns: the presenter's screen is a fake
 * capture device playing a generated fractal (`--use-file-for-fake-video-
 * capture`), and the audience's playlist is the same kind of fractal plus a
 * plain gradient as the "camera", encoded by ffmpeg and served in place of
 * the egress (the `withFakeLiveStream` seam of `watch-party.spec.ts`). No
 * viewer count is drawn: the frame carries none, so the app shows none.
 *
 * Needs ffmpeg on the PATH.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const OUT = process.env.STREAMERS_SHOTS_DIR;
const DEV_TOKEN = "dev-local-token";
const LOCALES = ["pt-BR", "en", "es"] as const;
/** `SHOTS.live.height` in `pages/streamers-page.tsx`. */
const LIVE_SHOT_HEIGHT = 850;

test.skip(!OUT, "Set STREAMERS_SHOTS_DIR to record the /streamers screenshots");

const MEDIA = OUT ? fs.mkdtempSync(path.join(os.tmpdir(), "pqp-streamers-shots-")) : "";

function ffmpeg(args: string[]): void {
  const run = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args]);
  if (run.status !== 0) {
    throw new Error(`ffmpeg failed: ${run.stderr.toString()}`);
  }
}

// What the presenter "shares": a few seconds of a generated fractal, looped by
// Chromium's fake capture device.
const SCENE = path.join(MEDIA, "scene.y4m");
if (OUT) {
  ffmpeg([
    "-f", "lavfi", "-i", "mandelbrot=size=960x540:rate=15",
    "-t", "4", "-vf", "hue=s=0.55", "-pix_fmt", "yuv420p", SCENE,
  ]);
  // The audience's playlist: the same kind of picture, and a gradient where
  // the presenter's camera would be.
  ffmpeg([
    "-f", "lavfi", "-i", "mandelbrot=size=1280x720:rate=15",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
    "-t", "90", "-vf", "hue=s=0.55", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-g", "30", "-c:a", "aac", "-shortest",
    "-f", "hls", "-hls_time", "2", "-hls_list_size", "0",
    "-hls_segment_filename", path.join(MEDIA, "screen%d.ts"),
    path.join(MEDIA, "screen.m3u8"),
  ]);
  ffmpeg([
    "-f", "lavfi", "-i", "gradients=size=640x360:rate=15:speed=0.02",
    "-t", "90", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30",
    "-f", "hls", "-hls_time", "2", "-hls_list_size", "0",
    "-hls_segment_filename", path.join(MEDIA, "cam%d.ts"),
    path.join(MEDIA, "cam.m3u8"),
  ]);
}

test.use({
  viewport: { width: 1440, height: 900 },
  colorScheme: "dark",
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${SCENE}`,
      "--auto-select-desktop-capture-source=Entire screen",
      "--auto-accept-this-tab-capture",
    ],
  },
  permissions: ["microphone"],
});

test.setTimeout(240_000);

function headers(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`${response.url} ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/** Past the age gate and onboarding, with a display name a person would pick. */
async function person(suffix: string, displayName: string): Promise<void> {
  await fetch(`${API}/api/me`, { headers: headers(suffix) });
  await fetch(`${API}/api/me/age-check`, {
    method: "POST",
    headers: headers(suffix),
    body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
  });
  await fetch(`${API}/api/me`, {
    method: "PATCH",
    headers: headers(suffix),
    body: JSON.stringify({ displayName }),
  });
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers: headers(suffix),
    body: JSON.stringify({
      onboardedAt: new Date().toISOString(),
      firstRunDismissedAt: new Date().toISOString(),
    }),
  });
}

async function join(owner: string, serverId: string, suffix: string): Promise<void> {
  const { invite } = await json<{ invite: { code: string } }>(
    await fetch(`${API}/api/servers/${serverId}/invites`, {
      method: "POST",
      headers: headers(owner),
      body: JSON.stringify({}),
    }),
  );
  await json(
    await fetch(`${API}/api/invites/${invite.code}/join`, {
      method: "POST",
      headers: headers(suffix),
    }),
  );
}

/** A line in a channel, sent the way the app sends one: over the socket. */
async function say(suffix: string, channelId: string, body: string): Promise<void> {
  const url = API.replace(/^http/, "ws") + "/ws";
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("ws")), { once: true });
  });
  const ready = new Promise<void>((resolve) => {
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as { type?: string };
      if (frame.type === "ready" || frame.type === "welcome" || frame.type === "auth-ok") {
        resolve();
      }
    });
    setTimeout(resolve, 2500);
  });
  socket.send(JSON.stringify({ type: "auth", token: `${DEV_TOKEN}:${suffix}` }));
  await ready;
  const echoed = new Promise<void>((resolve) => {
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as { type?: string };
      if (frame.type === "message-broadcast" || frame.type === "message-rejected") {
        resolve();
      }
    });
    setTimeout(resolve, 3000);
  });
  socket.send(JSON.stringify({ type: "message-create", channelId, body }));
  await echoed;
  socket.close();
}

/**
 * The live frame's `stream`, pointing at the generated playlists above, for
 * whichever channel `channel()` names. A getter, because the host's page is
 * opened before the party (and so its channel) exists.
 */
async function servePlaylists(
  page: Page,
  channel: () => string | null,
): Promise<{ announce: () => void }> {
  const startedAt = Date.now() - 60_000;
  const streamFor = (channelId: string) => ({
    hlsUrl: `/api/voice/hls-playlist/${channelId}/shots-screen?t=shots`,
    cameraHlsUrl: `/api/voice/hls-playlist/${channelId}/shots-cam?t=shots`,
    cameraHasVideo: true,
    startedAt,
    presenterPeerId: "shots-presenter",
    delaySeconds: 8,
  });
  await page.route("**/api/channels/*/live", async (route) => {
    const response = await route.fetch();
    const id = channel();
    if (!id || !route.request().url().includes(id)) {
      await route.fulfill({ response });
      return;
    }
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, stream: streamFor(id) } });
  });
  const playlist = (name: string) =>
    fs
      .readFileSync(path.join(MEDIA, `${name}.m3u8`), "utf8")
      .replace("#EXT-X-ENDLIST\n", "");
  await page.route("**/api/voice/hls-playlist/**", (route) => {
    const url = new URL(route.request().url());
    const file = url.pathname.split("/").pop()!;
    if (file.endsWith(".ts")) {
      return route.fulfill({
        status: 200,
        contentType: "video/mp2t",
        body: fs.readFileSync(path.join(MEDIA, file)),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/vnd.apple.mpegurl",
      body: playlist(file.includes("cam") ? "cam" : "screen"),
    });
  });
  // The host's half: the room's own `voice-stream`, which is what tells a
  // presenter the egress is up. Sent once `announce()` is called, the moment
  // a real egress would have answered.
  const sockets: { send: (message: string) => void }[] = [];
  let announced = false;
  // The server's own last word on the room (how many are watching), so the
  // announcement repeats its count rather than making one up.
  let lastLive: Record<string, unknown> | null = null;
  const voiceStream = (id: string) =>
    JSON.stringify({
      type: "voice-stream",
      channelId: id,
      stream: { ...streamFor(id), topHeight: 720 },
    });
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    sockets.push(ws);
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (typeof message === "string") {
        try {
          const frame = JSON.parse(message) as Record<string, unknown>;
          const id = channel();
          if (frame.type === "channel-live" && id && frame.channelId === id) {
            lastLive = frame;
            ws.send(JSON.stringify({ ...frame, stream: streamFor(id) }));
            return;
          }
          if (announced && frame.type === "voice-stream" && id && frame.channelId === id) {
            ws.send(voiceStream(id));
            return;
          }
        } catch {
          // Not ours.
        }
      }
      ws.send(message);
    });
  });
  return {
    announce: () => {
      const id = channel();
      if (!id) return;
      announced = true;
      const live = JSON.stringify({
        ...(lastLive ?? { type: "channel-live", channelId: id, watching: 0 }),
        stream: streamFor(id),
      });
      for (const socket of sockets) {
        socket.send(voiceStream(id));
        socket.send(live);
      }
    },
  };
}

/** The operator's per-server answer, which a laptop cannot produce. */
async function liveHlsOn(page: Page): Promise<void> {
  await page.route("**/api/live-hls/config*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, enabled: true } });
  });
}

/**
 * Who the page is, plus the furniture a returning person has already put
 * away (the member list, the desktop download strip), and a screen share that
 * hands back the fake camera device, which is playing the generated scene.
 * The real picker would capture this very tab.
 */
async function as(page: Page, suffix: string): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
    localStorage.setItem("pqp:member-sidebar", "false");
    localStorage.setItem("pqp:download-hint-dismissed", "1");
    const media = navigator.mediaDevices;
    if (media) {
      media.getDisplayMedia = () =>
        media.getUserMedia({ video: { width: 1280, height: 720 }, audio: true });
    }
  }, suffix);
}

/** The dev bypass's own banner is not part of the product. */
async function hideDevBanner(page: Page): Promise<void> {
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = `main > [class*="border-warning/30"] { display: none !important; }`;
    document.head.appendChild(style);
  });
}

/** Lines a room says while it waits and watches. Nothing about what is on. */
const CHAT: Record<(typeof LOCALES)[number], string[]> = {
  "pt-BR": ["boa noite, galera", "o som tá ótimo daqui", "cheguei!", "bora"],
  en: ["evening, everyone", "sound is great from here", "made it!", "let's go"],
  es: ["buenas noches, banda", "el sonido se oye perfecto", "¡llegué!", "vamos"],
};

const PARTY_NAME: Record<(typeof LOCALES)[number], string> = {
  "pt-BR": "Sexta com a comunidade",
  en: "Friday with the community",
  es: "Viernes con la comunidad",
};

for (const locale of LOCALES) {
  test(`records the three steps in ${locale}`, async ({ page, browser }) => {
    const run = `${locale.toLowerCase().replace("-", "")}${Date.now().toString(36)}`.slice(0, 20);
    const host = `sh-host-${run}`;
    const viewer = `sh-view-${run}`;
    const chatters = [`sh-a-${run}`, `sh-b-${run}`, `sh-c-${run}`];
    await person(host, "Host");
    await person(viewer, locale === "en" ? "Sam" : "Bia");
    for (const [i, suffix] of chatters.entries()) {
      await person(suffix, ["Lu", "Davi", "Rê"][i]!);
    }
    const { server } = await json<{ server: { id: string } }>(
      await fetch(`${API}/api/servers`, {
        method: "POST",
        headers: headers(host),
        body: JSON.stringify({ name: locale === "en" ? "The Crew" : "A Galera" }),
      }),
    );
    for (const suffix of [viewer, ...chatters]) {
      await join(host, server.id, suffix);
    }
    const { channels } = await json<{ channels: { id: string; type: string }[] }>(
      await fetch(`${API}/api/servers/${server.id}/channels`, { headers: headers(host) }),
    );
    const text = channels.find((one) => one.type === "text")!;

    // 1. The host sets the party up.
    let partyChannel: string | null = null;
    await liveHlsOn(page);
    const hostStream = await servePlaylists(page, () => partyChannel);
    await as(page, host);
    await page.goto(
      `/app/server/${server.id}/channel/${text.id}?lang=${locale}&watchParty=1`,
    );
    await hideDevBanner(page);
    const create = page.locator("[data-live-party-create]");
    await expect(create).toBeVisible({ timeout: 30_000 });
    await create.click();
    await page.locator("[data-create-watch-party-name]").fill(PARTY_NAME[locale]);
    await page.locator("[data-create-watch-party-submit]").click();
    const setup = page.getByTestId("watch-party-setup");
    await expect(setup).toBeVisible({ timeout: 20_000 });
    const channelId = new URL(page.url()).pathname.split("/").pop()!;
    partyChannel = channelId;
    const ack = page.getByRole("dialog");
    await expect(ack).toBeVisible({ timeout: 20_000 });
    await ack.getByRole("button").last().click();
    await expect(ack).toBeHidden({ timeout: 20_000 });
    await setup
      .getByRole("button", {
        name: /Escolher o que compartilhar|Pick what to share|Elegir qué compartir/,
      })
      .click({ timeout: 20_000 });
    await expect(page.getByTestId("watch-party-preview")).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1500);
    await page.mouse.move(1430, 890);
    await page.screenshot({ path: `${OUT}/setup-${locale}.png` });

    // 2. Live, from the host's chair, with the room talking.
    await page.locator("[data-watch-party-go-live]").click();
    await expect(page.getByTestId("watch-party-bar")).toBeVisible({ timeout: 20_000 });
    // "Turn the mic on?": yes, the page says the host's voice goes out too.
    const micAsk = page.getByRole("dialog");
    const asked = await micAsk
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (asked) {
      await micAsk.getByRole("button").last().click();
      await expect(micAsk).toBeHidden({ timeout: 10_000 });
    }
    // What a real egress would answer the moment it is up.
    hostStream.announce();
    for (const [i, suffix] of chatters.entries()) {
      await say(suffix, channelId, CHAT[locale][i]!);
    }

    // 3. The audience, in a browser of its own, with no seat. Opened before
    // the host's picture is taken, so the host's count is a real one.
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: "dark",
    });
    try {
      const watcher = await context.newPage();
      await liveHlsOn(watcher);
      await servePlaylists(watcher, () => channelId);
      await as(watcher, viewer);
      await watcher.goto(
        `/app/server/${server.id}/channel/${channelId}?lang=${locale}&watchParty=1`,
      );
      await hideDevBanner(watcher);
      await expect(watcher.getByTestId("watch-channel-stage")).toBeVisible({
        timeout: 30_000,
      });
      await say(chatters[2]!, channelId, CHAT[locale][3]!);
      // Playing, not buffering: the picture's own clock has moved.
      await watcher.waitForFunction(
        () => {
          const videos = [...document.querySelectorAll("video")];
          return videos.some((video) => video.currentTime > 1 && !video.paused);
        },
        undefined,
        { timeout: 60_000 },
      );
      await watcher.waitForTimeout(2000);
      await watcher.mouse.move(1430, 890);
      await watcher.waitForTimeout(3500);
      await watcher.screenshot({ path: `${OUT}/watch-${locale}.png` });

      await page.waitForTimeout(1500);
      await page.mouse.move(1430, 890);
      // Cut above the presenter's control row. On this laptop the room is a
      // peer-to-peer call with no egress, so the microphone pill there reads
      // "only the room hears you", which is true here and not what a real
      // party says (its mic goes out with the picture).
      await page.screenshot({
        path: `${OUT}/live-${locale}.png`,
        clip: { x: 0, y: 0, width: 1440, height: LIVE_SHOT_HEIGHT },
      });
    } finally {
      await context.close();
    }
  });
}
