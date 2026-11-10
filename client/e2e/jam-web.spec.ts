/**
 * THE JAM, THE WHOLE WAY: one person starts a song, another opens it from the
 * wall in three taps, records over it, posts with no edits, and both walls show
 * two tracks, in real Chromium against the real API and the real object store.
 *
 * What the fake devices are. Chromium runs with a fake microphone playing a
 * sweep every second (`playwright.jam.config.ts` writes the file) and a fake
 * camera, so the studio opens, meters, counts in, records, encodes FLAC and
 * uploads exactly as it does with a real instrument. What it cannot be is a
 * musician: a fake device has no hardware latency and does not hear the
 * speakers, so the engine's own proof of sample-accurate placement stays in
 * `e2e/jam/` (`pnpm e2e:jam`). THIS spec proves that the screens hand the
 * engine's placement to the server unchanged: with no edits, a take posted over
 * a song starts, audibly, at song time 0 (the count-in hidden by its trim, the
 * measured delay folded into its offset), the same place the first track of the
 * song starts, to a millisecond.
 *
 * Needs object storage (`docker compose --profile storage up -d minio
 * minio-init`, then export `S3_*`: the webServer environment is passed through,
 * see `playwright.config.ts`). Without it the config says `uploads: false` and
 * this spec skips with that reason.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";
import { FAKE_MIC_WAV } from "../playwright.jam.config";

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
// Fresh accounts every run: song creation is rate limited per person (10 per 10 minutes).
const RUN = Date.now().toString(36);
const HOST = `jamhost${RUN}`;
const GUEST = `jamguest${RUN}`;
// The volume and camera specs at the end have accounts of their own: the first
// pair already creates ten songs in this file, which is the limit for ten minutes.
const HOST_B = `jamhostb${RUN}`;
const GUEST_B = `jamguestb${RUN}`;
/** One bar of four beats at the studio's default 100 BPM. */
const COUNT_IN_MS = 2400;

test.setTimeout(180_000);
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
  trace: "off",
});

function headersFor(suffix: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${DEV_TOKEN}:${suffix}` };
}

async function materialise(suffix: string): Promise<void> {
  const headers = headersFor(suffix);
  const me = await fetch(`${API}/api/me`, { headers });
  const body = (await me.json()) as { ageGate?: string };
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
    body: JSON.stringify({
      onboardedAt: new Date().toISOString(),
      firstRunDismissedAt: new Date().toISOString(),
    }),
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
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

interface Seeded {
  serverId: string;
  jamId: string;
  uploads: boolean;
}

async function seed(host = HOST, guest = GUEST): Promise<Seeded> {
  await materialise(host);
  await materialise(guest);
  const { server } = await call<{ server: { id: string } }>(host, "POST", "/api/servers", {
    name: `Garagem ${Date.now()}`,
  });
  const { invite } = await call<{ invite: { code: string } }>(host, "POST", `/api/servers/${server.id}/invites`, {});
  await call(guest, "POST", `/api/invites/${invite.code}/join`);
  // The operator turns Jam on for THIS server only, the way the dashboard does
  // (a per-server override of `jam_channels`). It is off everywhere else, which
  // keeps every other spec's add menus exactly as they were.
  const flip = await fetch(`${API}/api/admin/flag-overrides`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${E2E_ADMIN_TOKEN}` },
    body: JSON.stringify({ key: "jam_channels", serverId: server.id, enabled: true }),
  });
  expect(flip.status).toBe(200);
  const { channel } = await call<{ channel: { id: string } }>(host, "POST", `/api/servers/${server.id}/channels`, {
    name: "jam",
    type: "jam",
  });
  const config = await call<{ enabled: boolean; uploads: boolean }>(host, "GET", `/api/jam/config?serverId=${server.id}`);
  expect(config.enabled, "the per-server override turned it on").toBe(true);
  return { serverId: server.id, jamId: channel.id, uploads: config.uploads };
}

async function openAs(browser: Browser, suffix: string, path: string): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    permissions: ["microphone", "camera"],
  });
  const page = await context.newPage();
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(`${path}${path.includes("?") ? "&" : "?"}lang=en`);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
  return page;
}

/** Counts the taps a flow needs: every click on the way goes through here. */
function tapper() {
  let taps = 0;
  return {
    get count() {
      return taps;
    },
    async tap(target: ReturnType<Page["locator"]>) {
      taps += 1;
      await target.click();
    },
  };
}

interface ApiTrack {
  id: string;
  authorId: string;
  offsetMs: number;
  trimStartMs: number;
  trimEndMs: number;
  durationMs: number;
  inMix: boolean;
  gain: number;
  createdAt: string;
}

async function skipTheLatencyCheck(page: Page): Promise<void> {
  // The first recording on a pair of devices suggests measuring the round trip
  // (a suggestion: the record button works either way); "Agora não" is a real,
  // supported answer ("use the estimate"). The header chip says the delay is known.
  const skip = page.locator("[data-jam-skip-check]");
  await expect(page.locator("[data-jam-latency-chip]")).toBeVisible({ timeout: 20_000 });
  if (await skip.isVisible()) {
    await skip.click();
  }
}

/** "Teu som": input, count-in and the delay card live behind one button (the camera does not: it is on the setup step). */
async function openSound(page: Page): Promise<void> {
  await page.locator("[data-jam-sound]").click();
  await expect(page.locator("[data-jam-sound-panel]")).toBeVisible();
}

async function closeSound(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-jam-sound-panel]")).toHaveCount(0);
}

