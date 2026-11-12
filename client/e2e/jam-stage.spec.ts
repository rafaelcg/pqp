/**
 * THE JAM'S STAGE, ITS ONE-LINE LANES AND "CLICK TO PLAY", WITH REAL CLICKS AND REAL KEYS.
 *
 *  - A click on a song's card opens it AND plays it; the round button still
 *    plays and pauses; Space on the wall plays and pauses the open song, else
 *    the card the keyboard is on, else the first card, and does nothing in a field.
 *    No `--autoplay-policy` flag here on purpose: the click and the keypress are
 *    the gesture, which is the whole point.
 *  - A song has a stage that is a MOSAIC of the whole band: one tile per recording
 *    in the mix, with a video (following the song clock, muted) or without (a
 *    tinted tile with the instrument's glyph and a level strip that moves with
 *    that take's own sound), dimmed with its lane. A tile is a button that
 *    solos its track. A part the song asks for is one dashed tile that opens the
 *    studio on that instrument. The lane has no thumbnail.
 *  - A lane's name is never overlapped by its controls ("Ajustar" is an icon),
 *    on a wide panel (one line), a narrow one and a phone (two), and in the
 *    studio's review.
 *
 * The audio is a ten second WAV declared as `audio/flac` (the server never
 * decodes audio; the browser decodes by the bytes). The video is a real 20 s
 * WebM (`fixtures/jam-clip.webm`), because the sync assertion needs a picture
 * that actually moves.
 *
 * Needs object storage like `jam-web.spec.ts` (`S3_*` exported); without it the
 * spec skips with that reason.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";
import { FAKE_MIC_WAV } from "../playwright.jam.config";

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const RUN = Date.now().toString(36);
/** Song creation is rate limited per person, so every test makes its own two people. */
let people = 0;
const CLIP = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "jam-clip.webm"));

test.setTimeout(150_000);
test.use({
  viewport: { width: 1440, height: 900 },
  colorScheme: "dark",
  permissions: ["microphone", "camera"],
  launchOptions: {
    // no `--autoplay-policy=no-user-gesture-required`: playing must work from the gesture alone
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${FAKE_MIC_WAV}`],
  },
});

const headersFor = (suffix: string) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
});

async function call<T>(suffix: string, method: string, route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: headersFor(suffix),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${method} ${route} -> ${response.status} ${await response.text()}`);
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

async function materialise(suffix: string): Promise<void> {
  const headers = headersFor(suffix);
  const me = await fetch(`${API}/api/me`, { headers });
  const body = (await me.json()) as { ageGate?: string };
  if (body.ageGate && body.ageGate !== "passed") {
    await fetch(`${API}/api/me/age-check`, { method: "POST", headers, body: JSON.stringify({ dateOfBirth: "1990-01-01" }) });
  }
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ onboardedAt: new Date().toISOString(), firstRunDismissedAt: new Date().toISOString() }),
  });
}

/** Ten seconds of a plucked note as a 16-bit mono WAV. */
function wav(seconds = 10, note = 196): Buffer {
  const rate = 8000;
  const samples = rate * seconds;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const t = i / rate;
    data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * note * t) * Math.exp(-(t % 0.5) * 5) * 9000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function upload(who: string, songId: string, kind: "audio" | "video", bytes: Buffer): Promise<string> {
  const contentType = kind === "audio" ? "audio/flac" : "video/webm";
  const ticket = await call<{ uploadId: string; uploadUrl: string }>(who, "POST", `/api/jam-songs/${songId}/uploads`, {
    kind,
    contentType,
    byteSize: bytes.length,
  });
  const put = await fetch(ticket.uploadUrl, { method: "PUT", headers: { "Content-Type": contentType, "Content-Length": String(bytes.length) }, body: bytes });
  expect(put.ok).toBe(true);
  return ticket.uploadId;
}

async function addTrack(who: string, songId: string, instrument: string, withVideo: boolean, note = 196): Promise<string> {
  const audioUploadId = await upload(who, songId, "audio", wav(10, note));
  const videoUploadId = withVideo ? await upload(who, songId, "video", CLIP) : null;
  const { track } = await call<{ track: { id: string } }>(who, "POST", `/api/jam-songs/${songId}/tracks`, {
    instrument,
    audioUploadId,
    ...(videoUploadId ? { videoUploadId } : {}),
    durationMs: 10_000,
    peaks: [0.2, 0.8, 0.5, 0.9, 0.3, 0.7, 0.4, 0.9, 0.2, 0.6],
  });
  return track.id;
}

interface Seeded {
  host: string;
  guest: string;
  serverId: string;
  jamId: string;
  uploads: boolean;
  /** Two recordings with a video and one without. */
  band: { id: string; tracks: { guitar: string; bass: string; drums: string } };
  /** No video at all. */
  plain: string;
  /** One recording, with a video. */
  solo: string;
  /** Asks for bass and vocals; has a guitar with a video and drums without. */
  wanted: string;
}

