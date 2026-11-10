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
import { FAKE_MIC_WAV } from "../playwright.jam.config";

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const HOST = "jamhost";
const GUEST = "jamguest";
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
  return (await response.json()) as T;
}

interface Seeded {
  serverId: string;
  jamId: string;
  uploads: boolean;
}

async function seed(): Promise<Seeded> {
  await materialise(HOST);
  await materialise(GUEST);
  const { server } = await call<{ server: { id: string } }>(HOST, "POST", "/api/servers", {
    name: `Garagem ${Date.now()}`,
  });
  const { invite } = await call<{ invite: { code: string } }>(HOST, "POST", `/api/servers/${server.id}/invites`, {});
  await call(GUEST, "POST", `/api/invites/${invite.code}/join`);
  const { channel } = await call<{ channel: { id: string } }>(HOST, "POST", `/api/servers/${server.id}/channels`, {
    name: "jam",
    type: "jam",
  });
  const config = await call<{ enabled: boolean; uploads: boolean }>(HOST, "GET", `/api/jam/config?serverId=${server.id}`);
  expect(config.enabled, "the suite's server runs with JAM_CHANNELS=true").toBe(true);
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
  // The first recording on a pair of devices asks to measure the round trip;
  // skipping it is a real, supported answer ("use the estimate").
  const skip = page.locator("[data-jam-skip-check]");
  // Either the explainer (first use of these devices) or the measured card.
  await expect(page.locator("[data-jam-latency-check], [data-jam-latency]").first()).toBeVisible({
    timeout: 20_000,
  });
  if (await skip.isVisible()) {
    await skip.click();
  }
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
  await expect(guest.locator("[data-jam-latency]")).toContainText(/\d+ ms/);
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
  const host = await openAs(browser, HOST, `/app/server/${seeded.serverId}/channel/${seeded.jamId}`);
  await expect(host.locator("[data-jam-empty]")).toBeVisible({ timeout: 20_000 });
  await call(GUEST, "POST", `/api/channels/${seeded.jamId}/jam-songs`, { title: "Tempo Perdido" });
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
  await guest.locator("[data-jam-latency-details] summary").click();
  await guest.locator("[data-jam-manual-latency]").fill("55");
  await guest.locator("[data-jam-manual-use]").click();
  await expect(chip).toHaveAttribute("data-method", "manual");
  await expect(chip).toContainText("55");

  // ---- and the take is placed with what was typed ----------------------------
  await recordAndStop(guest, 3);
  await expect(guest.locator('[data-jam-studio][data-phase="review"]')).toBeVisible({ timeout: 20_000 });
  await expect(guest.locator("[data-jam-take-latency]")).toContainText("55");
  await guest.locator("[data-jam-post]").click();
  await expect(guest.locator("[data-jam-done]")).toBeVisible({ timeout: 60_000 });
  const detail = await call<{ tracks: ApiTrack[] }>(HOST, "GET", `/api/jam-songs/${song.id}`);
  expect(detail.tracks).toHaveLength(1);
  const behind = -detail.tracks[0]!.offsetMs - COUNT_IN_MS;
  expect(Math.abs(behind - 55), "count-in plus the typed 55 ms, to the millisecond of rounding").toBeLessThanOrEqual(1);
  await guest.context().close();
});