async function recordAndStop(page: Page, seconds: number): Promise<void> {
  const record = page.locator("[data-jam-record]");
  await expect(record).toBeEnabled({ timeout: 20_000 });
  await record.click();
  await expect(page.locator("[data-jam-stop]")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(seconds * 1000);
  await page.locator("[data-jam-stop]").click();
}

test("one person starts a song, another records over it from the wall in three taps, and both walls show two tracks", async ({
  browser,
}) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const jamPath = `/app/server/${seeded.serverId}/channel/${seeded.jamId}`;

  // ---- the host starts a song on an empty wall -------------------------------
  const host = await openAs(browser, HOST, jamPath);
  await expect(host.locator("[data-jam-empty]")).toBeVisible({ timeout: 20_000 });
  await host.locator("[data-jam-empty-record]").click();
  await host.locator("[data-jam-start-title]").fill("In Bloom");
  await host.getByLabel("Artist (leave empty if it is yours)").fill("Nirvana");
  await host.locator("[data-jam-start-go]").click();
  await expect(host.locator('[data-jam-studio][data-phase="setup"]')).toBeVisible({ timeout: 20_000 });
  await skipTheLatencyCheck(host);
  await recordAndStop(host, 4);
  await expect(host.locator('[data-jam-studio][data-phase="review"]')).toBeVisible({ timeout: 20_000 });
  await host.locator("[data-jam-post]").click();
  await expect(host.locator("[data-jam-done]")).toBeVisible({ timeout: 60_000 });
  await host.locator("[data-jam-done-action]").click();
  await expect(host.locator("[data-jam-song]")).toBeVisible();
  await expect(host.locator("[data-jam-track]")).toHaveCount(1);

  // ---- the guest: Jam row, tile, "Gravar por cima" ---------------------------
  const guest = await openAs(browser, GUEST, `/app/server/${seeded.serverId}`);
  const taps = tapper();
  await taps.tap(guest.locator("[data-jam-row]").first()); // 1: the Jam row
  await expect(guest.locator("[data-jam-tile]")).toHaveCount(1, { timeout: 20_000 });
  await taps.tap(guest.locator("[data-jam-tile]").first()); // 2: the song
  await expect(guest.locator("[data-jam-track]")).toHaveCount(1, { timeout: 20_000 });
  await taps.tap(guest.locator("[data-jam-record-over]")); // 3: record on top
  await expect(guest.locator("[data-jam-studio]")).toBeVisible();
  expect(taps.count, "server to the studio over an existing song").toBe(3);
  // pre-selected: the song is open to anything, so the picker starts on a free instrument
  await expect(guest.locator('[data-jam-instrument][aria-checked="true"]')).toHaveCount(1);

  await skipTheLatencyCheck(guest);
  await openSound(guest);
  await expect(guest.locator("[data-jam-latency]")).toContainText(/\d+ ms/);
  await closeSound(guest);
  await expect(guest.locator("[data-jam-studio]")).toBeVisible(); // Escape closed the dialog, not the studio
  await recordAndStop(guest, 4);
  await expect(guest.locator('[data-jam-studio][data-phase="review"]')).toBeVisible({ timeout: 20_000 });
  // posting after stopping: one tap, no edits
  const postTaps = tapper();
  await postTaps.tap(guest.locator("[data-jam-post]"));
  expect(postTaps.count).toBe(1);
  await expect(guest.locator("[data-jam-done]")).toBeVisible({ timeout: 60_000 });
  await guest.locator("[data-jam-done-action]").click();

  // ---- both walls show two tracks, the host's without a reload ---------------
  await expect(guest.locator("[data-jam-track]")).toHaveCount(2, { timeout: 20_000 });
  await expect(host.locator("[data-jam-track]")).toHaveCount(2, { timeout: 20_000 });

  // ---- what the server stored is the engine's placement, unedited ------------
  const list = await call<{ songs: { id: string; trackCount: number }[] }>(
    HOST,
    "GET",
    `/api/channels/${seeded.jamId}/jam-songs`,
  );
  expect(list.songs).toHaveLength(1);
  expect(list.songs[0]?.trackCount).toBe(2);
  const detail = await call<{ tracks: ApiTrack[] }>(HOST, "GET", `/api/jam-songs/${list.songs[0]!.id}`);
  const [first, second] = [...detail.tracks].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const track of [first!, second!]) {
    // an integer millisecond (the engine rounds the offset once, at 48 kHz)
    expect(Number.isInteger(track.offsetMs), `offset ${track.offsetMs} is a whole ms`).toBe(true);
    // the count-in and the round trip sit before song time 0 and are hidden by the trim
    const audibleStart = track.offsetMs + track.trimStartMs;
    expect(Math.abs(audibleStart), "audible start at song time 0, within the 1 ms of rounding").toBeLessThanOrEqual(1);
    const behind = -track.offsetMs - COUNT_IN_MS;
    expect(behind, "count-in plus a plausible round trip").toBeGreaterThanOrEqual(0);
    expect(behind).toBeLessThan(300);
    expect(track.trimEndMs).toBe(0);
    expect(track.gain).toBe(1);
    expect(track.inMix || track === second).toBe(true);
  }
  // the second track starts where the first does, which is the whole point
  expect(
    Math.abs(second!.offsetMs + second!.trimStartMs - (first!.offsetMs + first!.trimStartMs)),
    "the two tracks start at the same song time",
  ).toBeLessThanOrEqual(1);
  await host.context().close();
  await guest.context().close();
});

test("a song someone else starts grows onto an open wall by itself", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const host = await openAs(browser, HOST, `/app/server/${seeded.serverId}/channel/${seeded.jamId}`);
  await expect(host.locator("[data-jam-empty]")).toBeVisible({ timeout: 20_000 });
  // A song is on the wall once it has a take: until then it is its author's alone.
  const started = await call<{ song: { id: string } }>(GUEST, "POST", `/api/channels/${seeded.jamId}/jam-songs`, { title: "Tempo Perdido" });
  await expect(host.locator("[data-jam-tile]")).toHaveCount(0);
  await addTrackApi(GUEST, started.song.id, "guitar");
  const tile = host.locator("[data-jam-tile]").filter({ hasText: "Tempo Perdido" });
  await expect(tile).toBeVisible({ timeout: 15_000 });
  await expect(tile).toHaveClass(/jam-tile-arrive/);
  await host.context().close();
});