async function seed(): Promise<Seeded> {
  people += 1;
  const HOST = `stagehost${RUN}${people}`;
  const GUEST = `stageguest${RUN}${people}`;
  await materialise(HOST);
  await materialise(GUEST);
  const { server } = await call<{ server: { id: string } }>(HOST, "POST", "/api/servers", { name: `Palco ${Date.now()}` });
  const { invite } = await call<{ invite: { code: string } }>(HOST, "POST", `/api/servers/${server.id}/invites`, {});
  await call(GUEST, "POST", `/api/invites/${invite.code}/join`);
  const flip = await fetch(`${API}/api/admin/flag-overrides`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${E2E_ADMIN_TOKEN}` },
    body: JSON.stringify({ key: "jam_channels", serverId: server.id, enabled: true }),
  });
  expect(flip.status).toBe(200);
  const { channel } = await call<{ channel: { id: string } }>(HOST, "POST", `/api/servers/${server.id}/channels`, { name: "jam", type: "jam" });
  const config = await call<{ uploads: boolean }>(HOST, "GET", `/api/jam/config?serverId=${server.id}`);
  const empty = { host: HOST, guest: GUEST, serverId: server.id, jamId: channel.id, uploads: config.uploads };
  if (!config.uploads) {
    return { ...empty, band: { id: "", tracks: { guitar: "", bass: "", drums: "" } }, plain: "", solo: "", wanted: "" };
  }
  const make = async (title: string) => (await call<{ song: { id: string } }>(HOST, "POST", `/api/channels/${channel.id}/jam-songs`, { title })).song.id;
  const bandId = await make("Com palco");
  const drums = await addTrack(HOST, bandId, "drums", false, 98);
  const guitar = await addTrack(GUEST, bandId, "guitar", true, 196);
  const bass = await addTrack(HOST, bandId, "bass", true, 65);
  const plain = await make("Sem vídeo");
  await addTrack(HOST, plain, "bass", false, 82);
  const solo = await make("Um só");
  await addTrack(GUEST, solo, "guitar", true, 220);
  const { song: wantedSong } = await call<{ song: { id: string } }>(HOST, "POST", `/api/channels/${channel.id}/jam-songs`, {
    title: "Falta gente",
    joinMode: "wanted",
    wantedInstruments: ["bass", "vocals"],
  });
  await addTrack(HOST, wantedSong.id, "guitar", true, 196);
  await addTrack(HOST, wantedSong.id, "drums", false, 98);
  return { ...empty, band: { id: bandId, tracks: { guitar, bass, drums } }, plain, solo, wanted: wantedSong.id };
}

async function openAs(
  browser: Browser,
  suffix: string,
  route: string,
  viewport = { width: 1440, height: 900 },
  prepare?: (page: Page) => Promise<void>,
): Promise<Page> {
  const context = await browser.newContext({ viewport, colorScheme: "dark", permissions: ["microphone", "camera"] });
  const page = await context.newPage();
  await prepare?.(page);
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(`${route}${route.includes("?") ? "&" : "?"}lang=en`);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
  return page;
}

/** The song clock's seconds, read the way a person reads it. */
async function clockSeconds(page: Page): Promise<number> {
  const text = await page.locator("[data-jam-song] [data-jam-clock]").first().innerText();
  const match = /(\d+):(\d{2})/.exec(text);
  return match ? Number(match[1]) * 60 + Number(match[2]) : -1;
}

const playButton = (page: Page, songId: string) => page.locator(`[data-jam-song="${songId}"] [data-jam-play]`);

function boxesOverlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  expect(found, "the element has a box").not.toBeNull();
  return found!;
}

test("a click on a card opens the song and plays it, the round button toggles, and a song already playing is only opened", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  // A song with no video is a card that never reads its details, so the panel opens on an empty
  // mix and the details (the takes) arrive after it. Slowed down here so that is the order every
  // time: the click's request to play has to wait for the takes, not be spent on nothing.
  const slowDetails = (id: string) => async (page: Page) => {
    await page.route(`**/api/jam-songs/${id}`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1800));
      await route.continue();
    });
  };
  const page = await openAs(browser, seeded.host, `/app/server/${seeded.serverId}/channel/${seeded.jamId}`, undefined, slowDetails(seeded.plain));
  const card = page.locator(`[data-jam-tile="${seeded.plain}"]`);
  await expect(card).toBeVisible({ timeout: 20_000 });

  // a click on the card (its title, not the round button)
  await card.locator("[data-jam-open]").click();
  const panel = page.locator(`[data-jam-song="${seeded.plain}"]`);
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(playButton(page, seeded.plain)).toHaveAttribute("data-state", "playing", { timeout: 20_000 });
  // really playing: the clock moves
  await expect.poll(() => clockSeconds(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await expect(card).toHaveAttribute("data-playing", "true");

  // the round button pauses it, and nothing else changes: the panel stays open on the same song
  await card.locator("[data-jam-tile-play]").click();
  await expect(playButton(page, seeded.plain)).toHaveAttribute("data-state", "paused");
  await expect(panel).toBeVisible();
  const paused = await clockSeconds(page);
  await page.waitForTimeout(1200);
  expect(await clockSeconds(page), "paused is paused").toBe(paused);

  // a click on the card of a song that is open but paused plays it
  await card.locator("[data-jam-open]").click();
  await expect(playButton(page, seeded.plain)).toHaveAttribute("data-state", "playing", { timeout: 10_000 });
  // and one on a song that is playing already leaves it playing (it only opens)
  await card.locator("[data-jam-open]").click();
  await page.waitForTimeout(500);
  await expect(playButton(page, seeded.plain)).toHaveAttribute("data-state", "playing");

  // another card: that song opens and plays, and the first one stops
  await page.locator(`[data-jam-tile="${seeded.solo}"] [data-jam-open]`).click();
  await expect(playButton(page, seeded.solo)).toHaveAttribute("data-state", "playing", { timeout: 20_000 });
  await expect(page.locator(`[data-jam-song="${seeded.plain}"]`)).toHaveCount(0);
  await page.context().close();
});

test("Space on the wall plays and pauses: the open song first, else the card the keyboard is on, else the first card; and it leaves fields alone", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const page = await openAs(browser, seeded.host, `/app/server/${seeded.serverId}/channel/${seeded.jamId}`);
  await expect(page.locator("[data-jam-tile]").first()).toBeVisible({ timeout: 20_000 });
  // newest first: the first card on the wall is the last song made
  const firstId = await page.locator("[data-jam-tile]").first().getAttribute("data-jam-tile");
  expect(firstId).toBeTruthy();

  // nothing focused, nothing open: the first card opens and plays
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Space");
  await expect(playButton(page, firstId!)).toHaveAttribute("data-state", "playing", { timeout: 20_000 });
  // Space again pauses it, and again plays it
  await page.keyboard.press("Space");
  await expect(playButton(page, firstId!)).toHaveAttribute("data-state", "paused");
  await page.keyboard.press("Space");
  await expect(playButton(page, firstId!)).toHaveAttribute("data-state", "playing");

  // with a song open the key is the open song's, even with the keyboard on ANOTHER card
  const other = page.locator(`[data-jam-tile]:not([data-jam-tile="${firstId}"]) [data-jam-open]`).first();
  await other.focus();
  await page.keyboard.press("Space");
  await expect(playButton(page, firstId!)).toHaveAttribute("data-state", "paused");
  await expect(page.locator(`[data-jam-song="${firstId}"]`)).toBeVisible();

  // a field keeps its Space: typing a space in the search does not touch the song
  const search = page.getByPlaceholder("Search messages");
  if (await search.count()) {
    await search.first().focus();
    await page.keyboard.press("Space");
    await expect(playButton(page, firstId!)).toHaveAttribute("data-state", "paused");
  }

  // closed, with the keyboard on a card: that card opens and plays
  await page.keyboard.press("Escape");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-jam-song]")).toHaveCount(0);
  const target = page.locator(`[data-jam-tile="${seeded.solo}"] [data-jam-open]`);
  await target.focus();
  await page.keyboard.press("Space");
  await expect(playButton(page, seeded.solo)).toHaveAttribute("data-state", "playing", { timeout: 20_000 });
  await page.context().close();
});

test("a song has a stage that is a mosaic of the band: a tile per recording in the mix, video or not, muted, on the song clock, dimmed with its lane; the lane has no thumbnail", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const page = await openAs(browser, seeded.host, `/app/server/${seeded.serverId}/channel/${seeded.jamId}/song/${seeded.band.id}`);
  const panel = page.locator(`[data-jam-song="${seeded.band.id}"]`);
  await expect(panel.locator("[data-jam-track]")).toHaveCount(3, { timeout: 20_000 });

  // one tile per recording in the mix, the drums (no video) included, none in a lane
  const stage = panel.locator("[data-jam-stage]");
  await expect(stage).toBeVisible();
  await expect(stage.locator("[data-jam-stage-tile]")).toHaveCount(3);
  const drumsTile = stage.locator(`[data-jam-stage-tile="${seeded.band.tracks.drums}"]`);
  await expect(drumsTile).toHaveAttribute("data-jam-stage-kind", "audio");
  await expect(drumsTile.locator("video")).toHaveCount(0);
  await expect(panel.locator("[data-jam-track] video")).toHaveCount(0);
  await expect(panel.locator("[data-jam-lane-video-open]")).toHaveCount(0);

  // the stage is one rectangle, no taller than 55% of the window, and every tile has a chip with the person
  expect((await box(stage)).height).toBeLessThanOrEqual(900 * 0.55 + 2);
  const tile = stage.locator(`[data-jam-stage-tile="${seeded.band.tracks.guitar}"]`);
  expect((await box(tile)).width).toBeGreaterThan(150);
  await expect(tile.locator("[data-jam-stage-chip]")).toContainText("Dev User");
  // the host recorded the drums: their own chip says "you"
  await expect(drumsTile.locator("[data-jam-caption-person]")).toHaveText("you");
  await expect(stage.locator("video[data-jam-stage-video]").first()).toHaveJSProperty("muted", true);

  // the header is the compact one for every song with a take; it holds the play button and the cover is a small mark
  const header = panel.locator("[data-jam-header]");
  await expect(header).toHaveAttribute("data-jam-header", "compact");
  await expect(header.locator("[data-jam-play]")).toBeVisible();
  expect((await box(panel.locator("[data-jam-cover]"))).width).toBeLessThanOrEqual(60);

  // play: every video's picture advances with the clock
  await expect(playButton(page, seeded.band.id)).toBeEnabled({ timeout: 20_000 });
  await playButton(page, seeded.band.id).click();
  await expect(playButton(page, seeded.band.id)).toHaveAttribute("data-state", "playing", { timeout: 15_000 });
  await expect.poll(() => clockSeconds(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  const readings = await stage.locator("video[data-jam-stage-video]").evaluateAll((videos) =>
    (videos as HTMLVideoElement[]).map((video) => ({ time: video.currentTime, paused: video.paused })),
  );
  const clock = await clockSeconds(page);
  expect(readings).toHaveLength(2);
  for (const reading of readings) {
    expect(reading.paused, "a stage video plays while the song does").toBe(false);
    expect(Math.abs(reading.time - clock), "the picture is where the song is (to the second the clock shows)").toBeLessThan(1.6);
    expect(reading.time).toBeGreaterThan(1);
  }

  // a muted lane dims its tile, un-muting brings it back
  const bassLane = panel.locator(`[data-jam-track="${seeded.band.tracks.bass}"]`);
  const bassTile = stage.locator(`[data-jam-stage-tile="${seeded.band.tracks.bass}"]`);
  await expect(bassTile).not.toHaveAttribute("data-dimmed", "true");
  await bassLane.locator("[data-jam-mute]").click();
  await expect(bassTile).toHaveAttribute("data-dimmed", "true");
  await expect(tile).not.toHaveAttribute("data-dimmed", "true");
  await bassLane.locator("[data-jam-mute]").click();
  await expect(bassTile).not.toHaveAttribute("data-dimmed", "true");
  // solo on the guitar's lane sits the bass tile and the drums tile back
  await panel.locator(`[data-jam-track="${seeded.band.tracks.guitar}"] [data-jam-solo]`).click();
  await expect(bassTile).toHaveAttribute("data-dimmed", "true");
  await expect(drumsTile).toHaveAttribute("data-dimmed", "true");
  await expect(tile).not.toHaveAttribute("data-dimmed", "true");
  await page.context().close();
});

for (const [label, viewport] of [
  ["the 540 px panel of a laptop", { width: 1440, height: 900 }],
  ["a wide panel", { width: 1900, height: 1000 }],
  ["a phone", { width: 390, height: 844 }],
] as const) {
  test(`the mosaic's tiles never overlap and fill the stage, on ${label}, for one tile up to a crowd`, async ({ browser }) => {
    const seeded = await seed();
    test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
    // one video; three (two video, one without); and the song that asks for two parts (two tiles and two dashed ones)
    for (const [songId, who, expected] of [
      [seeded.solo, seeded.host, 1],
      [seeded.band.id, seeded.host, 3],
      [seeded.wanted, seeded.guest, 4],
    ] as const) {
      const page = await openAs(browser, who, `/app/server/${seeded.serverId}/channel/${seeded.jamId}/song/${songId}`, viewport);
      const stage = page.locator(`[data-jam-song="${songId}"] [data-jam-stage]`);
      await expect(stage.locator("[data-jam-stage-grid] > *")).toHaveCount(expected, { timeout: 20_000 });
      // every rectangle read in one go, so nothing moves between two readings
      await page.waitForTimeout(600);
      const { stageBox, boxes } = await stage.locator("[data-jam-stage-grid]").evaluate((grid) => {
        const rect = (element: Element) => {
          const found = element.getBoundingClientRect();
          return { x: found.x, y: found.y, width: found.width, height: found.height };
        };
        return { stageBox: rect(grid), boxes: [...grid.children].map(rect) };
      });
      for (let a = 0; a < boxes.length; a += 1) {
        const one = boxes[a]!;
        // inside the stage
        expect(one.x).toBeGreaterThanOrEqual(stageBox.x - 1);
        expect(one.y).toBeGreaterThanOrEqual(stageBox.y - 1);
        expect(one.x + one.width).toBeLessThanOrEqual(stageBox.x + stageBox.width + 1);
        expect(one.y + one.height).toBeLessThanOrEqual(stageBox.y + stageBox.height + 1);
        // no sliver: narrower than a third of its height or wider than three and a half times it is a layout bug
        expect(one.width / one.height).toBeGreaterThan(0.3);
        expect(one.width / one.height).toBeLessThan(3.5);
        for (let b = a + 1; b < boxes.length; b += 1) {
          // 2 px gutters are drawn by the grid's gap, so the boxes touch at most; a pixel of tolerance for rounding
          const two = boxes[b]!;
          const overlapX = Math.min(one.x + one.width, two.x + two.width) - Math.max(one.x, two.x);
          const overlapY = Math.min(one.y + one.height, two.y + two.height) - Math.max(one.y, two.y);
          expect(overlapX > 1.01 && overlapY > 1.01, `tile ${a} and tile ${b} overlap`).toBe(false);
        }
      }
      // no gap: the tiles' areas and the 2 px gutters between them add up to the stage
      const area = boxes.reduce((sum, one) => sum + one.width * one.height, 0);
      expect(area).toBeGreaterThan(stageBox.width * stageBox.height * 0.9);
      expect(area).toBeLessThanOrEqual(stageBox.width * stageBox.height + 1);
      // the shape follows the panel: a phone's stage is square, a panel's is wider than tall
      if (viewport.width < 480) {
        expect(stageBox.height).toBeGreaterThanOrEqual(stageBox.width * 0.98);
      } else {
        expect(stageBox.width).toBeGreaterThan(stageBox.height);
      }
      expect(stageBox.height).toBeLessThanOrEqual(viewport.height * 0.55 + 2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.context().close();
    }
  });
}

