/**
 * THE JAM'S POLISH, WITH REAL CLICKS AND REAL KEYS: what the three usability
 * testers tripped on that a unit test cannot see.
 *
 *  - Opening a song from its card plays it (so does the card's round button,
 *    which also pauses it). The panel takes keyboard focus when it opens, Space
 *    plays and pauses from anywhere that is not a field or a control, and closing
 *    the panel hands focus back to the card. (`jam-stage.spec.ts` has the click
 *    and the Space on the wall in full.)
 *  - The studio takes focus when it opens and gives it back when it closes.
 *  - A cover that is a text file renamed `.jpg`, or a 40 px square, is refused
 *    in words BEFORE the crop step; a transparent PNG is flattened onto a light
 *    colour, not black.
 *  - Removing a cover leaves the tile with the band's bars, not a flat box.
 *
 * The audio is a short WAV declared as `audio/mpeg`: the server never decodes
 * audio (it checks the declared type and size), and the browser decodes by the
 * bytes, so a generated tone is a real track without ffmpeg.
 *
 * Needs object storage like `jam-web.spec.ts` (`S3_*` exported); without it the
 * spec skips with that reason.
 */
import { deflateSync } from "node:zlib";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { bandOpenByDefault } from "./jam-band-open";
import { E2E_ADMIN_TOKEN } from "../playwright.config";
import { FAKE_MIC_WAV } from "../playwright.jam.config";

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const RUN = Date.now().toString(36);
const HOST = `polishhost${RUN}`;

test.setTimeout(150_000);
test.use({
  viewport: { width: 1440, height: 900 },
  colorScheme: "dark",
  permissions: ["microphone", "camera"],
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${FAKE_MIC_WAV}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  },
});

const headersFor = (suffix: string) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
});

async function call<T>(suffix: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: headersFor(suffix),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${await response.text()}`);
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

/** Two seconds of a quiet tone as a 16-bit mono WAV. */
function wav(): Buffer {
  const rate = 8000;
  const samples = rate * 2;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 220) * 6000), i * 2);
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

/** A flat-colour RGBA PNG; `alpha` 0 is fully transparent. No dependency. */
function png(width: number, height: number, alpha = 255): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(6, 9);
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 4] = 200;
      row[2 + x * 4] = 30;
      row[3 + x * 4] = 30;
      row[4 + x * 4] = alpha;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

interface Seeded {
  serverId: string;
  jamId: string;
  songId: string;
  secondSongId: string;
  uploads: boolean;
}

async function putAudio(songId: string): Promise<string> {
  const bytes = wav();
  const ticket = await call<{ uploadId: string; uploadUrl: string }>(HOST, "POST", `/api/jam-songs/${songId}/uploads`, {
    kind: "audio",
    contentType: "audio/mpeg",
    byteSize: bytes.length,
  });
  const put = await fetch(ticket.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "audio/mpeg", "Content-Length": String(bytes.length) },
    body: bytes,
  });
  expect(put.ok).toBe(true);
  return ticket.uploadId;
}

async function seed(): Promise<Seeded> {
  await materialise(HOST);
  const { server } = await call<{ server: { id: string } }>(HOST, "POST", "/api/servers", { name: `Polimento ${Date.now()}` });
  const flip = await fetch(`${API}/api/admin/flag-overrides`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${E2E_ADMIN_TOKEN}` },
    body: JSON.stringify({ key: "jam_channels", serverId: server.id, enabled: true }),
  });
  expect(flip.status).toBe(200);
  const { channel } = await call<{ channel: { id: string } }>(HOST, "POST", `/api/servers/${server.id}/channels`, { name: "jam", type: "jam" });
  const config = await call<{ uploads: boolean }>(HOST, "GET", `/api/jam/config?serverId=${server.id}`);
  const ids: string[] = [];
  for (const title of ["Primeira", "Segunda"]) {
    const { song } = await call<{ song: { id: string } }>(HOST, "POST", `/api/channels/${channel.id}/jam-songs`, { title });
    if (config.uploads) {
      const audioUploadId = await putAudio(song.id);
      await call(HOST, "POST", `/api/jam-songs/${song.id}/tracks`, {
        instrument: "guitar",
        audioUploadId,
        durationMs: 2000,
        peaks: [0.2, 0.6, 0.9, 0.5, 0.3],
      });
    }
    ids.push(song.id);
  }
  return { serverId: server.id, jamId: channel.id, songId: ids[0]!, secondSongId: ids[1]!, uploads: config.uploads };
}