test("a song has an address, and the studio shows and takes a typed latency", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const { song } = await call<{ song: { id: string } }>(HOST, "POST", `/api/channels/${seeded.jamId}/jam-songs`, {
    title: "Mar de Rosas",
  });
  // On the wall for everybody once it has a take (a song with none is its author's alone).
  await addTrackApi(HOST, song.id, "guitar");
  const jamPath = `/app/server/${seeded.serverId}/channel/${seeded.jamId}`;
  const songPath = `${jamPath}/song/${song.id}`;

  // ---- a pasted link opens the song; opening and closing move the bar --------
  const guest = await openAs(browser, GUEST, songPath);
  await expect(guest.locator(`[data-jam-song="${song.id}"]`)).toBeVisible({ timeout: 20_000 });
  await expect(guest).toHaveURL(new RegExp(`${songPath}$`));
  await guest.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(guest.locator("[data-jam-song]")).toHaveCount(0);
  await expect(guest).toHaveURL(new RegExp(`${jamPath}$`));
  await guest.locator("[data-jam-tile]").first().click();
  await expect(guest).toHaveURL(new RegExp(`${songPath}$`));
  // a song that is not there says so instead of an empty panel
  await guest.goto(`${jamPath}/song/00000000-0000-4000-8000-000000000000?lang=en`);
  await expect(guest.locator("[data-jam-song-gone]")).toBeVisible({ timeout: 20_000 });

  // ---- the studio: the number, where it came from, and a typed round trip ----
  await guest.goto(`${songPath}?lang=en`);
  await expect(guest.locator("[data-jam-record-over]")).toBeVisible({ timeout: 20_000 });
  await guest.locator("[data-jam-record-over]").click();
  await skipTheLatencyCheck(guest);
  const chip = guest.locator("[data-jam-latency-chip]");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("data-method", "estimate");
  await openSound(guest);
  await guest.locator("[data-jam-latency-details] summary").click();
  await guest.locator("[data-jam-manual-latency]").fill("55");
  await guest.locator("[data-jam-manual-use]").click();
  await expect(chip).toHaveAttribute("data-method", "manual");
  await expect(chip).toContainText("55");
  await closeSound(guest);

  // ---- and the take is placed with what was typed ----------------------------
  await recordAndStop(guest, 3);
  await expect(guest.locator('[data-jam-studio][data-phase="review"]')).toBeVisible({ timeout: 20_000 });
  // said in words on the review, the numbers (55 ms typed) in its tooltip and accessible name
  await expect(guest.locator("[data-jam-take-latency]")).toHaveAttribute("aria-label", /55/);
  await guest.locator("[data-jam-post]").click();
  await expect(guest.locator("[data-jam-done]")).toBeVisible({ timeout: 60_000 });
  const detail = await call<{ tracks: ApiTrack[] }>(HOST, "GET", `/api/jam-songs/${song.id}`);
  // the host's own take (made through the API) and the guest's, the later one
  expect(detail.tracks).toHaveLength(2);
  const guestsTake = [...detail.tracks].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[1]!;
  const behind = -guestsTake.offsetMs - COUNT_IN_MS;
  expect(Math.abs(behind - 55), "count-in plus the typed 55 ms, to the millisecond of rounding").toBeLessThanOrEqual(1);
  await guest.context().close();
});

// ---------------------------------------------------------------------------
// Helpers for the tests below: a song with real (small) audio, made through the API.

/** A few seconds of a plucked line as a WAV, which every browser decodes whatever the label says. */
function wavBytes(seconds = 4, note = 196): Uint8Array {
  const rate = 22050;
  const frames = Math.floor(seconds * rate);
  const out = new Uint8Array(44 + frames * 2);
  const view = new DataView(out.buffer);
  const text = (at: number, value: string) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    const v = Math.sin(2 * Math.PI * note * t) * Math.exp(-(t % 0.5) * 6) * 0.5;
    view.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return out;
}

async function makeSong(who: string, jamId: string, title: string, body: object = {}): Promise<string> {
  const { song } = await call<{ song: { id: string } }>(who, "POST", `/api/channels/${jamId}/jam-songs`, { title, ...body });
  return song.id;
}

async function addTrackApi(who: string, songId: string, instrument: string, note = 196, seconds = 4): Promise<ApiTrack & { id: string }> {
  const bytes = wavBytes(seconds, note);
  const ticket = await call<{ uploadId: string; uploadUrl: string }>(who, "POST", `/api/jam-songs/${songId}/uploads`, {
    kind: "audio",
    contentType: "audio/flac",
    byteSize: bytes.length,
  });
  const put = await fetch(ticket.uploadUrl, { method: "PUT", headers: { "Content-Type": "audio/flac" }, body: bytes });
  expect(put.ok).toBe(true);
  const { track } = await call<{ track: ApiTrack & { id: string } }>(who, "POST", `/api/jam-songs/${songId}/tracks`, {
    instrument,
    audioUploadId: ticket.uploadId,
    durationMs: seconds * 1000,
    peaks: [0.2, 0.8, 0.5, 0.9, 0.3],
  });
  return track;
}

async function tracksOf(songId: string, who = HOST): Promise<(ApiTrack & { instrument: string })[]> {
  const detail = await call<{ tracks: (ApiTrack & { instrument: string })[] }>(who, "GET", `/api/jam-songs/${songId}`);
  return detail.tracks;
}