test("a tile is the solo button: a click solos that track, a second clears it, Enter and Space do the same, and the lane agrees", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const page = await openAs(browser, seeded.host, `/app/server/${seeded.serverId}/channel/${seeded.jamId}/song/${seeded.band.id}`);
  const panel = page.locator(`[data-jam-song="${seeded.band.id}"]`);
  const stage = panel.locator("[data-jam-stage]");
  await expect(stage.locator("[data-jam-stage-tile]")).toHaveCount(3, { timeout: 20_000 });
  const guitar = stage.locator(`[data-jam-stage-tile="${seeded.band.tracks.guitar}"]`);
  const bass = stage.locator(`[data-jam-stage-tile="${seeded.band.tracks.bass}"]`);
  const drums = stage.locator(`[data-jam-stage-tile="${seeded.band.tracks.drums}"]`);
  const lane = (id: string) => panel.locator(`[data-jam-track="${id}"]`);

  // a real button, not pressed
  await expect(guitar).toHaveJSProperty("tagName", "BUTTON");
  await expect(guitar).toHaveAttribute("aria-pressed", "false");
  await expect(stage.locator("[data-jam-stage-solo-badge]")).toHaveCount(0);

  // click: only the guitar. Its tile is pressed with a visible mark, the others sit back, and so does the lane's own button agree
  await guitar.click();
  await expect(guitar).toHaveAttribute("aria-pressed", "true");
  await expect(guitar.locator("[data-jam-stage-solo-badge]")).toHaveText("Only this");
  await expect(bass).toHaveAttribute("data-dimmed", "true");
  await expect(drums).toHaveAttribute("data-dimmed", "true");
  await expect(guitar).not.toHaveAttribute("data-dimmed", "true");
  await expect(lane(seeded.band.tracks.guitar).locator("[data-jam-solo]")).toHaveAttribute("aria-pressed", "true");
  await expect(lane(seeded.band.tracks.bass).locator("[data-jam-solo]")).toHaveAttribute("aria-pressed", "false");

  // another tile moves the solo: only one is "only this"
  await bass.click();
  await expect(bass).toHaveAttribute("aria-pressed", "true");
  await expect(guitar).toHaveAttribute("aria-pressed", "false");
  await expect(lane(seeded.band.tracks.guitar).locator("[data-jam-solo]")).toHaveAttribute("aria-pressed", "false");

  // the same tile again clears it: everybody is back
  await bass.click();
  await expect(bass).toHaveAttribute("aria-pressed", "false");
  for (const tile of [guitar, bass, drums]) {
    await expect(tile).not.toHaveAttribute("data-dimmed", "true");
  }
  await expect(stage.locator("[data-jam-stage-solo-badge]")).toHaveCount(0);

  // keyboard: the tiles are in the tab order, Enter and Space toggle, and Space does not also play the song
  await drums.focus();
  await expect(drums).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(drums).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Enter");
  await expect(drums).toHaveAttribute("aria-pressed", "false");
  const before = await playButton(page, seeded.band.id).getAttribute("data-state");
  await page.keyboard.press("Space");
  await expect(drums).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Space");
  await expect(drums).toHaveAttribute("aria-pressed", "false");
  expect(await playButton(page, seeded.band.id).getAttribute("data-state"), "Space on a tile solos, it does not play").toBe(before);
  // Tab walks from tile to tile
  await guitar.focus();
  await page.keyboard.press("Tab");
  await expect(bass).toBeFocused();
  // a video tile shows the keyboard's ring too (it is a layer above the video, not a shadow under it)
  await expect(bass.locator("span.ring-focus-ring")).toHaveCSS("opacity", "1");
  await page.context().close();
});

