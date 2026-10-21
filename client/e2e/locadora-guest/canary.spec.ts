import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page, type Request } from "@playwright/test";
import { snesPattern } from "../../../apps/locadora/e2e/patterns";
import { startAppsOrigin, type AppsOrigin } from "./apps";

/**
 * LOCADORA WITHOUT AN ACCOUNT, AS A VISITOR USES IT, AND THE RULE THAT MATTERS:
 * THE FILE NEVER LEAVES THE DEVICE.
 *
 * A signed-out visitor opens `/apps/locadora`, presses "Botar a fita", picks
 * a cartridge through the page's picker, lands in the player with it already
 * in (nothing asked, no second picker), plays, ejects, and gets the sign-up
 * card. Every request the page makes (the page and the app frame, any
 * origin) is recorded with its URL, headers and body, and the suite fails if
 * the cartridge's title, its file name or its SHA-256 (hex, base64 or
 * base64url) appears in any of them. The cartridge is a generated SNES test
 * pattern (`apps/locadora/e2e/patterns.ts`), never a game, with a canary title
 * of our own written into its header so Locadora reads it and draws it on the
 * shelf. It also pins that the only call to pqp's API is the public config.
 */

const CANARY_TITLE = "PQP GUEST CANARY 7F3A";
const CANARY_FILE = "guest-canary-7f3a.sfc";

/** The SNES pattern with the canary as its header title, the checksum pair recomputed. */
function canaryCartridge(): Buffer {
  const rom = snesPattern();
  Buffer.from(CANARY_TITLE.padEnd(21, " ").slice(0, 21), "ascii").copy(rom, 0x7fc0);
  rom.writeUInt16LE(0xffff, 0x7fdc);
  rom.writeUInt16LE(0x0000, 0x7fde);
  let sum = 0;
  for (const byte of rom) sum = (sum + byte) & 0xffff;
  rom.writeUInt16LE(sum ^ 0xffff, 0x7fdc);
  rom.writeUInt16LE(sum, 0x7fde);
  return rom;
}

const clientPort = Number(process.env.E2E_GUEST_CLIENT_PORT ?? 5241);
const serverPort = Number(process.env.E2E_GUEST_SERVER_PORT ?? 3141);
const appsPort = Number(process.env.E2E_GUEST_APPS_PORT ?? 5242);
const CLIENT = `http://localhost:${clientPort}`;
const API = `http://localhost:${serverPort}`;

let apps: AppsOrigin;
let scratch: string;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  apps = await startAppsOrigin(appsPort, CLIENT);
  scratch = mkdtempSync(join(tmpdir(), "pqp-guest-canary-"));
  // A cold `vite dev` optimises the dependencies it meets on the first visit and reloads the page once, which
  // reads as page errors in whatever test comes first. Pay that here, on both pages, before anything is measured.
  const warm = await browser.newPage({ baseURL: CLIENT });
  for (const [path, ready] of [
    ["/locadora/jogar", "iframe[data-app-frame]"],
    ["/apps/locadora", "h1"],
  ] as const) {
    await warm.goto(path);
    await warm.locator(ready).first().waitFor({ timeout: 60_000 });
    await warm.waitForTimeout(1_500);
  }
  await warm.close();
});

