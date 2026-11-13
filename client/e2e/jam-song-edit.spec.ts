/**
 * EDITING A SONG: its name, its artist and its cover photo, with real clicks,
 * and a second person watching the wall.
 *
 * The author opens a song from the wall, presses "Edit song", types a new name
 * and artist, picks a photo (the real file input, the real crop step, a real PUT
 * to the object store), saves, and a SECOND account that has the wall open sees
 * the new name and the photo on the song's tile with no reload (the
 * `jam-song-updated` frame). Then the photo is removed and the tile goes back to
 * the band. What the second person may NOT do is checked too: no edit control for
 * a member who did not write the song, and a refusal from the server (a 403 on
 * the write) is said in words and leaves the sheet open instead of throwing.
 *
 * Needs object storage like `jam-web.spec.ts` (`docker compose --profile storage
 * up -d minio minio-init`, then export `S3_*`: the webServer environment is
 * passed through, see `playwright.config.ts`); without it the config says
 * `uploads: false` and the spec skips with that reason.
 */
import { deflateSync } from "node:zlib";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { bandOpenByDefault } from "./jam-band-open";
import { E2E_ADMIN_TOKEN } from "../playwright.config";
import { addApiTrack } from "./jam-api-track";

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const RUN = Date.now().toString(36);
const HOST = `editauthor${RUN}`;
const GUEST = `editguest${RUN}`;

test.setTimeout(120_000);
test.use({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });

const headersFor = (suffix: string) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
});

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

/** A small RGBA PNG: a gradient, so the crop has something to frame. No dependency. */
function png(width: number, height: number): Buffer {
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
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(6, 9); // RGBA
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 4] = Math.round((x / width) * 255);
      row[2 + x * 4] = Math.round((y / height) * 200);
      row[3 + x * 4] = 120;
      row[4 + x * 4] = 255;
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
  uploads: boolean;
}