test("a tile with no video draws a level that moves with that take's own sound while the song plays", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const page = await openAs(browser, seeded.host, `/app/server/${seeded.serverId}/channel/${seeded.jamId}/song/${seeded.plain}`);
  const panel = page.locator(`[data-jam-song="${seeded.plain}"]`);
  // a song with no video at all still has the mosaic, with one tile
  const tile = panel.locator("[data-jam-stage] [data-jam-stage-tile]");
  await expect(tile).toHaveCount(1, { timeout: 20_000 });
  await expect(tile).toHaveAttribute("data-jam-stage-kind", "audio");
  await expect(panel.locator("[data-jam-header]")).toHaveAttribute("data-jam-header", "compact");
  await expect(tile.locator("svg").first()).toBeVisible();
  const strip = () => tile.locator("[data-jam-stage-level] > span").evaluateAll((bars) => (bars as HTMLElement[]).map((bar) => bar.style.transform).join("|"));
  await expect(tile.locator("[data-jam-stage-level] > span")).toHaveCount(29);
  await expect(playButton(page, seeded.plain)).toBeEnabled({ timeout: 20_000 });
  const still = await strip();
  await playButton(page, seeded.plain).click();
  await expect(playButton(page, seeded.plain)).toHaveAttribute("data-state", "playing", { timeout: 15_000 });
  // the peaks are a second long each: the strip scrolls, so it differs a second and a half later, and again after that
  await expect.poll(strip, { timeout: 8000 }).not.toBe(still);
  const first = await strip();
  await expect.poll(strip, { timeout: 8000 }).not.toBe(first);
  // paused is still: the strip stops where the song stopped
  await playButton(page, seeded.plain).click();
  await expect(playButton(page, seeded.plain)).toHaveAttribute("data-state", "paused");
  const paused = await strip();
  await page.waitForTimeout(1500);
  expect(await strip()).toBe(paused);
  await page.context().close();
});