test("a second song in the same visit is a second song, and a skipped latency check stays skipped", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const host = await openAs(browser, HOST, `/app/server/${seeded.serverId}/channel/${seeded.jamId}`);
  await expect(host.locator("[data-jam-empty]")).toBeVisible({ timeout: 20_000 });

  async function startAndPost(title: string, firstTime: boolean) {
    await host.locator(firstTime ? "[data-jam-empty-record]" : "[data-jam-new-song]").click();
    // a blank sheet every time, not the last song's answers
    await expect(host.locator("[data-jam-start-title]")).toHaveValue("");
    await host.locator("[data-jam-start-title]").fill(title);
    await host.locator("[data-jam-start-go]").click();
    await expect(host.locator('[data-jam-studio][data-phase="setup"]')).toBeVisible({ timeout: 20_000 });
    if (firstTime) {
      await skipTheLatencyCheck(host);
    } else {
      // skipped before on this pair of devices: no suggestion again, just the chip
      await expect(host.locator("[data-jam-latency-chip]")).toBeVisible({ timeout: 20_000 });
      await expect(host.locator("[data-jam-latency-check]")).toHaveCount(0);
    }
    await recordAndStop(host, 3);
    await expect(host.locator('[data-jam-studio][data-phase="review"]')).toBeVisible({ timeout: 20_000 });
    await host.locator("[data-jam-post]").click();
    await expect(host.locator("[data-jam-done]")).toBeVisible({ timeout: 60_000 });
    await host.locator("[data-jam-done-action]").click();
    await expect(host.locator("[data-jam-song]")).toBeVisible();
  }

  await startAndPost("Primeira", true);
  await host.getByRole("button", { name: "Close", exact: true }).first().click();
  await startAndPost("Segunda", false);

  const list = await call<{ songs: { id: string; title: string; trackCount: number }[] }>(
    HOST,
    "GET",
    `/api/channels/${seeded.jamId}/jam-songs`,
  );
  expect(list.songs.map((one) => one.title).sort()).toEqual(["Primeira", "Segunda"]);
  expect(list.songs.map((one) => one.trackCount)).toEqual([1, 1]);
  await host.context().close();
});

test("leaving a live recording asks first, and keeps recording when told to", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const songId = await makeSong(HOST, seeded.jamId, "Para gravar");
  await addTrackApi(HOST, songId, "guitar"); // on the wall once it has a take
  const guest = await openAs(browser, GUEST, `/app/server/${seeded.serverId}/channel/${seeded.jamId}/song/${songId}`);
  await guest.locator("[data-jam-record-over]").click();
  await skipTheLatencyCheck(guest);
  await expect(guest.locator("[data-jam-record]")).toBeEnabled({ timeout: 20_000 });
  await guest.locator("[data-jam-record]").click();
  await expect(guest.locator("[data-jam-stop]")).toBeVisible({ timeout: 15_000 });
  await guest.getByRole("button", { name: "Back", exact: true }).click();
  await expect(guest.getByRole("dialog").filter({ hasText: "Stop and discard the recording?" })).toBeVisible();
  await guest.getByRole("button", { name: "Keep recording" }).click();
  await expect(guest.locator("[data-jam-stop]")).toBeVisible();
  await guest.getByRole("button", { name: "Back", exact: true }).click();
  await guest.getByRole("button", { name: "Discard" }).click();
  await expect(guest.locator("[data-jam-studio]")).toHaveCount(0);
  await guest.context().close();
});

test("'Gravar por cima' while the song plays silences it, and the studio's own play and pause work", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const songId = await makeSong(HOST, seeded.jamId, "Tocando");
  // long enough to still be playing when the studio opens (the bug needs a song that is playing)
  await addTrackApi(HOST, songId, "guitar", 196, 30);
  await addTrackApi(HOST, songId, "drums", 98, 30);
  const guest = await openAs(browser, GUEST, `/app/server/${seeded.serverId}/channel/${seeded.jamId}/song/${songId}`);

  // the song plays in its panel
  const songPlay = guest.locator("[data-jam-song] [data-jam-play]");
  await expect(songPlay).toBeEnabled({ timeout: 20_000 });
  if ((await songPlay.getAttribute("data-state")) !== "playing") {
    await songPlay.click();
  }
  await expect(songPlay).toHaveAttribute("data-state", "playing", { timeout: 10_000 });

  // "Gravar por cima" while it plays: the studio opens silent (it used to keep
  // playing behind the studio, with the only pause button out of reach)
  await guest.locator("[data-jam-record-over]").click();
  const studio = guest.locator("[data-jam-studio]");
  await expect(studio).toBeVisible();
  const bandPlay = studio.locator("[data-jam-play]");
  await expect(bandPlay).toBeVisible({ timeout: 20_000 });
  await expect(bandPlay).toHaveAttribute("data-state", "paused");
  // the song panel behind (inert, out of reach) reads the same engine: it stopped too
  await expect(songPlay, "the song behind the studio is not still playing").toHaveAttribute("data-state", "paused");
  await guest.waitForTimeout(800);
  await expect(bandPlay, "nothing starts playing by itself under the studio").toHaveAttribute("data-state", "paused");
  await expect(songPlay).toHaveAttribute("data-state", "paused");

  // the studio's own transport: play, then pause, each a click
  await bandPlay.click();
  await expect(bandPlay).toHaveAttribute("data-state", "playing", { timeout: 10_000 });
  await bandPlay.click();
  await expect(bandPlay).toHaveAttribute("data-state", "paused");

  // and leaving the studio leaves the song quiet, with its own play ready
  await guest.getByRole("button", { name: "Back", exact: true }).click();
  await expect(studio).toHaveCount(0);
  await expect(songPlay).toHaveAttribute("data-state", "paused");
  await guest.context().close();
});

test("using a take swaps the mix, a posted take can be adjusted, and the wall says what it should", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const songId = await makeSong(HOST, seeded.jamId, "Duas guitarras");
  const first = await addTrackApi(HOST, songId, "guitar");
  const second = await addTrackApi(GUEST, songId, "guitar", 262);
  expect(first.inMix).toBe(true);
  expect(second.inMix).toBe(false);

  // ---- the host puts the second take in: the first one goes out ---------------
  const host = await openAs(browser, HOST, `/app/server/${seeded.serverId}/channel/${seeded.jamId}/song/${songId}`);
  const lane = host.locator(`[data-jam-track="${second.id}"]`);
  await expect(lane).toBeVisible({ timeout: 20_000 });
  await lane.locator("[data-jam-mix-switch]").click();
  await expect
    .poll(async () => (await tracksOf(songId)).map((t) => [t.id === first.id ? "first" : "second", t.inMix]))
    .toEqual([["first", false], ["second", true]]);

  // ---- the guest adjusts their own take after posting -----------------------------
  const guest = await openAs(browser, GUEST, `/app/server/${seeded.serverId}/channel/${seeded.jamId}/song/${songId}`);
  const open = guest.locator(`[data-jam-adjust-open="${second.id}"]`);
  await expect(open).toBeVisible({ timeout: 20_000 });
  await expect(guest.locator(`[data-jam-adjust-open="${first.id}"]`)).toHaveCount(0); // not somebody else's
  await open.click();
  const own = guest.locator(`[data-jam-adjust="${second.id}"]`);
  await expect(own).toBeVisible();
  // the clip itself: the band is drawn behind it, and its middle is a slider for the keyboard too
  await expect(own.locator("[data-jam-clip-editor]")).toBeVisible();
  await own.getByRole("button", { name: "Later" }).click();
  await own.getByRole("button", { name: "Later" }).click();
  await own.locator("[data-jam-clip-body]").focus();
  await guest.keyboard.press("ArrowRight"); // +10 ms
  await own.locator("[data-jam-adjust-save]").click();
  await expect
    .poll(async () => (await tracksOf(songId)).find((t) => t.id === second.id)?.offsetMs)
    .toBe(second.offsetMs + 30);
  await host.context().close();
  await guest.context().close();
});

