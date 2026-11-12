/**
 * PUBLIC JAMS INSIDE THE APP, with real clicks and real keys (`docs/JAM_PUBLIC.md`,
 * `docs/JAM_SITE.md`):
 *
 *  1. PUBLISH. A song's starter makes a channel song public from its "..." menu:
 *     a sheet says what becomes public, then the song says it is public and who
 *     has answered.
 *  2. CONSENT. The person with a part in it is asked (a strip on the Jam wall, a
 *     dialog with three answers) and the starter sees the answer.
 *  3. THE PUBLIC VIEW. Somebody with no tie to the server opens it by link
 *     (`/app/jam/<id>`), likes it, reports one part.
 *  4. OUTSIDE TAKES. An arrival intent (`/app?jam=<id>&record=1&instrument=bass`)
 *     opens the studio on that instrument; the take arrives out of the mix and the
 *     starter hears it with the band, then accepts it.
 *  5. A NEW STANDALONE JAM (`/app?jam=new`) and the "Públicas" shelf on a wall.
 *  6. FLAG OFF: nothing shows, and the public site's "not open yet" page draws its
 *     headline in the display face.
 *
 * Needs object storage like `jam-web.spec.ts` (`S3_*`) and the API started with
 * `JAM_PUBLIC_MIN_ACCOUNT_AGE_HOURS=0` (the accounts here are minutes old);
 * without storage the spec skips with that reason.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";
import { FAKE_MIC_WAV } from "../playwright.jam.config";
import { materialise, seedJamShare, type JamShareSeed } from "./jam-share-seed";

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const RUN = Date.now().toString(36).slice(-5);
const SHOTS = path.resolve(process.cwd(), "../docs/pr-screenshots/jam-public-in-app");
mkdirSync(SHOTS, { recursive: true });

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
});

async function setGlobalFlag(key: string, enabled: boolean | null): Promise<void> {
  const res = await fetch(`${API}/api/admin/flags`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${E2E_ADMIN_TOKEN}` },
    body: JSON.stringify({ key, enabled }),
  });
  expect(res.status).toBe(200);
}

async function openAs(browser: Browser, suffix: string, route: string, viewport = { width: 1440, height: 900 }): Promise<Page> {
  const context = await browser.newContext({
    viewport,
    colorScheme: "dark",
    permissions: ["microphone", "camera"],
  });
  const page = await context.newPage();
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(`${route}${route.includes("?") ? "&" : "?"}lang=en`);
  return page;
}

async function ready(page: Page): Promise<void> {
  await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 25_000 });
}

async function recordAndPost(page: Page, seconds: number): Promise<void> {
  const skip = page.locator("[data-jam-skip-check]");
  await expect(page.locator("[data-jam-latency-chip]")).toBeVisible({ timeout: 25_000 });
  if (await skip.isVisible()) {
    await skip.click();
  }
  const record = page.locator("[data-jam-record]");
  await expect(record).toBeEnabled({ timeout: 25_000 });
  await record.click();
  await expect(page.locator("[data-jam-stop]")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(seconds * 1000);
  await page.locator("[data-jam-stop]").click();
  await expect(page.locator('[data-jam-studio][data-phase="review"]')).toBeVisible({ timeout: 25_000 });
}

let seed: JamShareSeed;
const jamWall = () => `/app/server/${seed.serverId}/channel/${seed.jamId}`;

test.describe.serial("public jams in the app", () => {
  test.beforeAll(async () => {
    await setGlobalFlag("jam_public", true);
    seed = await seedJamShare(API, E2E_ADMIN_TOKEN, `pub${RUN}`);
  });
  test.afterAll(async () => {
    await setGlobalFlag("jam_public", null);
  });

  test("the starter makes a song public and the person with a part answers", async ({ browser }) => {
    test.skip(!seed.uploads, "object storage is not configured (S3_*)");
    const host = await openAs(browser, seed.host, `${jamWall()}/song/${seed.riff}`);
    await ready(host);
    const panel = host.locator(`[data-jam-song="${seed.riff}"]`);
    await expect(panel).toBeVisible({ timeout: 25_000 });
    await panel.locator("[data-jam-song-menu]").click();
    await host.getByRole("menuitem", { name: "Make public" }).click();
    const sheet = host.locator('[data-jam-public-sheet="off"]');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("The sound of every recording");
    await expect(sheet).toContainText("The video of the recordings, when the person allows it");
    await expect(sheet).toContainText("The name, @handle and photo of whoever played");
    await expect(sheet.getByRole("switch", { name: "Show where it came from" })).toBeVisible();
    await host.screenshot({ path: path.join(SHOTS, "01-publish-sheet-1440-dark.png") });
    await host.locator("[data-jam-public-go]").click();
    await expect(host.locator('[data-jam-public-sheet="on"]')).toBeVisible({ timeout: 15_000 });
    await expect(host.locator('[data-jam-public-status="live"]')).toBeVisible();
    await expect(host.locator("[data-jam-public-part]")).toHaveCount(2);
    await host.screenshot({ path: path.join(SHOTS, "02-manage-sheet-1440-dark.png") });
    await host.keyboard.press("Escape");
    await expect(host.locator('[data-jam-public-line="status"]')).toContainText("Public");

    // The person with a drum part is asked, on the wall and in a dialog.
    const member = await openAs(browser, seed.member, jamWall());
    await ready(member);
    const strip = member.locator('[data-jam-waiting="consent"]');
    await expect(strip).toBeVisible({ timeout: 25_000 });
    await member.screenshot({ path: path.join(SHOTS, "03-consent-strip-1440-dark.png") });
    await member.locator('[data-jam-waiting-open="consent"]').click();
    const item = member.locator(`[data-jam-consent-item="${seed.riff}"]`);
    await expect(item).toContainText("Meu Riff");
    await member.screenshot({ path: path.join(SHOTS, "04-consent-dialog-1440-dark.png") });
    await item.locator('[data-jam-consent="yes"]').click();
    await expect(strip).toHaveCount(0);

    // The starter sees the answer.
    await host.locator("[data-jam-public-manage]").click();
    await expect(host.locator("[data-jam-public-sheet]")).toContainText("2 of 2 answered", { timeout: 15_000 });
    await host.context().close();
    await member.context().close();
  });

  test("somebody outside opens the public jam by link, likes it and reports a part", async ({ browser }) => {
    test.skip(!seed.uploads, "object storage is not configured (S3_*)");
    const page = await openAs(browser, seed.outsider, `/app/jam/${seed.riff}`);
    await ready(page);
    const view = page.locator(`[data-jam-public-view="${seed.riff}"]`);
    await expect(view).toBeVisible({ timeout: 25_000 });
    await expect(view.locator(`[data-jam-song="${seed.riff}"]`)).toBeVisible();
    await expect(view.locator("[data-jam-track]")).toHaveCount(2, { timeout: 15_000 });
    await expect(view.locator("[data-jam-origin]")).toContainText("From Ensaio");
    await view.locator("[data-jam-like]").click();
    await expect(view.locator("[data-jam-like]")).toHaveAttribute("aria-pressed", "true");
    // One like is not shown as a number.
    await expect(view.locator("[data-jam-likes]")).toHaveCount(0);
    await page.screenshot({ path: path.join(SHOTS, "05-public-view-1440-dark.png") });

    // Report one part from its lane's menu.
    await view.locator("[data-jam-track]").first().getByRole("button", { name: /More|options/i }).first().click();
    await page.getByRole("menuitem", { name: "Report this part" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Report public jam");
    await dialog.getByLabel("Spam").check();
    await dialog.getByRole("button", { name: "Send report" }).click();
    await expect(dialog).toContainText("Report sent");
    await page.keyboard.press("Escape");

    // Escape leaves the view.
    await page.keyboard.press("Escape");
    await expect(view).toHaveCount(0);
    await page.context().close();
  });

  test("an arrival intent opens the studio on that instrument, the take is a request, the starter accepts it", async ({ browser }) => {
    test.skip(!seed.uploads, "object storage is not configured (S3_*)");
    const guest = await openAs(browser, seed.outsider, `/app?jam=${seed.riff}&record=1&instrument=bass`);
    await ready(guest);
    const studio = guest.locator("[data-jam-studio]");
    await expect(studio).toBeVisible({ timeout: 30_000 });
    await expect(guest).toHaveURL(new RegExp(`/app/jam/${seed.riff}$`));
    await recordAndPost(guest, 3);
    await expect(guest.locator("[data-jam-public-take]")).toContainText("arrives as a request");
    await guest.screenshot({ path: path.join(SHOTS, "06-studio-outside-take-1440-dark.png") });
    await guest.locator("[data-jam-post]").click();
    await expect(guest.locator("[data-jam-done]")).toContainText("Sent to whoever started the jam", { timeout: 60_000 });
    await guest.locator("[data-jam-done-action]").click();
    await expect(guest.locator('[data-jam-public-line="waiting"]')).toBeVisible({ timeout: 15_000 });
    await guest.context().close();

    // The starter: the wall says it, the dialog opens the song, the take is heard with the band.
    const host = await openAs(browser, seed.host, jamWall());
    await ready(host);
    const strip = host.locator('[data-jam-waiting="inbox"]');
    await expect(strip).toBeVisible({ timeout: 25_000 });
    await host.screenshot({ path: path.join(SHOTS, "07-inbox-strip-1440-dark.png") });
    await host.locator('[data-jam-waiting-open="inbox"]').click();
    await host.locator("[data-jam-inbox-item]").getByRole("button", { name: "Listen" }).click();
    const requests = host.locator("[data-jam-requests]");
    await expect(requests).toBeVisible({ timeout: 25_000 });
    await requests.locator("[data-jam-request-listen]").click();
    await expect(requests.locator("[data-jam-request-listen]")).toHaveAttribute("aria-pressed", "true");
    await host.screenshot({ path: path.join(SHOTS, "08-requests-1440-dark.png") });
    await requests.locator("[data-jam-request-accept]").click();
    await expect(requests).toHaveCount(0, { timeout: 15_000 });
    await expect(host.locator("[data-jam-track]")).toHaveCount(3);
    await host.context().close();
  });

  test("a new standalone jam starts from the intent, and shows on a wall's Públicas shelf", async ({ browser }) => {
    test.skip(!seed.uploads, "object storage is not configured (S3_*)");
    await materialise(API, `${seed.outsider}b`);
    const maker = await openAs(browser, `${seed.outsider}b`, "/app?jam=new");
    await ready(maker);
    await maker.locator("[data-jam-start-title]").fill("Jam sem casa");
    await maker.locator("[data-jam-start-go]").click();
    await expect(maker.locator("[data-jam-studio]")).toBeVisible({ timeout: 25_000 });
    await recordAndPost(maker, 3);
    await maker.locator("[data-jam-post]").click();
    await expect(maker.locator("[data-jam-done]")).toBeVisible({ timeout: 60_000 });
    await maker.locator("[data-jam-done-action]").click();
    await expect(maker.locator('[data-jam-public-view]')).toBeVisible({ timeout: 25_000 });
    await expect(maker.locator("[data-jam-song]")).toContainText("Jam sem casa");
    await expect(maker.locator("[data-jam-track]")).toHaveCount(1, { timeout: 15_000 });
    await maker.screenshot({ path: path.join(SHOTS, "09-new-jam-1440-dark.png") });
    await maker.context().close();

    const member = await openAs(browser, seed.member, jamWall());
    await ready(member);
    const shelf = member.locator("[data-jam-public-shelf]");
    await expect(shelf).toBeVisible({ timeout: 25_000 });
    await expect(shelf).toContainText("Jam sem casa");
    // The channel's own songs get a header only now that there are two sections.
    await expect(member.locator("[data-jam-section-title]")).toBeVisible();
    await expect(shelf.locator("[data-jam-public-all]")).toBeVisible();
    await member.screenshot({ path: path.join(SHOTS, "10-wall-with-shelf-1440-dark.png") });
    await shelf.getByRole("button", { name: /Jam sem casa/ }).click();
    await expect(member.locator("[data-jam-public-view]")).toBeVisible();
    await expect(member).toHaveURL(/\/app\/jam\//);
    await member.goBack();
    await expect(member.locator("[data-jam-public-view]")).toHaveCount(0);
    await member.context().close();
  });

  test("flag off: nothing in the app, and the public site's headline is in the display face", async ({ browser }) => {
    await setGlobalFlag("jam_public", false);
    try {
      const member = await openAs(browser, seed.member, jamWall());
      await ready(member);
      await expect(member.locator("[data-jam-public-shelf]")).toHaveCount(0);
      await expect(member.locator("[data-jam-waiting]")).toHaveCount(0);
      await expect(member.locator("[data-jam-section-title]")).toHaveCount(0);
      await member.goto(`/app/jam/${seed.riff}?lang=en`);
      await expect(member.locator("[data-jam-public-view]")).toContainText("Public jams are not live yet.", { timeout: 25_000 });
      await member.context().close();

      const site = await openAs(browser, "visitor", "/jam");
      await expect(site.locator("[data-jam-soon]")).toBeVisible({ timeout: 25_000 });
      const face = await site.evaluate(async () => {
        await document.fonts.ready;
        const heading = document.querySelector("[data-jam-soon] h1")!;
        const used = getComputedStyle(heading).fontFamily;
        const loaded = [...document.fonts].filter((f) => f.family.replace(/"/g, "") === "Gabarito" && f.status === "loaded").length;
        return { used, loaded };
      });
      expect(face.used).toContain("Gabarito");
      expect(face.loaded).toBeGreaterThan(0);
      await site.context().close();
    } finally {
      await setGlobalFlag("jam_public", true);
    }
  });
});