test("under reduced motion the level is a still picture of the take, not a moving strip", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const page = await openAs(browser, seeded.host, `/app/server/${seeded.serverId}/channel/${seeded.jamId}/song/${seeded.plain}`, undefined, async (preparing) => {
    await preparing.emulateMedia({ reducedMotion: "reduce" });
  });
  const tile = page.locator(`[data-jam-song="${seeded.plain}"] [data-jam-stage-tile]`);
  await expect(tile).toHaveCount(1, { timeout: 20_000 });
  const strip = () => tile.locator("[data-jam-stage-level] > span").evaluateAll((bars) => (bars as HTMLElement[]).map((bar) => bar.style.transform).join("|"));
  await expect(playButton(page, seeded.plain)).toBeEnabled({ timeout: 20_000 });
  const still = await strip();
  // not flat: the whole take as bars
  expect(new Set(still.split("|")).size).toBeGreaterThan(1);
  await playButton(page, seeded.plain).click();
  await expect(playButton(page, seeded.plain)).toHaveAttribute("data-state", "playing", { timeout: 15_000 });
  await page.waitForTimeout(2500);
  expect(await strip(), "a still picture does not move").toBe(still);
  await page.context().close();
});

test("the part a song asks for is one dashed tile in the mosaic for somebody who may add it, and it opens the studio on that instrument", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const page = await openAs(browser, seeded.guest, `/app/server/${seeded.serverId}/channel/${seeded.jamId}/song/${seeded.wanted}`);
  const panel = page.locator(`[data-jam-song="${seeded.wanted}"]`);
  const stage = panel.locator("[data-jam-stage]");
  await expect(stage.locator("[data-jam-stage-tile]")).toHaveCount(2, { timeout: 20_000 });
  await expect(stage.locator("[data-jam-stage-slot]")).toHaveCount(2);
  const vocals = stage.locator('[data-jam-stage-slot="vocals"]');
  await expect(vocals).toContainText("Your vocals here");
  await expect(stage.locator('[data-jam-stage-slot="bass"]')).toContainText("Your bass here");
  // dashed, in the instrument's colour
  expect(await vocals.locator(".border-dashed").evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe("dashed");
  // pressing it opens the studio over the song with the vocals chosen
  await vocals.click();
  await expect(page.locator('[data-jam-studio][data-phase="setup"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-jam-instrument="vocals"]')).toHaveAttribute("aria-checked", "true");
  await page.context().close();

  // a song that asks for nothing has no dashed tile
  const closed = await openAs(browser, seeded.host, `/app/server/${seeded.serverId}/channel/${seeded.jamId}/song/${seeded.band.id}`);
  const closedStage = closed.locator(`[data-jam-song="${seeded.band.id}"] [data-jam-stage]`);
  await expect(closedStage.locator("[data-jam-stage-tile]")).toHaveCount(3, { timeout: 20_000 });
  await expect(closedStage.locator("[data-jam-stage-slot]")).toHaveCount(0);
  await closed.context().close();
});

