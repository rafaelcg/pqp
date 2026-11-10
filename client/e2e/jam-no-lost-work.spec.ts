/**
 * THE JAM LOSES NO WORK, with real clicks in real Chromium against the real API
 * and the real object store (the same rig as `jam-web.spec.ts`: a fake
 * microphone, a fake camera, MinIO).
 *
 * Three people tested the Jam and found ways it threw a person's work away or
 * left a broken state behind. One test per finding:
 *
 *   1  a reload during the first take's upload leaves no empty song on anybody
 *      else's wall (the author sees it as "no take yet" and can delete it), and
 *      deleting the last take deletes the song, with the confirm saying so
 *   2  the browser asks before a reload or a closed tab only while a take is
 *      recorded and unsent or going up
 *   3  Back goes studio to song to wall, and from a studio holding a take asks
 *      the same "Discard this take?" the arrow asks
 *   4  an input that ends mid-recording stops the take and says so; a take that
 *      is silent from start to finish is flagged before it is sent
 *   5  a stale edit sheet sends only what its person changed
 *   6  closing the edit sheet with something typed asks first
 *   7  a failed send keeps the take and offers every way out
 *   8  choosing "Voz" with the camera on records a vocals take
 *
 * Needs object storage (`docker compose --profile storage up -d minio
 * minio-init`, then export `S3_*`, see `playwright.config.ts`); without it the
 * config says `uploads: false` and these skip with that reason.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";
import { FAKE_MIC_WAV } from "../playwright.jam.config";
import { addApiTrack } from "./jam-api-track";

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const RUN = Date.now().toString(36);
let accounts = 0;
/** Two fresh accounts per test: song creation is rate limited per person (10 per 10 minutes). */
function people() {
  accounts += 1;
  return { host: `nlwhost${accounts}${RUN}`, guest: `nlwguest${accounts}${RUN}` };
}

test.setTimeout(Number(process.env.JAM_TEST_TIMEOUT ?? 180_000));
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

interface Seeded {
  serverId: string;
  jamId: string;
  jamPath: string;
  uploads: boolean;
  host: string;
  guest: string;
}

async function seed(): Promise<Seeded> {
  const { host, guest } = people();
  await materialise(host);
  await materialise(guest);
  const { server } = await call<{ server: { id: string } }>(host, "POST", "/api/servers", { name: `Perdas ${Date.now()}` });
  const { invite } = await call<{ invite: { code: string } }>(host, "POST", `/api/servers/${server.id}/invites`, {});
  await call(guest, "POST", `/api/invites/${invite.code}/join`);
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
  const config = await call<{ uploads: boolean }>(host, "GET", `/api/jam/config?serverId=${server.id}`);
  return {
    serverId: server.id,
    jamId: channel.id,
    jamPath: `/app/server/${server.id}/channel/${channel.id}`,
    uploads: config.uploads,
    host,
    guest,
  };
}

/** A song the whole room can see: its author's first take is in. */
async function liveSong(seeded: Seeded, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { song } = await call<{ song: { id: string } }>(seeded.host, "POST", `/api/channels/${seeded.jamId}/jam-songs`, {
    title,
    ...extra,
  });
  await addApiTrack(API, seeded.host, song.id, "guitar");
  return song.id;
}

async function openAs(browser: Browser, suffix: string, path: string, init?: () => void): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    permissions: ["microphone", "camera"],
  });
  const page = await context.newPage();
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  if (init) {
    await page.addInitScript(init);
  }
  await page.goto(`${path}${path.includes("?") ? "&" : "?"}lang=en`);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
  return page;
}