test("recording over your own take of an instrument offers to replace it, and play works after posting", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const songId = await makeSong(HOST, seeded.jamId, "Regravar");
  const old = await addTrackApi(HOST, songId, "guitar");
  await addTrackApi(GUEST, songId, "bass", 98);
  const host = await openAs(browser, HOST, `/app/server/${seeded.serverId}/channel/${seeded.jamId}/song/${songId}`);
  await host.locator("[data-jam-record-over]").click();
  await skipTheLatencyCheck(host);
  await host.locator('[data-jam-instrument="guitar"]').click();
  await recordAndStop(host, 3);
  await expect(host.locator('[data-jam-studio][data-phase="review"]')).toBeVisible({ timeout: 20_000 });
  await expect(host.locator("[data-jam-replace]")).toContainText("guitar"); // asked, in one line, default yes
  await host.locator("[data-jam-post]").click();
  await expect(host.locator("[data-jam-done]")).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(async () => {
      const all = await tracksOf(songId);
      return {
        oldIn: all.find((t) => t.id === old.id)?.inMix,
        newIn: all.filter((t) => t.id !== old.id && t.instrument === "guitar").map((t) => t.inMix),
      };
    })
    .toEqual({ oldIn: false, newIn: [true] });

  // back on the song, Play plays (it once did nothing after posting into a song with several tracks)
  await host.locator("[data-jam-done-action]").click();
  const play = host.locator("[data-jam-play]");
  await expect(play).toBeEnabled({ timeout: 20_000 });
  await play.click();
  await expect(play).toHaveAttribute("aria-label", "Pause", { timeout: 10_000 });
  await host.context().close();
});

test("a song deleted under an open panel is said, and under a recording the take can go to a new song", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const watched = await makeSong(HOST, seeded.jamId, "Vai sumir");
  await addTrackApi(HOST, watched, "guitar"); // on the wall once it has a take
  const guest = await openAs(browser, GUEST, `/app/server/${seeded.serverId}/channel/${seeded.jamId}/song/${watched}`);
  await expect(guest.locator(`[data-jam-song="${watched}"]`)).toBeVisible({ timeout: 20_000 });
  // Escape closes the panel (and the song is reachable again by its tile)
  await guest.keyboard.press("Escape");
  await expect(guest.locator("[data-jam-song]")).toHaveCount(0);
  await guest.locator("[data-jam-tile]").first().click();
  await expect(guest.locator(`[data-jam-song="${watched}"]`)).toBeVisible();
  await call(HOST, "DELETE", `/api/jam-songs/${watched}`).catch(() => undefined);
  await expect(guest.locator("[data-jam-song-deleted-notice]")).toContainText("Vai sumir", { timeout: 15_000 });

  // ---- a recording over a song that then disappears --------------------------------
  const doomed = await makeSong(HOST, seeded.jamId, "Vai sumir 2");
  await addTrackApi(HOST, doomed, "guitar");
  await guest.locator("[data-jam-tile]").filter({ hasText: "Vai sumir 2" }).click();
  await guest.locator("[data-jam-record-over]").click();
  await skipTheLatencyCheck(guest);
  // while the studio is open the wall behind it is out of reach of Tab
  await expect(guest.locator('section[aria-label="Jam"]')).toHaveAttribute("inert", "");
  await recordAndStop(guest, 3);
  await expect(guest.locator('[data-jam-studio][data-phase="review"]')).toBeVisible({ timeout: 20_000 });
  await call(HOST, "DELETE", `/api/jam-songs/${doomed}`);
  await expect(guest.locator("[data-jam-song-deleted]")).toBeVisible({ timeout: 15_000 });
  // the header keeps the song's name instead of turning into "New song"
  await expect(guest.locator("[data-jam-studio] h2")).not.toHaveText("New song");
  await guest.locator("[data-jam-post-as-new]").click();
  await expect(guest.locator("[data-jam-done]")).toBeVisible({ timeout: 60_000 });
  const list = await call<{ songs: { id: string; title: string; trackCount: number }[] }>(
    HOST,
    "GET",
    `/api/channels/${seeded.jamId}/jam-songs`,
  );
  expect(list.songs).toHaveLength(1);
  expect(list.songs[0]?.title).toBe("Vai sumir 2");
  expect(list.songs[0]?.trackCount).toBe(1);
  await guest.context().close();
});

// ---------------------------------------------------------------------------
// One track's volume is one track's volume.

/**
 * A probe on the page's Web Audio graph. Every GainNode a stem plays through is
 * found by what feeds it (a buffer source whose buffer is N seconds long), gets
 * an analyser hung off its output, and is read back by that duration: so a test
 * can say what each track's gain IS and how loud each track actually comes out,
 * not what a screen says. Added before any page script runs.
 */