test("the stage goes full screen with its whole mosaic and comes back", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const page = await openAs(browser, seeded.host, `/app/server/${seeded.serverId}/channel/${seeded.jamId}/song/${seeded.band.id}`);
  const stage = page.locator(`[data-jam-song="${seeded.band.id}"] [data-jam-stage]`);
  await expect(stage.locator("[data-jam-stage-tile]")).toHaveCount(3, { timeout: 20_000 });
  const enter = stage.locator("[data-jam-stage-fullscreen]");
  await expect(enter).toHaveAttribute("aria-label", "Full screen");
  await enter.focus();
  await enter.click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.hasAttribute("data-jam-stage") ?? false)).toBe(true);
  await expect(enter).toHaveAttribute("aria-label", "Exit full screen");
  // every tile is still there, inside the screen, and the stage fills most of it
  const screen = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const grid = await box(stage.locator("[data-jam-stage-grid]"));
  expect(grid.width).toBeGreaterThan(screen.width * 0.5);
  expect(grid.y + grid.height).toBeLessThanOrEqual(screen.height + 1);
  await expect(stage.locator("[data-jam-stage-tile]")).toHaveCount(3);
  // a tile still solos in full screen
  const guitar = stage.locator(`[data-jam-stage-tile="${seeded.band.tracks.guitar}"]`);
  await guitar.click();
  await expect(guitar).toHaveAttribute("aria-pressed", "true");
  await enter.click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(enter).toHaveAttribute("aria-label", "Full screen");
  await page.context().close();
});