async function openAs(browser: Browser, suffix: string, path: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", permissions: ["microphone", "camera"] });
  await bandOpenByDefault(context);
  const page = await context.newPage();
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(`${path}${path.includes("?") ? "&" : "?"}lang=en`);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
  return page;
}

const inside = (page: Page, selector: string) =>
  page.evaluate((css) => Boolean(document.activeElement?.closest(css)), selector);

test("a card opens its song and plays it; the round button pauses; the keyboard goes into the song, Space plays, and Escape gives focus back", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const jamPath = `/app/server/${seeded.serverId}/channel/${seeded.jamId}`;
  const page = await openAs(browser, HOST, jamPath);

  const first = page.locator(`[data-jam-tile="${seeded.songId}"]`);
  const second = page.locator(`[data-jam-tile="${seeded.secondSongId}"]`);
  await expect(first).toBeVisible({ timeout: 20_000 });

  // The round button is its own control, reachable by name, apart from the card.
  await expect(first.locator("[data-jam-open]")).toBeVisible();
  await expect(first.getByRole("button", { name: "Play Primeira" })).toBeVisible();

  // Opening from the card (by keyboard: focus, Enter) starts the song.
  await first.locator("[data-jam-open]").focus();
  await page.keyboard.press("Enter");
  const panel = page.locator(`[data-jam-song="${seeded.songId}"]`);
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel.locator("[data-jam-play]")).toHaveAttribute("data-state", "playing", { timeout: 20_000 });
  await expect(first).toHaveAttribute("data-playing", "true");

  // The keyboard is IN the song now: no hunt through the wall to reach it.
  expect(await inside(page, "[data-jam-song]")).toBe(true);

  // Space plays and pauses when focus is not on a control or in a field.
  await expect(panel.locator("[data-jam-play]")).toBeEnabled({ timeout: 20_000 });
  await page.keyboard.press("Space");
  await expect(panel.locator("[data-jam-play]")).toHaveAttribute("data-state", "paused", { timeout: 10_000 });
  await page.keyboard.press("Space");
  await expect(panel.locator("[data-jam-play]")).toHaveAttribute("data-state", "playing");

  // Escape closes it and the card that opened it has focus again.
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(first.locator("[data-jam-open]")).toBeFocused();

  // The round button of ANOTHER card opens that song and plays it.
  await second.locator("[data-jam-tile-play]").click();
  const secondPanel = page.locator(`[data-jam-song="${seeded.secondSongId}"]`);
  await expect(secondPanel).toBeVisible({ timeout: 20_000 });
  await expect(secondPanel.locator("[data-jam-play]")).toHaveAttribute("data-state", "playing", { timeout: 15_000 });
  await expect(second).toHaveAttribute("data-playing", "true");

  await page.context().close();
});

test("the studio takes focus when it opens and hands it back when it closes", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const page = await openAs(browser, HOST, `/app/server/${seeded.serverId}/channel/${seeded.jamId}/song/${seeded.songId}`);
  const record = page.locator("[data-jam-record-over]");
  await expect(record).toBeVisible({ timeout: 20_000 });
  await record.focus();
  await page.keyboard.press("Enter");
  const studio = page.locator("[data-jam-studio]");
  await expect(studio).toBeVisible();
  // Focus is inside the studio, not dropped to the page behind it.
  await expect.poll(() => inside(page, "[data-jam-studio]")).toBe(true);
  // The first Tab lands on the studio's own first control, not on the page.
  await page.keyboard.press("Tab");
  expect(await inside(page, "[data-jam-studio]")).toBe(true);
  await page.keyboard.press("Escape");
  await expect(studio).toHaveCount(0);
  await expect(record).toBeFocused();
  await page.context().close();
});