function installAudioProbe(): void {
  type Tapped = GainNode & { __tap?: { seconds: number; analyser: AnalyserNode; peak: number } };
  const taps: Tapped[] = [];
  const connect = AudioNode.prototype.connect as (this: AudioNode, ...args: unknown[]) => unknown;
  (AudioNode.prototype as unknown as { connect: unknown }).connect = function (this: AudioNode, ...args: unknown[]) {
    const [to] = args;
    if (this instanceof AudioBufferSourceNode && to instanceof GainNode && this.buffer && !(to as Tapped).__tap) {
      const analyser = to.context.createAnalyser();
      analyser.fftSize = 2048;
      connect.call(to, analyser);
      (to as Tapped).__tap = { seconds: Math.round(this.buffer.duration), analyser, peak: 0 };
      taps.push(to as Tapped);
    }
    return connect.apply(this, args);
  };
  const scratch = new Float32Array(2048);
  setInterval(() => {
    for (const node of taps) {
      const tap = node.__tap!;
      tap.analyser.getFloatTimeDomainData(scratch);
      for (const sample of scratch) {
        tap.peak = Math.max(tap.peak, Math.abs(sample));
      }
    }
  }, 20);
  Object.assign(window, {
    __probeReset: () => {
      for (const node of taps) node.__tap!.peak = 0;
    },
    __probeRead: () =>
      taps.map((node) => ({ seconds: node.__tap!.seconds, gain: node.gain.value, peak: node.__tap!.peak })),
  });
}

interface ProbeRow {
  seconds: number;
  gain: number;
  peak: number;
}

/** Plays the song for a moment and reports each stem's gain and the loudest sample it put out. */
async function listen(page: Page, ms = 1300): Promise<Record<number, ProbeRow>> {
  const play = page.locator("[data-jam-song] [data-jam-play]");
  await expect(play).toBeEnabled({ timeout: 20_000 });
  await page.evaluate(() => (window as unknown as { __probeReset: () => void }).__probeReset());
  if ((await play.getAttribute("data-state")) !== "playing") {
    await play.click();
  }
  await page.waitForTimeout(ms);
  const rows = await page.evaluate(() => (window as unknown as { __probeRead: () => ProbeRow[] }).__probeRead());
  await play.click(); // pause
  await expect(play).toHaveAttribute("data-state", "paused");
  // the newest node of a duration wins: a stem reloaded after a change replaces its old node
  const bySeconds: Record<number, ProbeRow> = {};
  for (const row of rows) bySeconds[row.seconds] = row;
  return bySeconds;
}

/** PR screenshots: only when `JAM_SHOTS` names a folder, so an ordinary run writes nothing. */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.JAM_SHOTS;
  if (dir) {
    await page.screenshot({ path: `${dir}/${name}.png` });
  }
}

/** Click a Radix slider at a fraction of its width, with the real mouse. */
async function clickSliderAt(page: Page, slider: ReturnType<Page["locator"]>, fraction: number): Promise<void> {
  const root = slider.locator("xpath=ancestor::*[@data-slider][1]");
  await root.scrollIntoViewIfNeeded();
  // the editor scrolls itself into view smoothly: click only once it stopped moving
  let box = (await root.boundingBox())!;
  for (let settled = 0; settled < 3; ) {
    await page.waitForTimeout(120);
    const next = (await root.boundingBox())!;
    settled = next.x === box.x && next.y === box.y ? settled + 1 : 0;
    box = next;
  }
  await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
}