test("a song with one recording is one large tile, and a song with no take has a normal header and no stage", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const one = await openAs(browser, seeded.host, `/app/server/${seeded.serverId}/channel/${seeded.jamId}/song/${seeded.solo}`);
  const stage = one.locator(`[data-jam-song="${seeded.solo}"] [data-jam-stage]`);
  await expect(stage.locator("[data-jam-stage-tile]")).toHaveCount(1, { timeout: 20_000 });
  const panelBox = await box(one.locator(`[data-jam-song="${seeded.solo}"]`));
  const tileBox = await box(stage.locator("[data-jam-stage-tile]"));
  expect(tileBox.width, "one tile takes the panel's width (less its padding)").toBeGreaterThan(panelBox.width * 0.7);
  await one.context().close();

  // a song its author has made and not yet sent a take to: no stage, the full header
  const { song: empty } = await call<{ song: { id: string } }>(seeded.host, "POST", `/api/channels/${seeded.jamId}/jam-songs`, { title: "Sem faixa" });
  const none = await openAs(browser, seeded.host, `/app/server/${seeded.serverId}/channel/${seeded.jamId}/song/${empty.id}`);
  const panel = none.locator(`[data-jam-song="${empty.id}"]`);
  await expect(panel.locator("[data-jam-empty-song]")).toBeVisible({ timeout: 20_000 });
  await expect(panel.locator("[data-jam-stage]")).toHaveCount(0);
  await expect(panel.locator("[data-jam-header]")).toHaveAttribute("data-jam-header", "full");
  await none.context().close();
});