async function seed(): Promise<Seeded> {
  await materialise(HOST);
  await materialise(GUEST);
  const { server } = await call<{ server: { id: string } }>(HOST, "POST", "/api/servers", { name: `Capa ${Date.now()}` });
  const { invite } = await call<{ invite: { code: string } }>(HOST, "POST", `/api/servers/${server.id}/invites`, {});
  await call(GUEST, "POST", `/api/invites/${invite.code}/join`);
  const flip = await fetch(`${API}/api/admin/flag-overrides`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${E2E_ADMIN_TOKEN}` },
    body: JSON.stringify({ key: "jam_channels", serverId: server.id, enabled: true }),
  });
  expect(flip.status).toBe(200);
  const { channel } = await call<{ channel: { id: string } }>(HOST, "POST", `/api/servers/${server.id}/channels`, {
    name: "jam",
    type: "jam",
  });
  const config = await call<{ uploads: boolean }>(HOST, "GET", `/api/jam/config?serverId=${server.id}`);
  const { song } = await call<{ song: { id: string } }>(HOST, "POST", `/api/channels/${channel.id}/jam-songs`, {
    title: "Antes da Capa",
    artist: "Banda Velha",
  });
  // On everybody's wall once it has a take (a song with none is its author's alone).
  if (config.uploads) {
    await addApiTrack(API, HOST, song.id, "guitar");
  }
  return { serverId: server.id, jamId: channel.id, songId: song.id, uploads: config.uploads };
}

async function openAs(browser: Browser, suffix: string, path: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await bandOpenByDefault(context);
  const page = await context.newPage();
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(`${path}${path.includes("?") ? "&" : "?"}lang=en`);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
  return page;
}

test("the author edits the name, artist and cover; a second account sees it on the wall, live", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const jamPath = `/app/server/${seeded.serverId}/channel/${seeded.jamId}`;

  // The guest has the wall open before anything changes.
  const guest = await openAs(browser, GUEST, jamPath);
  const guestTile = guest.locator(`[data-jam-tile="${seeded.songId}"]`);
  await expect(guestTile).toContainText("Antes da Capa", { timeout: 20_000 });
  await expect(guestTile).not.toHaveAttribute("data-jam-tile-cover", "");

  // A member who did not write the song is offered no edit, on the tile's panel either.
  await guestTile.click();
  await expect(guest.locator(`[data-jam-song="${seeded.songId}"]`)).toBeVisible({ timeout: 20_000 });
  await expect(guest.locator("[data-jam-edit-open]")).toHaveCount(0);
  await expect(guest.locator("[data-jam-cover-edit]")).toHaveCount(0);
  await guest.getByRole("button", { name: "Close", exact: true }).first().click();

  // The author: open the song, press Edit, change the words and pick a photo.
  const host = await openAs(browser, HOST, `${jamPath}/song/${seeded.songId}`);
  await expect(host.locator(`[data-jam-song="${seeded.songId}"]`)).toBeVisible({ timeout: 20_000 });
  await host.locator("[data-jam-edit-open]").click();
  const sheet = host.locator("[data-jam-edit]");
  await expect(sheet).toBeVisible();
  await expect(host.locator("[data-jam-edit-title]")).toHaveValue("Antes da Capa");
  // Nothing changed yet: Save waits.
  await expect(host.locator("[data-jam-edit-save]")).toBeDisabled();
  await host.locator("[data-jam-edit-title]").fill("Depois da Capa");
  await host.locator("[data-jam-edit-artist]").fill("Os Cometas");
  await expect(host.locator("[data-jam-edit-save]")).toBeEnabled();

  // The photo: the real file input, then the crop step, then the real PUT.
  await host.locator("[data-jam-edit-file]").setInputFiles({ name: "capa.png", mimeType: "image/png", buffer: png(640, 480) });
  await expect(host.locator("[data-crop-frame]")).toBeVisible();
  await host.locator("[data-crop-save]").click();
  await expect(host.locator("[data-jam-edit-preview]")).toBeVisible({ timeout: 20_000 });
  await expect(host.locator("[data-jam-edit-stage]")).toHaveAttribute("data-state", "new");
  await host.locator("[data-jam-edit-save]").click();
  await expect(sheet).toHaveCount(0);

  // The author's own panel and wall.
  await expect(host.locator(`[data-jam-song="${seeded.songId}"] h2`)).toHaveText("Depois da Capa");
  await expect(host.locator(`[data-jam-song="${seeded.songId}"] [data-jam-cover-photo-on]`)).toBeVisible();
  const cover = host.locator(`[data-jam-song="${seeded.songId}"] [data-jam-cover] img`);
  await expect(cover).toBeVisible();
  expect(await cover.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  // The guest, with no reload: the new name and the photo, on the tile.
  await expect(guestTile).toContainText("Depois da Capa", { timeout: 15_000 });
  await expect(guestTile).toContainText("Os Cometas");
  await expect(guestTile).toHaveAttribute("data-jam-tile-cover", "");
  const tilePhoto = guestTile.locator("img[data-jam-cover-photo]");
  await expect(tilePhoto).toHaveAttribute("data-ready", "true", { timeout: 15_000 });
  expect(await tilePhoto.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  // The stored picture is a 1024 square JPEG (the crop ran in the browser).
  expect(await tilePhoto.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([1024, 1024]);

  // A server refusal is said in words and the sheet stays: the edit rule is the server's.
  await host.route(`**/api/jam-songs/${seeded.songId}`, async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "You cannot edit this song" }) });
      return;
    }
    await route.fallback();
  });
  await host.locator("[data-jam-edit-open]").click();
  await host.locator("[data-jam-edit-title]").fill("Nao vai");
  await host.locator("[data-jam-edit-save]").click();
  await expect(host.locator("[data-jam-edit-error]")).toHaveText("You cannot edit this song.");
  await expect(host.locator("[data-jam-edit]")).toBeVisible();
  await host.unroute(`**/api/jam-songs/${seeded.songId}`);
  await host.locator("[data-jam-edit-title]").fill("Depois da Capa");

  // Take the photo off: the tile goes back to the band, on the guest's wall too.
  await host.locator("[data-jam-edit-remove]").click();
  await expect(host.locator("[data-jam-edit-stage]")).toHaveAttribute("data-state", "empty");
  await host.locator("[data-jam-edit-save]").click();
  await expect(host.locator("[data-jam-edit]")).toHaveCount(0);
  await expect(guestTile).not.toHaveAttribute("data-jam-tile-cover", "", { timeout: 15_000 });
  await expect(guestTile).toContainText("Depois da Capa");

  await host.context().close();
  await guest.context().close();
});

test("a moderator who did not write the song can edit it, and a photo that is not a picture is refused in words", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  // The server's owner holds every permission, so they are a moderator of a song the guest wrote.
  const { song } = await call<{ song: { id: string } }>(GUEST, "POST", `/api/channels/${seeded.jamId}/jam-songs`, {
    title: "Da Visita",
  });
  await addApiTrack(API, GUEST, song.id, "guitar");
  const owner = await openAs(browser, HOST, `/app/server/${seeded.serverId}/channel/${seeded.jamId}/song/${song.id}`);
  await expect(owner.locator(`[data-jam-song="${song.id}"]`)).toBeVisible({ timeout: 20_000 });
  await owner.locator("[data-jam-edit-open]").click();
  await owner.locator("[data-jam-edit-file]").setInputFiles({ name: "nota.txt", mimeType: "text/plain", buffer: Buffer.from("not a picture") });
  await expect(owner.locator("[data-jam-edit-note]")).toHaveText("Pick a JPG, PNG or WebP image.");
  await owner.locator("[data-jam-edit-title]").fill("Da Visita (moderada)");
  await owner.locator("[data-jam-edit-save]").click();
  await expect(owner.locator(`[data-jam-song="${song.id}"] h2`)).toHaveText("Da Visita (moderada)");
  await owner.context().close();
});