test("changing the volume of one of a song's tracks changes that track and no other", async ({ browser }) => {
  const seeded = await seed(HOST_B, GUEST_B);
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const songId = await makeSong(HOST_B, seeded.jamId, "Duas faixas minhas");
  // Both recorded by the same person, different lengths so each is told apart on the audio graph.
  const guitar = await addTrackApi(HOST_B, songId, "guitar", 196, 4);
  const drums = await addTrackApi(HOST_B, songId, "drums", 98, 6);
  const GUITAR = 4;
  const DRUMS = 6;

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const host = await context.newPage();
  await host.addInitScript((value) => localStorage.setItem("pqp:dev-user-suffix", value), HOST_B);
  await host.addInitScript(installAudioProbe);
  await host.goto(`/app/server/${seeded.serverId}/channel/${seeded.jamId}/song/${songId}?lang=en`);
  await expect(host.locator("[data-jam-track]")).toHaveCount(2, { timeout: 20_000 });

  const before = await listen(host);
  await shot(host, "volume-1-two-tracks-before");
  expect(before[GUITAR]?.gain).toBeCloseTo(1, 2);
  expect(before[DRUMS]?.gain).toBeCloseTo(1, 2);
  expect(before[GUITAR]!.peak).toBeGreaterThan(0.05);
  expect(before[DRUMS]!.peak).toBeGreaterThan(0.05);
  // what the lanes show: two takes at their recorded level, no volume chip on either
  const guitarLane = host.locator(`[data-jam-track="${guitar.id}"]`);
  const drumsLane = host.locator(`[data-jam-track="${drums.id}"]`);
  await expect(host.locator("[data-jam-gain]")).toHaveCount(0);
  const tallest = (lane: ReturnType<Page["locator"]>) =>
    lane.evaluate((element) =>
      Math.max(...[...element.querySelectorAll<HTMLElement>("span[style*='--jam-b']")].map((bar) => parseFloat(bar.style.height))),
    );
  const barsBefore = { guitar: await tallest(guitarLane), drums: await tallest(drumsLane) };

  // ---- while dragging: the guitar goes down to about a quarter -------------------
  await host.locator(`[data-jam-adjust-open="${guitar.id}"]`).click();
  const adjust = host.locator(`[data-jam-adjust="${guitar.id}"]`);
  await expect(adjust).toBeVisible();
  await clickSliderAt(host, adjust.getByRole("slider", { name: "Take volume" }), 0.125);
  const heard = await listen(host);
  await shot(host, "volume-2-guitar-turned-down");
  test.info().annotations.push({ type: "volume probe", description: JSON.stringify({ before, heard }) });
  expect(heard[GUITAR]!.gain, "the adjusted track follows the slider").toBeCloseTo(0.25, 1);
  expect(heard[DRUMS]!.gain, "the other track's gain is untouched").toBeCloseTo(1, 2);
  expect(heard[GUITAR]!.peak, "the adjusted track is quieter on the audio").toBeLessThan(before[GUITAR]!.peak * 0.5);
  expect(heard[DRUMS]!.peak, "the other track is as loud as it was").toBeGreaterThan(before[DRUMS]!.peak * 0.9);
  expect(heard[DRUMS]!.peak).toBeLessThan(before[DRUMS]!.peak * 1.1);

  // ---- saved: one track id, one gain -------------------------------------------------
  const writes: { url: string; body: string }[] = [];
  host.on("request", (request) => {
    if (request.method() === "PATCH" && request.url().includes("/api/jam-tracks/")) {
      writes.push({ url: request.url(), body: request.postData() ?? "" });
    }
  });
  await adjust.locator("[data-jam-adjust-save]").click();
  await expect.poll(async () => (await tracksOf(songId, HOST_B)).find((t) => t.id === guitar.id)?.gain).toBeCloseTo(0.25, 1);
  expect(writes, "one write").toHaveLength(1);
  expect(writes[0]!.url.endsWith(`/api/jam-tracks/${guitar.id}`)).toBe(true);
  expect(Object.keys(JSON.parse(writes[0]!.body))).toEqual(["gain"]);
  expect((await tracksOf(songId, HOST_B)).find((t) => t.id === drums.id)?.gain, "the other track is stored as it was").toBe(1);

  // ---- after save: what is shown and what is heard ---------------------------------
  await expect(adjust).toHaveCount(0);
  // the guitar's own lane says so (a chip and shorter bars); the drums' lane is as it was
  await expect(guitarLane.locator("[data-jam-gain]")).toHaveText("-75%");
  await expect(drumsLane.locator("[data-jam-gain]")).toHaveCount(0);
  expect(await tallest(guitarLane), "the turned-down lane is drawn lower").toBeLessThan(barsBefore.guitar * 0.6);
  expect(await tallest(drumsLane), "the untouched lane is drawn as it was").toBe(barsBefore.drums);
  const saved = await listen(host);
  await shot(host, "volume-3-saved");
  test.info().annotations.push({ type: "volume probe saved", description: JSON.stringify(saved) });
  expect(saved[GUITAR]!.gain).toBeCloseTo(0.25, 1);
  expect(saved[DRUMS]!.gain).toBeCloseTo(1, 2);
  expect(saved[DRUMS]!.peak).toBeGreaterThan(before[DRUMS]!.peak * 0.9);

  // ---- closed and opened again, from the wall -----------------------------------------
  await host.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(host.locator("[data-jam-song]")).toHaveCount(0);
  await host.locator("[data-jam-tile]").first().click();
  await expect(host.locator("[data-jam-track]")).toHaveCount(2, { timeout: 20_000 });
  const reopened = await listen(host);
  expect(reopened[GUITAR]!.gain).toBeCloseTo(0.25, 1);
  expect(reopened[DRUMS]!.gain).toBeCloseTo(1, 2);
  expect(reopened[GUITAR]!.peak).toBeLessThan(before[GUITAR]!.peak * 0.5);
  expect(reopened[DRUMS]!.peak).toBeGreaterThan(before[DRUMS]!.peak * 0.9);
  await context.close();
});

test("the camera is on the setup step, one tap from recording with video, and the take keeps its video", async ({ browser }) => {
  const seeded = await seed(HOST_B, GUEST_B);
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const songId = await makeSong(HOST_B, seeded.jamId, "Com vídeo");
  await addTrackApi(HOST_B, songId, "guitar"); // on the wall once it has a take
  const guest = await openAs(browser, GUEST_B, `/app/server/${seeded.serverId}/channel/${seeded.jamId}/song/${songId}`);
  await guest.locator("[data-jam-record-over]").click();
  await expect(guest.locator('[data-jam-studio][data-phase="setup"]')).toBeVisible({ timeout: 20_000 });
  await skipTheLatencyCheck(guest);

  // visible as the studio opens: not behind "Your sound", not in a closed section
  const video = guest.locator("[data-jam-video]").getByRole("switch", { name: "Record video too" });
  await expect(video).toBeVisible();
  await expect(guest.locator("[data-jam-sound-panel]")).toHaveCount(0);
  await expect(video).toHaveAttribute("aria-checked", "false");
  await expect(guest.locator("[data-jam-studio] video")).toHaveCount(0);
  await shot(guest, "camera-1-switch-on-the-setup-step");

  // one tap turns the camera on, and the person sees themselves before recording
  await video.click();
  await expect(video).toHaveAttribute("aria-checked", "true");
  const preview = guest.locator('[data-jam-studio] video[aria-label="Your camera"]');
  await expect(preview).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => preview.evaluate((element: HTMLVideoElement) => element.srcObject !== null && element.videoWidth > 0))
    .toBe(true);
  await shot(guest, "camera-2-camera-on-before-recording");

  await recordAndStop(guest, 3);
  await expect(guest.locator('[data-jam-studio][data-phase="review"]')).toBeVisible({ timeout: 20_000 });
  // the take on review plays its own recorded video, not the live camera
  await expect(guest.locator('[data-jam-studio] video[aria-label="Your camera"][src]')).toBeVisible({ timeout: 15_000 });
  await shot(guest, "camera-3-take-with-video-on-review");
  await guest.locator("[data-jam-post]").click();
  await expect(guest.locator("[data-jam-done]")).toBeVisible({ timeout: 60_000 });

  const detail = await call<{ tracks: { authorId: string; videoUrl: string | null }[] }>(HOST_B, "GET", `/api/jam-songs/${songId}`);
  // the host's own take (through the API, no video) and the guest's, which has one
  expect(detail.tracks).toHaveLength(2);
  expect(detail.tracks.filter((track) => track.videoUrl), "the posted take has a video").toHaveLength(1);
  await guest.context().close();
});