test.afterAll(async () => {
  await apps?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

interface Recorded {
  url: string;
  method: string;
  headers: string;
  body: string;
}

function record(page: Page): Recorded[] {
  const seen: Recorded[] = [];
  page.context().on("request", (request: Request) => {
    const buffer = request.postDataBuffer();
    seen.push({
      url: request.url(),
      method: request.method(),
      headers: JSON.stringify(request.headers()),
      // a body is searched as text and as raw bytes read as latin1, so a binary upload hides nothing
      body: buffer ? `${buffer.toString("utf8")} ${buffer.toString("latin1")}` : "",
    });
  });
  return seen;
}


test("a guest plays a cartridge and nothing about it leaves the page", async ({ page }) => {
  const rom = canaryCartridge();
  const path = join(scratch, CANARY_FILE);
  writeFileSync(path, rom);
  const hex = createHash("sha256").update(rom).digest("hex");
  const needles = [
    CANARY_TITLE,
    CANARY_TITLE.toLowerCase(),
    encodeURIComponent(CANARY_TITLE),
    "CANARY 7F3A",
    "canary-7f3a",
    CANARY_FILE,
    hex,
    hex.toUpperCase(),
    Buffer.from(hex, "hex").toString("base64"),
    Buffer.from(hex, "hex").toString("base64url"),
  ];
  const requests = record(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // the landing's door: "Botar a fita", the page's own picker, and the player opens with the cartridge already in
  await page.goto("/apps/locadora");
  const chooser = page.waitForEvent("filechooser");
  await page.locator("[data-locadora-door]").click();
  await (await chooser).setFiles(path);
  await page.waitForURL(/\/locadora\/jogar$/);
  // nothing asked before playing: no age question, straight to the frame
  await expect(page.locator("[data-locadora-age]")).toHaveCount(0);
  const frame = (await (await page.waitForSelector("iframe[data-app-frame]")).contentFrame())!;
  await frame.locator("#loc:not([data-view=connecting])").waitFor({ timeout: 60_000 });
  await expect(frame.locator("#loc")).toHaveAttribute("data-guest", "true");
  // no second picker: the console boots on its own with the file from the door
  const start = frame.locator('.loc-start[data-choice="fresh"]').first();
  await start.waitFor({ state: "visible", timeout: 60_000 });
  await start.click();
  await page.waitForTimeout(1_500);
  // never over a running game
  await expect(page.locator("[data-locadora-upsell]")).toHaveCount(0);
  // a guest has no share (the host says `shareAllowed: false`): no pill, and no account saves either
  await expect(frame.locator('[data-action="share"]')).toBeHidden();
  await expect(frame.locator("#loc")).not.toHaveAttribute("data-sync", /.+/);
  await frame.locator("#game").focus();
  // mute works here too: the emulator is silenced, and M again gives the sound back
  await page.keyboard.press("KeyM");
  await expect
    .poll(() => frame.evaluate(() => (window as unknown as { EJS_emulator?: { muted?: boolean } }).EJS_emulator?.muted))
    .toBe(true);
  await page.keyboard.press("KeyM");
  await expect
    .poll(() => frame.evaluate(() => (window as unknown as { EJS_emulator?: { muted?: boolean } }).EJS_emulator?.muted))
    .toBe(false);
  await page.keyboard.press("F2"); // a save, into the guest's own store
  await page.waitForTimeout(31_000);
  await expect(page.locator("[data-locadora-upsell]")).toHaveCount(0);
  await frame.locator("#game").focus();
  await page.keyboard.press("F8"); // eject: a calm moment

  // the shelf drew the canary title, so the app really read it
  await expect(frame.getByText(/PQP GUEST CANARY/i).first()).toBeVisible({ timeout: 20_000 });
  const card = page.locator("[data-locadora-upsell]");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.locator('[data-claim-view="soon"]')).toHaveCount(1);

  for (const request of requests) {
    for (const needle of needles) {
      expect(request.url.includes(needle), `${needle} in the URL of ${request.method} ${request.url}`).toBe(false);
      expect(request.headers.includes(needle), `${needle} in the headers of ${request.url}`).toBe(false);
      expect(request.body.includes(needle), `${needle} in the body of ${request.method} ${request.url}`).toBe(false);
    }
  }
  // the only origins: the page, pqp's API and the apps origin
  const origins = new Set(requests.map((request) => new URL(request.url).origin).filter((origin) => origin !== "null"));
  for (const origin of origins) {
    expect([CLIENT, API, apps.origin], origin).toContain(origin);
  }
  // and the only calls to pqp's API are public configs: the apps one, and the communities one the landing's
  // site nav asks (the player page itself asks only the first)
  const api = new Set(requests.filter((request) => request.url.startsWith(API)).map((request) => new URL(request.url).pathname));
  expect([...api].sort()).toEqual(expect.arrayContaining(["/api/public/apps/config"]));
  for (const path of api) expect(["/api/public/apps/config", "/api/public/communities/config"], path).toContain(path);
  expect(errors).toEqual([]);

  // "Criar conta grátis" carries the ref through sign-up (the dev bypass has no sign-up: it lands on the app)
  await card.locator("[data-apps-cta]").click();
  await page.waitForURL(/\/app\?ref=locadora-guest/);
  const stash = await page.evaluate(() => localStorage.getItem("pqp:acquisition"));
  expect(JSON.parse(stash ?? "{}")).toMatchObject({ ref: "locadora-guest" });
});

test("the card is once a day: a device that saw it today plays and ejects without it", async ({ page }) => {
  await page.goto("/locadora/jogar");
  await page.evaluate(() =>
    localStorage.setItem("pqp:locadora-guest-upsell", JSON.stringify({ shownAt: Date.now() - 60_000 })),
  );
  await page.reload();
  const frame = (await (await page.waitForSelector("iframe[data-app-frame]")).contentFrame())!;
  await frame.locator("#loc:not([data-view=connecting])").waitFor({ timeout: 60_000 });
  // a guest lands on the Balcão, "Botar fita" first, not on the welcome
  await expect(frame.locator("#loc")).toHaveAttribute("data-view", "balcao");
  const path = join(scratch, "once-a-day.sfc");
  writeFileSync(path, snesPattern());
  const chooser = page.waitForEvent("filechooser");
  await frame.locator(".loc-top-pick").click();
  await (await chooser).setFiles(path);
  const start = frame.locator('.loc-start[data-choice="fresh"]').first();
  await start.waitFor({ state: "visible", timeout: 60_000 });
  await start.click();
  await page.waitForTimeout(32_000);
  await frame.locator("#game").focus();
  await page.keyboard.press("F8");
  await frame.locator(".loc-top-pick").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(2_000);
  await expect(page.locator("[data-locadora-upsell]")).toHaveCount(0);
});

test("with guest play off, both addresses send the visitor home and the landing has no door", async ({ page }) => {
  await page.route("**/api/public/apps/config", (route) =>
    route.fulfill({ json: { enabled: true, guest: false, cloudSaves: false, locadora: null } }),
  );
  for (const path of ["/locadora/jogar", "/apps/locadora/play"]) {
    await page.goto(path);
    await page.waitForURL((url) => url.pathname === "/");
  }
  await page.goto("/apps/locadora");
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.locator("[data-locadora-door]")).toHaveCount(0);
});

test("with the landing off, the player is off too, whatever guest says", async ({ page }) => {
  await page.route("**/api/public/apps/config", (route) =>
    route.fulfill({ json: { enabled: false, guest: true, cloudSaves: false, locadora: null } }),
  );
  await page.goto("/locadora/jogar");
  await page.waitForURL((url) => url.pathname === "/");
});

test("a file dropped on the door goes straight in, and one that does not fit says so", async ({ page }) => {
  await page.goto("/apps/locadora");
  await page.locator("[data-locadora-door]").waitFor();
  const drop = async (name: string, bytes: number[]) =>
    page.evaluate(
      ({ name, bytes }) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(bytes)], name));
        const hero = document.querySelector("[data-locadora-hero]")!;
        for (const type of ["dragenter", "dragover", "drop"]) {
          hero.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }));
        }
      },
      { name, bytes },
    );
  await drop("notes.txt", [1, 2, 3]);
  await expect(page.getByText("That cartridge does not fit", { exact: false })).toBeVisible();
  await drop("dropped.sfc", [...snesPattern()]);
  await page.waitForURL(/\/locadora\/jogar$/);
  const frame = (await (await page.waitForSelector("iframe[data-app-frame]")).contentFrame())!;
  await frame.locator('.loc-start[data-choice="fresh"]').first().waitFor({ state: "visible", timeout: 60_000 });
});

test("with guest play off, the landing's big button is the sign-up", async ({ page }) => {
  await page.route("**/api/public/apps/config", (route) =>
    route.fulfill({ json: { enabled: true, guest: false, cloudSaves: false, locadora: null } }),
  );
  await page.goto("/apps/locadora");
  await expect(page.locator("[data-locadora-door]")).toHaveCount(0);
  await page.locator('section[aria-labelledby="locadora-title"] [data-apps-cta="locadora-landing"]').click();
  await page.waitForURL(/\/app\?ref=locadora-landing/);
});