for (const [label, viewport, oneLine] of [
  ["a wide panel is one line per lane", { width: 1700, height: 900 }, true],
  ["a narrower panel wraps the lane to two lines", { width: 1440, height: 900 }, false],
  ["a phone wraps the lane to two lines", { width: 390, height: 844 }, false],
] as const) {
  test(`${label}, and nothing is ever drawn over a lane's name`, async ({ browser }) => {
    const seeded = await seed();
    test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
    // the host owns the drums: that lane has "Ajustar"
    const page = await openAs(browser, seeded.host, `/app/server/${seeded.serverId}/channel/${seeded.jamId}/song/${seeded.band.id}`, viewport);
    const panel = page.locator(`[data-jam-song="${seeded.band.id}"]`);
    await expect(panel.locator("[data-jam-track]")).toHaveCount(3, { timeout: 20_000 });
    const lane = panel.locator(`[data-jam-track="${seeded.band.tracks.drums}"]`);
    const adjust = lane.locator("[data-jam-adjust-open]");
    await expect(adjust).toBeVisible();
    // an icon with a name, not a pill with a word
    await expect(adjust).toHaveAttribute("aria-label", "Adjust my recording");
    expect((await adjust.innerText()).trim()).toBe("");

    for (const row of await panel.locator("[data-jam-track]").all()) {
      const name = await box(row.locator("[data-jam-lane-name]"));
      expect(name.width, "the name column has width").toBeGreaterThan(40);
      const controls = await row.locator("[data-jam-lane-controls] button, [data-jam-lane-controls] [role=img], [data-jam-lane-controls] [role=slider]").all();
      expect(controls.length).toBeGreaterThan(2);
      for (const control of controls) {
        expect(boxesOverlap(name, await box(control)), "no control is drawn over the name").toBe(false);
      }
      // the name is cut with an ellipsis, never into the waveform
      const wave = await box(row.locator("[data-jam-wave]"));
      expect(boxesOverlap(name, wave), "the waveform does not run under the name").toBe(false);
      for (const control of controls) {
        expect(boxesOverlap(wave, await box(control)), "no control is drawn over the waveform").toBe(false);
      }
      // one line or two
      if (oneLine) {
        expect(wave.y, "the waveform is on the name's line").toBeLessThan(name.y + name.height);
        expect(wave.x).toBeGreaterThan(name.x + name.width - 1);
        expect(name.width, "the name column is about 160 px, badge included").toBeLessThanOrEqual(170);
        expect(wave.height).toBeGreaterThanOrEqual(46);
        expect(wave.height).toBeLessThanOrEqual(58);
      } else {
        expect(wave.y, "the waveform is under the name").toBeGreaterThanOrEqual(name.y + name.height - 1);
      }
    }
    // no sideways scroll, on a phone above all
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // "Ajustar" opens the editor on that lane, and saving the level closes it
    await adjust.click();
    await expect(lane.locator(`[data-jam-adjust="${seeded.band.tracks.drums}"]`)).toBeVisible();
    await adjust.click();
    await page.context().close();
  });
}

test("the waveform is not a slab of one colour: a surface, bars in the instrument's colour, the played part stronger", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const page = await openAs(browser, seeded.host, `/app/server/${seeded.serverId}/channel/${seeded.jamId}/song/${seeded.plain}`);
  const wave = page.locator(`[data-jam-song="${seeded.plain}"] [data-jam-wave]`).first();
  await expect(wave).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => wave.locator("span[style*='height']").count(), { timeout: 10_000 }).toBeGreaterThan(8);
  const colours = await wave.evaluate((element) => {
    const lane = getComputedStyle(element).backgroundColor;
    const bar = getComputedStyle(element.querySelector("span[style*='height']")!).backgroundColor;
    return { lane, bar };
  });
  expect(colours.bar, "the bars are drawn in a colour of their own").not.toBe(colours.lane);
  // the lane's own box is the quiet surface, which is not the bar colour and not transparent
  expect(colours.lane).not.toBe("rgba(0, 0, 0, 0)");
  // the sentence that used to sit above the ruler is a tooltip now, not a line of the page
  await expect(page.getByText("change only what you hear")).toHaveCount(0);
  await page.context().close();
});

test("in the studio's review the lane's name is never overlapped by 'Ajustar', which is an icon", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const page = await openAs(browser, seeded.guest, `/app/server/${seeded.serverId}/channel/${seeded.jamId}/song/${seeded.plain}`);
  await page.locator("[data-jam-record-over]").click();
  await expect(page.locator('[data-jam-studio][data-phase="setup"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-jam-latency-chip]")).toBeVisible({ timeout: 20_000 });
  const skip = page.locator("[data-jam-skip-check]");
  if (await skip.isVisible()) {
    await skip.click();
  }
  const record = page.locator("[data-jam-record]");
  await expect(record).toBeEnabled({ timeout: 20_000 });
  await record.click();
  await expect(page.locator("[data-jam-stop]")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(2500);
  await page.locator("[data-jam-stop]").click();
  await expect(page.locator('[data-jam-studio][data-phase="review"]')).toBeVisible({ timeout: 30_000 });

  const mine = page.locator("[data-jam-your-lane]");
  const name = await box(mine.locator("[data-jam-lane-name]"));
  const adjust = mine.locator("[data-jam-edit-open]");
  await expect(adjust).toBeVisible();
  expect((await adjust.innerText()).trim(), "an icon, no word").toBe("");
  await expect(adjust).toHaveAttribute("aria-label", "Adjust my recording");
  expect(boxesOverlap(name, await box(adjust))).toBe(false);
  expect(boxesOverlap(name, await box(mine.locator("[data-jam-wave]")))).toBe(false);
  // the same lane is a quiet surface with bars, not a block of colour
  await expect(mine.locator("[data-jam-wave]")).toBeVisible();
  // Ajustar opens the editor
  await adjust.click();
  await expect(page.locator('[data-jam-edit][data-open="true"]')).toBeVisible();
  await page.context().close();
});