async function skipTheLatencyCheck(page: Page): Promise<void> {
  const skip = page.locator("[data-jam-skip-check]");
  await expect(page.locator("[data-jam-latency-chip]")).toBeVisible({ timeout: 20_000 });
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

/** From the wall to a take in review over this song. */
async function reviewOver(page: Page, seconds = 3): Promise<void> {
  await page.locator("[data-jam-record-over]").click();
  await expect(page.locator('[data-jam-studio][data-phase="setup"]')).toBeVisible({ timeout: 20_000 });
  await skipTheLatencyCheck(page);
  await recordAndStop(page, seconds);
  await expect(page.locator('[data-jam-studio][data-phase="review"]')).toBeVisible({ timeout: 20_000 });
}

/** The page's own beforeunload handlers, asked directly: did anything cancel it? */
async function asksBeforeLeaving(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

/** Screenshots for the PR, only when asked for (`JAM_SHOTS_DIR`): the specs write nothing otherwise. */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.JAM_SHOTS_DIR;
  if (dir) {
    // let a view transition or an entrance finish
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${dir}/${name}.png` });
  }
}

// ---------------------------------------------------------------------------

test("1: a reload mid-upload leaves no empty song on anybody's wall; the author sees it empty and can delete it", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const dialogs: string[] = [];

  // ---- the host starts a song and the upload to the bucket hangs --------------
  const host = await openAs(browser, seeded.host, seeded.jamPath);
  host.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.accept();
  });
  await host.route(
    (url) => url.pathname.includes("/jam/"),
    (route) => {
      if (route.request().method() === "PUT") {
        return; // never answered: "Sending, 0%" for as long as the page lives
      }
      return route.continue();
    },
  );
  await expect(host.locator("[data-jam-empty]")).toBeVisible({ timeout: 20_000 });
  await host.locator("[data-jam-empty-record]").click();
  await host.locator("[data-jam-start-title]").fill("Meio do Caminho");
  await host.locator("[data-jam-start-go]").click();
  await expect(host.locator('[data-jam-studio][data-phase="setup"]')).toBeVisible({ timeout: 20_000 });
  await skipTheLatencyCheck(host);
  await recordAndStop(host, 3);
  await expect(host.locator('[data-jam-studio][data-phase="review"]')).toBeVisible({ timeout: 20_000 });
  await host.locator("[data-jam-post]").click();
  await expect(host.locator("[data-jam-posting]")).toBeVisible();
  // the song row exists now (the upload needs it), the take does not
  await expect
    .poll(async () => (await call<{ songs: unknown[] }>(seeded.host, "GET", `/api/channels/${seeded.jamId}/jam-songs`)).songs.length)
    .toBe(1);

  // ---- somebody else's wall: nothing to see, live and after a read -----------
  const guest = await openAs(browser, seeded.guest, seeded.jamPath);
  await expect(guest.locator("[data-jam-empty]")).toBeVisible({ timeout: 20_000 });
  await expect(guest.locator("[data-jam-tile]")).toHaveCount(0);
  await shot(guest, "after-1-others-wall-has-no-empty-song");
  expect((await call<{ songs: unknown[] }>(seeded.guest, "GET", `/api/channels/${seeded.jamId}/jam-songs`)).songs).toEqual([]);

  // ---- the host reloads in the middle of it: the browser asks, they accept ---
  await host.reload();
  expect(dialogs, "the browser asked before the reload").toContain("beforeunload");
  await expect(host.locator("[data-jam-tile]")).toHaveCount(1, { timeout: 20_000 });
  await expect(guest.locator("[data-jam-tile]")).toHaveCount(0);

  // ---- the author's view of it: empty, with actions that make sense ----------
  await host.locator("[data-jam-tile]").first().click();
  await expect(host.locator("[data-jam-empty-song]")).toBeVisible();
  await expect(host.locator("[data-jam-play]")).toHaveCount(0);
  await expect(host.locator("[data-jam-record-over]")).toContainText("Record the first take");
  await expect(host.locator("[data-jam-record-over]")).not.toContainText("on top");
  await shot(host, "after-1-author-sees-empty-song");
  await host.locator("[data-jam-empty-delete]").click();
  await expect(host.getByRole("dialog").getByText("Delete this song?")).toBeVisible();
  await host.getByRole("dialog").getByRole("button", { name: "Delete song" }).click();
  await expect(host.locator("[data-jam-tile]")).toHaveCount(0, { timeout: 10_000 });
  expect((await call<{ songs: unknown[] }>(seeded.host, "GET", `/api/channels/${seeded.jamId}/jam-songs`)).songs).toEqual([]);
  await host.context().close();
  await guest.context().close();
});

test("1: a first take that is sent shows the song to everybody at once; deleting the last take deletes the song and says so", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const guest = await openAs(browser, seeded.guest, seeded.jamPath);
  await expect(guest.locator("[data-jam-empty]")).toBeVisible({ timeout: 20_000 });

  // a song with a take shows up on the open wall by itself
  const single = await liveSong(seeded, "Só Uma");
  await expect(guest.locator("[data-jam-tile]").filter({ hasText: "Só Uma" })).toBeVisible({ timeout: 15_000 });

  // two takes: the confirm is the ordinary one
  const pair = await liveSong(seeded, "Duas");
  await addApiTrack(API, seeded.guest, pair, "bass");
  const host = await openAs(browser, seeded.host, `${seeded.jamPath}/song/${pair}`);
  await expect(host.locator("[data-jam-track]")).toHaveCount(2, { timeout: 20_000 });
  await host.locator("[data-jam-lane-menu]").first().click();
  await host.getByRole("menuitem", { name: "Delete take" }).click();
  await expect(host.getByRole("dialog").getByText("Delete this take?")).toBeVisible();
  await host.getByRole("dialog").getByRole("button", { name: "Keep" }).click();

  // one take: the confirm says the song goes with it
  await host.goto(`${seeded.jamPath}/song/${single}?lang=en`);
  await expect(host.locator("[data-jam-track]")).toHaveCount(1, { timeout: 20_000 });
  await host.locator("[data-jam-lane-menu]").first().click();
  await host.getByRole("menuitem", { name: "Delete take" }).click();
  const dialog = host.getByRole("dialog");
  await expect(dialog.getByText("Delete the song?")).toBeVisible();
  await shot(host, "after-1-delete-last-take-confirm");
  await expect(dialog.getByText("This is the last take, so deleting it deletes the song too.")).toBeVisible();
  await dialog.getByRole("button", { name: "Delete song" }).click();
  await expect(host.locator("[data-jam-song]")).toHaveCount(0, { timeout: 10_000 });
  await expect(guest.locator("[data-jam-tile]").filter({ hasText: "Só Uma" })).toHaveCount(0, { timeout: 15_000 });
  const left = await call<{ songs: { title: string }[] }>(seeded.host, "GET", `/api/channels/${seeded.jamId}/jam-songs`);
  expect(left.songs.map((song) => song.title)).toEqual(["Duas"]);
  await host.context().close();
  await guest.context().close();
});

test("2: the browser asks before leaving only while a take is recorded and unsent, or going up", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const song = await liveSong(seeded, "Guarda");
  const guest = await openAs(browser, seeded.guest, `${seeded.jamPath}/song/${song}`);
  await expect(guest.locator("[data-jam-record-over]")).toBeVisible({ timeout: 20_000 });
  expect(await asksBeforeLeaving(guest), "the song panel holds nothing").toBe(false);
  await guest.locator("[data-jam-record-over]").click();
  await expect(guest.locator('[data-jam-studio][data-phase="setup"]')).toBeVisible({ timeout: 20_000 });
  await skipTheLatencyCheck(guest);
  expect(await asksBeforeLeaving(guest), "the setup holds nothing").toBe(false);
  const record = guest.locator("[data-jam-record]");
  await expect(record).toBeEnabled({ timeout: 20_000 });
  await record.click();
  await expect(guest.locator("[data-jam-stop]")).toBeVisible({ timeout: 15_000 });
  expect(await asksBeforeLeaving(guest), "a live recording has its own question inside the app").toBe(false);
  await guest.waitForTimeout(2500);
  await guest.locator("[data-jam-stop]").click();
  await expect(guest.locator('[data-jam-studio][data-phase="review"]')).toBeVisible({ timeout: 20_000 });
  expect(await asksBeforeLeaving(guest), "a recorded take, not sent").toBe(true);
  // sent: nothing left to lose
  await guest.locator("[data-jam-post]").click();
  await expect(guest.locator("[data-jam-done]")).toBeVisible({ timeout: 60_000 });
  expect(await asksBeforeLeaving(guest), "a take that is sent").toBe(false);
  await guest.context().close();
});

test("3: Back goes studio to song to wall, asks before throwing a take away, and a reload on the studio lands on the song", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const song = await liveSong(seeded, "Degraus");
  const songPath = `${seeded.jamPath}/song/${song}`;
  const guest = await openAs(browser, seeded.guest, seeded.jamPath);
  const wall = new RegExp(`${seeded.jamPath}(\\?.*)?$`);
  const onSong = new RegExp(`${songPath}$`);

  // wall -> song: Back is the wall, Forward the song again
  await guest.locator("[data-jam-tile]").first().click();
  await expect(guest.locator(`[data-jam-song="${song}"]`)).toBeVisible({ timeout: 20_000 });
  await expect(guest).toHaveURL(onSong);
  await guest.goBack();
  await expect(guest).toHaveURL(wall);
  await expect(guest.locator("[data-jam-song]")).toHaveCount(0);
  await expect(guest.locator("[data-jam-tile]")).toHaveCount(1);
  await guest.goForward();
  await expect(guest).toHaveURL(onSong);
  await expect(guest.locator(`[data-jam-song="${song}"]`)).toBeVisible();

  // song -> studio: Back with nothing to lose just closes the studio
  await guest.locator("[data-jam-record-over]").click();
  await expect(guest.locator('[data-jam-studio][data-phase="setup"]')).toBeVisible({ timeout: 20_000 });
  await guest.goBack();
  await expect(guest.locator("[data-jam-studio]")).toHaveCount(0);
  await expect(guest.locator(`[data-jam-song="${song}"]`)).toBeVisible();
  await expect(guest).toHaveURL(onSong);

  // studio holding a take: Back asks, "Keep" stays, "Discard" leaves for the song
  await reviewOver(guest);
  await guest.goBack();
  const dialog = guest.getByRole("dialog").filter({ hasText: "Discard this take?" });
  await expect(dialog).toBeVisible();
  await shot(guest, "after-3-back-asks-before-discarding-the-take");
  await dialog.getByRole("button", { name: "Keep" }).click();
  await expect(guest.locator('[data-jam-studio][data-phase="review"]')).toBeVisible();
  await expect(guest).toHaveURL(onSong);
  // and Back asks again: the entry was put back
  await guest.goBack();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Discard" }).click();
  await expect(guest.locator("[data-jam-studio]")).toHaveCount(0);
  await expect(guest.locator(`[data-jam-song="${song}"]`)).toBeVisible();
  await expect(guest).toHaveURL(onSong);
  // one more Back is the wall, not the app's door
  await guest.goBack();
  await expect(guest).toHaveURL(wall);
  await expect(guest.locator("[data-jam-tile]")).toHaveCount(1);

  // the arrow in the studio and the X on the song take the history with them
  await guest.locator("[data-jam-tile]").first().click();
  await guest.locator("[data-jam-record-over]").click();
  await expect(guest.locator('[data-jam-studio][data-phase="setup"]')).toBeVisible({ timeout: 20_000 });
  await guest.getByRole("button", { name: "Back", exact: true }).first().click();
  await expect(guest.locator("[data-jam-studio]")).toHaveCount(0);
  await expect(guest).toHaveURL(onSong);
  await guest.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(guest).toHaveURL(wall);
  await guest.goForward();
  await expect(guest).toHaveURL(onSong); // the song is still the next entry: the arrow went back, it did not stack
  await guest.goBack();
  await expect(guest).toHaveURL(wall);

  // a reload on the studio lands on the song, never on a broken screen
  await guest.locator("[data-jam-tile]").first().click();
  await guest.locator("[data-jam-record-over]").click();
  await expect(guest.locator('[data-jam-studio][data-phase="setup"]')).toBeVisible({ timeout: 20_000 });
  await guest.reload();
  await expect(guest.locator(`[data-jam-song="${song}"]`)).toBeVisible({ timeout: 20_000 });
  await expect(guest.locator("[data-jam-studio]")).toHaveCount(0);
  await expect(guest).toHaveURL(onSong);
  await guest.context().close();
});

test("3: a new song's studio is a step too, and Back from it asks about the take", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const guest = await openAs(browser, seeded.guest, seeded.jamPath);
  await expect(guest.locator("[data-jam-empty]")).toBeVisible({ timeout: 20_000 });
  await guest.locator("[data-jam-empty-record]").click();
  await guest.locator("[data-jam-start-title]").fill("Passo a Passo");
  await guest.locator("[data-jam-start-go]").click();
  await expect(guest.locator('[data-jam-studio][data-phase="setup"]')).toBeVisible({ timeout: 20_000 });
  await skipTheLatencyCheck(guest);
  await recordAndStop(guest, 3);
  await expect(guest.locator('[data-jam-studio][data-phase="review"]')).toBeVisible({ timeout: 20_000 });
  await guest.goBack();
  const dialog = guest.getByRole("dialog").filter({ hasText: "Discard this take?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep" }).click();
  await guest.locator("[data-jam-post]").click();
  await expect(guest.locator("[data-jam-done]")).toBeVisible({ timeout: 60_000 });
  await guest.locator("[data-jam-done-action]").click();
  await expect(guest.locator("[data-jam-song]")).toBeVisible();
  // posted: the studio's entry became the song's, so Back is the wall
  await guest.goBack();
  await expect(guest).toHaveURL(new RegExp(`${seeded.jamPath}(\\?.*)?$`));
  await expect(guest.locator("[data-jam-tile]")).toHaveCount(1);
  await guest.context().close();
});

test("4: a microphone that ends mid-recording stops the take and says so; a silent take is flagged before it is sent", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const song = await liveSong(seeded, "Sem Fio");
  const songPath = `${seeded.jamPath}/song/${song}`;
  const keepTracks = () => {
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const w = window as unknown as { __audioTracks: MediaStreamTrack[] };
    w.__audioTracks = [];
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await real(constraints);
      if (constraints && constraints.audio) {
        w.__audioTracks.push(...stream.getAudioTracks());
      }
      return stream;
    };
  };
  const guest = await openAs(browser, seeded.guest, songPath, keepTracks);
  const endInput = () =>
    guest.evaluate(() => {
      const track = (window as unknown as { __audioTracks: MediaStreamTrack[] }).__audioTracks.at(-1)!;
      track.stop();
      track.dispatchEvent(new Event("ended"));
    });

  // ---- mid-recording, with sound already in: the take is kept ----------------
  await guest.locator("[data-jam-record-over]").click();
  await expect(guest.locator('[data-jam-studio][data-phase="setup"]')).toBeVisible({ timeout: 20_000 });
  await skipTheLatencyCheck(guest);
  const record = guest.locator("[data-jam-record]");
  await expect(record).toBeEnabled({ timeout: 20_000 });
  await record.click();
  await expect(guest.locator('[data-jam-studio][data-phase="recording"]')).toBeVisible({ timeout: 15_000 });
  await guest.waitForTimeout(3000);
  await endInput();
  await expect(guest.locator('[data-jam-studio][data-phase="review"]')).toBeVisible({ timeout: 15_000 });
  await expect(guest.locator("[data-jam-stop]")).toHaveCount(0);
  const kept = guest.locator('[data-jam-mic-lost="kept"]');
  await expect(kept).toBeVisible();
  await shot(guest, "after-4-microphone-lost-take-kept");
  await expect(kept).toContainText("The microphone stopped working");
  await expect(guest.locator("[data-jam-post]")).toBeVisible();
  // the input is shown as gone, with a way to bring it back, and recording again waits for it
  await expect(guest.getByRole("button", { name: "Try again" }).first()).toBeVisible();
  await guest.locator("[data-jam-again]").click();
  await expect(guest.locator('[data-jam-studio][data-phase="setup"]')).toBeVisible();
  await expect(guest.locator("[data-jam-record]")).toBeDisabled();
  await guest.getByRole("button", { name: "Try again" }).first().click();
  await expect(guest.locator("[data-jam-record]")).toBeEnabled({ timeout: 20_000 });

  // ---- before anything was played: nothing worth keeping, back to the start --
  await guest.locator("[data-jam-record]").click();
  await expect(guest.locator('[data-jam-studio][data-phase="countdown"]')).toBeVisible({ timeout: 15_000 });
  await endInput();
  await expect(guest.locator('[data-jam-studio][data-phase="setup"]')).toBeVisible({ timeout: 15_000 });
  await expect(guest.locator('[data-jam-mic-lost="empty"]')).toBeVisible();
  await guest.context().close();
});

test("4: a take that is silent from start to finish is flagged before it is sent, and can still be sent", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const song = await liveSong(seeded, "Mudinha");
  const silentInput = () => {
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (constraints && constraints.audio) {
        // a live track that carries nothing: a muted interface, a dead channel
        const context = new AudioContext();
        const destination = context.createMediaStreamDestination();
        const hold = context.createConstantSource();
        hold.offset.value = 0;
        hold.connect(destination);
        hold.start();
        void context.resume();
        return destination.stream;
      }
      return real(constraints);
    };
  };
  const guest = await openAs(browser, seeded.guest, `${seeded.jamPath}/song/${song}`, silentInput);
  await reviewOver(guest, 3);
  await guest.locator("[data-jam-post]").click();
  const dialog = guest.getByRole("dialog").filter({ hasText: "This take has no sound" });
  await expect(dialog).toBeVisible();
  await shot(guest, "after-4-silent-take-warning");
  await expect(guest.locator("[data-jam-posting]")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(guest.locator('[data-jam-studio][data-phase="review"]')).toBeVisible();
  await guest.locator("[data-jam-post]").click();
  await dialog.getByRole("button", { name: "Send anyway" }).click();
  await expect(guest.locator("[data-jam-done]")).toBeVisible({ timeout: 60_000 });
  await guest.context().close();
});

test("5 and 6: a stale edit sheet sends only what its person changed, and closing it with changes asks first", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const song = await liveSong(seeded, "Antes", { artist: "Banda Velha" });
  const window2 = await openAs(browser, seeded.host, `${seeded.jamPath}/song/${song}`);
  await expect(window2.locator("[data-jam-edit-open]").first()).toBeVisible({ timeout: 20_000 });
  await window2.locator("[data-jam-edit-open]").first().click();
  const title = window2.locator("[data-jam-edit-title]");
  const artist = window2.locator("[data-jam-edit-artist]");
  await expect(title).toHaveValue("Antes");

  // ---- 6: nothing typed, Escape closes at once; typed, it asks ----------------
  await window2.keyboard.press("Escape");
  await expect(window2.locator("[data-jam-edit]")).toHaveCount(0);
  await window2.locator("[data-jam-edit-open]").first().click();
  await title.fill("Digitado");
  await window2.keyboard.press("Escape");
  const discard = window2.getByRole("dialog").filter({ hasText: "Discard your changes?" });
  await expect(discard).toBeVisible();
  await shot(window2, "after-6-edit-sheet-asks-before-discarding");
  await discard.getByRole("button", { name: "Keep editing" }).click();
  await expect(title).toHaveValue("Digitado");
  await window2.keyboard.press("Escape");
  await discard.getByRole("button", { name: "Discard" }).click();
  await expect(window2.locator("[data-jam-edit]")).toHaveCount(0);

  // ---- 5: window 1 renames; window 2, already open, changes only the artist ---
  await window2.locator("[data-jam-edit-open]").first().click();
  await expect(title).toHaveValue("Antes");
  await call(seeded.host, "PATCH", `/api/jam-songs/${song}`, { title: "Depois do Outro" });
  await expect(title).toHaveValue("Depois do Outro", { timeout: 10_000 }); // an untouched field follows the song
  await artist.fill("Banda Nova");
  await window2.locator("[data-jam-edit-save]").click();
  await expect(window2.locator("[data-jam-edit]")).toHaveCount(0, { timeout: 10_000 });
  const read = await call<{ song: { title: string; artist: string | null } }>(seeded.host, "GET", `/api/jam-songs/${song}`);
  expect(read.song.title, "the title another window set was not written back over").toBe("Depois do Outro");
  expect(read.song.artist).toBe("Banda Nova");
  await window2.context().close();
});

test("7: a failed send keeps the take and offers every way out; a song closed meanwhile says so", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  const song = await liveSong(seeded, "Fora do Ar");
  const guest = await openAs(browser, seeded.guest, `${seeded.jamPath}/song/${song}`);
  await guest.route(
    (url) => url.pathname.includes("/jam/"),
    (route) => (route.request().method() === "PUT" ? route.abort("connectionreset") : route.continue()),
  );
  await reviewOver(guest);
  await guest.locator("[data-jam-post]").click();
  await expect(guest.locator("[data-jam-retry]")).toBeVisible({ timeout: 20_000 });
  const exits = guest.locator("[data-jam-post-failed]");
  await shot(guest, "after-7-failed-send-exits");
  await expect(exits.locator("[data-jam-back-to-take]")).toBeVisible();
  await expect(exits.locator("[data-jam-again]")).toBeVisible();
  await expect(exits.locator("[data-jam-discard]")).toBeVisible();
  // back to the take: still there, and it can be sent again
  await exits.locator("[data-jam-back-to-take]").click();
  await expect(guest.locator('[data-jam-studio][data-phase="review"]')).toBeVisible();
  await expect(guest.locator("[data-jam-post]")).toBeVisible();
  await expect(guest.locator("[data-jam-edit-open]")).toBeVisible();
  await guest.unroute(() => true);
  await guest.route(
    (url) => url.pathname.includes("/jam/"),
    (route) => route.continue(),
  );

  // the song is closed to new takes while the take waits
  await call(seeded.host, "PATCH", `/api/jam-songs/${song}`, { joinMode: "closed" });
  await guest.locator("[data-jam-post]").click();
  const closed = guest.locator("[data-jam-song-closed]");
  await expect(closed).toBeVisible({ timeout: 20_000 });
  await expect(closed).toContainText("closed to new takes");
  await shot(guest, "after-7-song-closed-meanwhile");
  await expect(guest.locator("[data-jam-retry]")).toHaveCount(0);
  await expect(closed.locator("[data-jam-post-as-new]")).toBeVisible();
  await closed.locator("[data-jam-back-to-wall]").click();
  await expect(guest.locator("[data-jam-studio]")).toHaveCount(0);
  await expect(guest).toHaveURL(new RegExp(`${seeded.jamPath}(\\?.*)?$`));
  await expect(guest.locator("[data-jam-tile]")).toHaveCount(1);
  await guest.context().close();
});

test("8: choosing Voz with the camera on records a vocals take, never a guitar one", async ({ browser }) => {
  const seeded = await seed();
  test.skip(!seeded.uploads, "needs object storage (S3_*): GET /api/jam/config answered uploads:false");
  for (const video of [true, false]) {
    const title = video ? "Voz com video" : "Voz sem video";
    const host = await openAs(browser, seeded.host, seeded.jamPath);
    // an empty wall has its own big button; a wall with songs has the one in the header
    await host.locator(video ? "[data-jam-empty-record]" : "[data-jam-new-song]").first().click();
    await host.locator("[data-jam-start-title]").fill(title);
    await host.locator("[data-jam-start-go]").click();
    await expect(host.locator('[data-jam-studio][data-phase="setup"]')).toBeVisible({ timeout: 20_000 });
    await expect(host.locator('[data-jam-instrument="guitar"]')).toHaveAttribute("aria-checked", "true");
    await host.locator('[data-jam-instrument="vocals"]').click();
    if (video) {
      await host.getByRole("switch", { name: /Record video too/ }).click();
      await expect(host.locator('[data-jam-studio] video[aria-label]').first()).toBeVisible({ timeout: 15_000 });
    }
    await skipTheLatencyCheck(host);
    await recordAndStop(host, 3);
    await expect(host.locator('[data-jam-studio][data-phase="review"]')).toBeVisible({ timeout: 20_000 });
    await host.locator("[data-jam-post]").click();
    await expect(host.locator("[data-jam-done]")).toBeVisible({ timeout: 90_000 });
    const list = await call<{ songs: { id: string; title: string }[] }>(seeded.host, "GET", `/api/channels/${seeded.jamId}/jam-songs`);
    const made = list.songs.find((one) => one.title === title)!;
    const detail = await call<{ tracks: { instrument: string }[] }>(seeded.host, "GET", `/api/jam-songs/${made.id}`);
    expect(detail.tracks.map((track) => track.instrument), `video ${video}`).toEqual(["vocals"]);
    await host.context().close();
  }
});