test("a text file renamed .jpg and a 40 px square are refused in words before the crop step; a transparent PNG is flattened, not black", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const page = await openAs(browser, HOST, `/app/server/${seeded.serverId}/channel/${seeded.jamId}/song/${seeded.songId}`);
  await expect(page.locator(`[data-jam-song="${seeded.songId}"]`)).toBeVisible({ timeout: 20_000 });
  await page.locator("[data-jam-edit-open]").click();
  const note = page.locator("[data-jam-edit-note]");

  await page.locator("[data-jam-edit-file]").setInputFiles({ name: "nao-e-foto.jpg", mimeType: "image/jpeg", buffer: Buffer.from("this is only text") });
  await expect(note).toContainText("cannot open that image");
  await expect(page.locator("[data-crop-frame]")).toHaveCount(0);

  await page.locator("[data-jam-edit-file]").setInputFiles({ name: "minuscula.png", mimeType: "image/png", buffer: png(40, 40) });
  await expect(note).toContainText("too small");
  await expect(note).toContainText("400");
  await expect(page.locator("[data-crop-frame]")).toHaveCount(0);

  // A fully transparent picture: its clear pixels become a light colour in the JPEG.
  await page.locator("[data-jam-edit-file]").setInputFiles({ name: "vazada.png", mimeType: "image/png", buffer: png(640, 640, 0) });
  await expect(page.locator("[data-crop-frame]")).toBeVisible();
  await page.locator("[data-crop-save]").click();
  const preview = page.locator("[data-jam-edit-preview]");
  await expect(preview).toBeVisible({ timeout: 20_000 });
  const corner = await preview.evaluate(async (img: HTMLImageElement) => {
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(img, 0, 0);
    return Array.from(context.getImageData(10, 10, 1, 1).data);
  });
  expect(Math.min(corner[0]!, corner[1]!, corner[2]!)).toBeGreaterThan(200);
  await page.context().close();
});

test("removing a cover leaves the tile with the band's bars, not a flat box", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const jamPath = `/app/server/${seeded.serverId}/channel/${seeded.jamId}`;
  const page = await openAs(browser, HOST, `${jamPath}/song/${seeded.songId}`);
  await expect(page.locator(`[data-jam-song="${seeded.songId}"]`)).toBeVisible({ timeout: 20_000 });
  await page.locator("[data-jam-edit-open]").click();
  await page.locator("[data-jam-edit-file]").setInputFiles({ name: "capa.png", mimeType: "image/png", buffer: png(640, 640) });
  await page.locator("[data-crop-save]").click();
  await expect(page.locator("[data-jam-edit-preview]")).toBeVisible({ timeout: 20_000 });
  await page.locator("[data-jam-edit-save]").click();
  await expect(page.locator("[data-jam-edit]")).toHaveCount(0);

  const tile = page.locator(`[data-jam-tile="${seeded.songId}"]`);
  await expect(tile).toHaveAttribute("data-jam-tile-cover", "", { timeout: 15_000 });

  await page.locator("[data-jam-edit-open]").click();
  await page.locator("[data-jam-edit-remove]").click();
  await page.locator("[data-jam-edit-save]").click();
  await expect(page.locator("[data-jam-edit]")).toHaveCount(0);
  await expect(tile).not.toHaveAttribute("data-jam-tile-cover", "", { timeout: 15_000 });
  // the band: lanes with their waveform bars (the bars are measured once the band is on screen)
  await expect.poll(() => tile.locator("[data-jam-band-art] span[style*='height']").count(), { timeout: 10_000 }).toBeGreaterThan(0);
  await page.context().close();
});