test("a volume being adjusted keeps playing as the editor says while the lanes around it are muted and unmuted", async ({ browser }) => {
  const seeded = await seed(HOST_B, GUEST_B);
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const songId = await makeSong(HOST_B, seeded.jamId, "Mexendo no mix");
  const guitar = await addTrackApi(HOST_B, songId, "guitar", 196, 4);
  const drums = await addTrackApi(HOST_B, songId, "drums", 98, 6);
  const GUITAR = 4;
  const DRUMS = 6;

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const host = await context.newPage();
  await host.addInitScript((value) => localStorage.setItem("pqp:dev-user-suffix", value), HOST_B);
  await host.addInitScript(installAudioProbe);
  await host.goto(`/app/server/${seeded.serverId}/channel/${seeded.jamId}/song/${songId}?lang=en`);
  await expect(host.locator("[data-jam-track]")).toHaveCount(2, { timeout: 20_000 });
  await listen(host); // the stems are loaded and wired

  await host.locator(`[data-jam-adjust-open="${guitar.id}"]`).click();
  const adjust = host.locator(`[data-jam-adjust="${guitar.id}"]`);
  await clickSliderAt(host, adjust.getByRole("slider", { name: "Take volume" }), 0.125);
  await expect(adjust).toContainText("-75%");

  // somebody mutes the drums and brings them back: the guitar's unsaved volume is still what plays
  const drumsLane = host.locator(`[data-jam-track="${drums.id}"]`);
  await drumsLane.locator("[data-jam-mute]").click();
  await drumsLane.locator("[data-jam-mute]").click();
  const heard = await listen(host);
  expect(heard[DRUMS]!.gain).toBeCloseTo(1, 2);
  expect(heard[GUITAR]!.gain, "the preview is what the editor says, not the stored volume").toBeCloseTo(0.25, 1);
  await context.close();
});

test("two takes recorded by the same person in the studio: turning one down leaves the other as recorded", async ({ browser }) => {
  const seeded = await seed(HOST_B, GUEST_B);
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    permissions: ["microphone", "camera"],
  });
  const host = await context.newPage();
  await host.addInitScript((value) => localStorage.setItem("pqp:dev-user-suffix", value), HOST_B);
  await host.addInitScript(installAudioProbe);
  await host.goto(`/app/server/${seeded.serverId}/channel/${seeded.jamId}?lang=en`);
  await expect(host.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
  await expect(host.locator("[data-jam-empty]")).toBeVisible({ timeout: 20_000 });

  // ---- take one: a short guitar, started from the empty wall -------------------------
  await host.locator("[data-jam-empty-record]").click();
  await host.locator("[data-jam-start-title]").fill("Duas minhas");
  await host.locator("[data-jam-start-go]").click();
  await expect(host.locator('[data-jam-studio][data-phase="setup"]')).toBeVisible({ timeout: 20_000 });
  await skipTheLatencyCheck(host);
  await host.locator('[data-jam-instrument="guitar"]').click();
  await shot(host, "studio-1-setup-with-camera-switch");
  await recordAndStop(host, 3);
  await expect(host.locator('[data-jam-studio][data-phase="review"]')).toBeVisible({ timeout: 20_000 });
  await host.locator("[data-jam-post]").click();
  await expect(host.locator("[data-jam-done]")).toBeVisible({ timeout: 60_000 });
  await host.locator("[data-jam-done-action]").click();
  await expect(host.locator("[data-jam-track]")).toHaveCount(1);

  // ---- take two: a longer bass over it, by the same person ---------------------------
  await host.locator("[data-jam-record-over]").click();
  await expect(host.locator('[data-jam-studio][data-phase="setup"]')).toBeVisible({ timeout: 20_000 });
  await host.locator('[data-jam-instrument="bass"]').click();
  await recordAndStop(host, 6);
  await expect(host.locator('[data-jam-studio][data-phase="review"]')).toBeVisible({ timeout: 20_000 });
  await host.locator("[data-jam-post]").click();
  await expect(host.locator("[data-jam-done]")).toBeVisible({ timeout: 60_000 });
  await host.locator("[data-jam-done-action]").click();
  await expect(host.locator("[data-jam-track]")).toHaveCount(2, { timeout: 20_000 });

  const { songs } = await call<{ songs: { id: string }[] }>(HOST_B, "GET", `/api/channels/${seeded.jamId}/jam-songs`);
  const songId = songs[0]!.id;
  const [first, second] = (await tracksOf(songId, HOST_B)).sort((a, b) => a.durationMs - b.durationMs);
  expect(first!.authorId).toBe(second!.authorId);
  expect(first!.gain).toBe(1);
  expect(second!.gain).toBe(1);

  const before = await listen(host);
  // (the count-in's click is a buffer under a second long: not a take)
  const takesOnly = (all: Record<number, ProbeRow>) => Object.values(all).filter((row) => row.seconds >= 2).sort((a, b) => a.seconds - b.seconds);
  const rows = takesOnly(before);
  expect(rows, "two stems on the graph").toHaveLength(2);

  // ---- turn the short one (the first take) down; the second is untouched ------------------
  await host.locator(`[data-jam-adjust-open="${first!.id}"]`).click();
  const adjust = host.locator(`[data-jam-adjust="${first!.id}"]`);
  await expect(adjust).toBeVisible();
  await clickSliderAt(host, adjust.getByRole("slider", { name: "Take volume" }), 0.25);
  const heard = await listen(host);
  await shot(host, "studio-2-two-takes-first-turned-down");
  const now = takesOnly(heard);
  test.info().annotations.push({ type: "two takes probe", description: JSON.stringify({ before: rows, heard: now }) });
  expect(now[0]!.gain).toBeCloseTo(0.5, 1);
  expect(now[1]!.gain).toBeCloseTo(1, 2);
  expect(now[1]!.peak, "the second take is as loud as it was").toBeGreaterThan(rows[1]!.peak * 0.8);
  await adjust.locator("[data-jam-adjust-save]").click();
  await expect(adjust).toHaveCount(0);
  await expect
    .poll(async () => (await tracksOf(songId, HOST_B)).sort((a, b) => a.durationMs - b.durationMs).map((t) => t.gain))
    .toEqual([0.5, 1]);
  await shot(host, "studio-3-saved-lanes");
  await context.close();
});
