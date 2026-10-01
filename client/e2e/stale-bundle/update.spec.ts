import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildFixture } from "./builds";
import { startPagesServer, type PagesServer } from "./pages-server";

/**
 * "Nobody stays on an old bundle", on real builds and a real service worker.
 *
 * Two builds of one source tree (they differ only in their build id) stand in
 * for "before the deploy" and "after the deploy". A page loads the first; the
 * stand-in for Cloudflare Pages is switched to the second UNDER it; and the
 * specs ask what the person sees, and which build the page is on afterwards.
 *
 * The page's own clock is faked (`page.clock`) so twelve minutes of timer
 * cost nothing. The service worker's is real.
 */

const OLD = "fixture-old";
const NEW = "fixture-new";
const CARD = '[data-corner-card="update"]';

let server: PagesServer;
let oldDir: string;
let newDir: string;
/** A worker from BEFORE the fix: it waits instead of taking over, and answers navigations from its precache. */
let legacyDir: string;

test.beforeAll(async () => {
  oldDir = buildFixture("old", OLD);
  newDir = buildFixture("new", NEW);
  legacyDir = buildFixture("legacy", "fixture-legacy", { legacyWorker: true });
  server = await startPagesServer({
    headersFile: path.resolve(import.meta.dirname, "../../public/_headers"),
  });
});

test.afterAll(async () => {
  await server.close();
});

test.beforeEach(() => {
  server.pin("/sw.js", null);
  server.serve(oldDir);
});

async function buildOf(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.documentElement.dataset.pqpBuild);
}

/** The page is on `build` and a worker controls it (precache answering). */
async function openOn(page: Page, build: string) {
  await page.goto(`${server.origin}/`);
  await expect(page.locator("html")).toHaveAttribute("data-pqp-build", build);
  // A first-time visitor on the landing page gets a worker on their first touch,
  // click or key press (or after 20 s), not on load: see `lib/register-sw.ts`.
  // The person in this spec is somebody who has started using the page.
  await page.mouse.click(5, 5);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}

/** What a composer with a half-written message looks like to the update code. */
async function startTyping(page: Page) {
  await page.evaluate(() => {
    const box = document.createElement("textarea");
    box.value = "rascunho";
    document.body.append(box);
    box.focus();
  });
}

test("a deploy under an open page becomes the card, and one click lands on the new build", async ({
  page,
}) => {
  await page.clock.install();
  await openOn(page, OLD);
  await startTyping(page);

  server.serve(newDir);
  // Past the twelve-minute timer and its jitter. Nothing navigated, nothing
  // reloaded: the page finds out by itself.
  await page.clock.fastForward("16:00");

  const card = page.locator(CARD);
  await expect(card).toBeVisible();
  await expect(card).toContainText("Nova versão do pqp disponível.");
  // Still the old build: somebody was typing, and nothing reloads under them.
  expect(await buildOf(page)).toBe(OLD);

  await card.getByRole("button", { name: "Atualizar agora" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-pqp-build", NEW);
  await expect(page.locator(CARD)).toHaveCount(0);
});

test("Later hides the card and it comes back", async ({ page }) => {
  await page.clock.install();
  await openOn(page, OLD);
  await startTyping(page);
  server.serve(newDir);
  await page.clock.fastForward("16:00");

  const card = page.locator(CARD);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Depois", exact: true }).click();
  await expect(card).toHaveCount(0);

  await page.clock.fastForward("21:00");
  await expect(card).toBeVisible();
});

test("an idle page takes the new build by itself", async ({ page }) => {
  await page.clock.install();
  await openOn(page, OLD);

  server.serve(newDir);
  await page.clock.fastForward("16:00");

  await expect(page.locator("html")).toHaveAttribute("data-pqp-build", NEW);
});

test("a plain reload reaches the new build once its worker has taken over", async ({
  page,
}) => {
  // The trap this PR exists for: with the new worker WAITING, every reload was
  // answered from the old precache. Three in a row did, in a real browser.
  await openOn(page, OLD);
  server.serve(newDir);

  await expect
    .poll(
      async () => {
        await page.reload();
        // The landing page starts the app once its first screen has settled,
        // so the build id is stamped a moment after load, not at load.
        await page.waitForFunction(() => !!document.documentElement.dataset.pqpBuild);
        return buildOf(page);
      },
      { timeout: 30_000, intervals: [1_000] },
    )
    .toBe(NEW);
});

test("an operator-forced update blocks with one button, and the button lands on the new build", async ({
  page,
}) => {
  await page.route("**/api/client-update/config", (route) =>
    route.fulfill({ json: { forceUpdate: true, minBuiltAt: null } }),
  );
  await page.clock.install();
  await openOn(page, OLD);
  await startTyping(page);

  server.serve(newDir);
  await page.clock.fastForward("16:00");

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Atualização necessária");
  await expect(dialog.getByRole("button")).toHaveCount(1);

  // No way out: not Escape, not a click outside.
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 5);
  await expect(dialog).toBeVisible();
  expect(await buildOf(page)).toBe(OLD);

  await dialog.getByRole("button", { name: "Atualizar agora" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-pqp-build", NEW);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a forced update shows nothing while the server says no", async ({ page }) => {
  await page.route("**/api/client-update/config", (route) =>
    route.fulfill({ json: { forceUpdate: false, minBuiltAt: null } }),
  );
  await page.clock.install();
  await openOn(page, OLD);
  await startTyping(page);
  server.serve(newDir);
  await page.clock.fastForward("16:00");

  await expect(page.locator(CARD)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("when the CDN keeps serving the OLD worker, the update still lands (caches purged, page reloaded)", async ({
  page,
}) => {
  // What `pqp.gg` can do: Pages is on the new build, `/sw.js` is answered by an
  // edge cache that is not. The browser finds nothing to install, so "nothing
  // is installing" is true and means nothing. `apply-update.ts` asks the worker
  // which build it is, hears the old one, and goes round it.
  await page.clock.install();
  await openOn(page, OLD);
  await startTyping(page);

  server.pin("/sw.js", path.join(oldDir, "sw.js"));
  server.serve(newDir);
  await page.clock.fastForward("16:00");

  const card = page.locator(CARD);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Atualizar agora" }).click();

  await expect(page.locator("html")).toHaveAttribute("data-pqp-build", NEW, {
    timeout: 30_000,
  });
});

test("the files that decide the build are served uncacheable", async ({ page }) => {
  server.serve(newDir);
  const headers = async (url: string) =>
    (await page.request.get(`${server.origin}${url}`)).headers()["cache-control"];

  expect(await headers("/")).toBe("no-cache");
  expect(await headers("/sw.js")).toBe("no-cache");
  expect(await headers("/version.json")).toBe("no-store");
  const version = await (await page.request.get(`${server.origin}/version.json`)).json();
  expect(version.build).toBe(NEW);
});

// ---------------------------------------------------------------- the language

/**
 * Reported from the web on 2026-09-30: somebody on an old version hard-reloaded
 * (Ctrl+Shift+R) and got the new site, then changed the language and the OLD site
 * came back. A hard reload bypasses the service worker for ONE load; the language
 * change is a full navigation (`location.replace`), which the worker answers, and
 * a worker that is still the old one answers it from the old precache. It needs a
 * second tab of the site open on the old page: that tab keeps the old worker
 * controlling, so a waiting one cannot take over.
 */

/** A second tab on the old page, then a hard reload of the first onto whatever is deployed. */
async function hardReloadWithAnotherTabOpen(
  context: BrowserContext,
  page: Page,
  deploy: () => void,
) {
  await page.goto(`${server.origin}/`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  const other = await context.newPage();
  await other.goto(`${server.origin}/`);
  await other.evaluate(() => navigator.serviceWorker.ready);
  await other.reload();
  await page.bringToFront();

  deploy();
  // Ctrl+Shift+R: this one load skips the worker.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setBypassServiceWorker", { bypass: true });
  await page.reload();
  await cdp.send("Network.setBypassServiceWorker", { bypass: false });
}

async function chooseEnglish(page: Page) {
  await page.getByRole("button", { name: /Idioma/ }).first().click();
  await page.getByRole("menuitem", { name: /English|Inglês/ }).click();
  await page.waitForLoadState("load");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
}

/** Which build the ACTIVE worker says it is, or null (a worker from before it could say). */
async function activeWorkerBuild(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const worker = registration?.active;
    if (!worker) {
      return null;
    }
    return new Promise<string | null>((resolve) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 1000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        resolve((event.data as { build?: string })?.build ?? null);
      };
      worker.postMessage({ type: "PQP_BUILD" }, [channel.port2]);
    });
  });
}

test("hard reload onto the new build, then a language change: still the new build, at once", async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: "pt-BR" });
  const page = await context.newPage();
  await hardReloadWithAnotherTabOpen(context, page, () => server.serve(newDir));
  await expect(page.locator("html")).toHaveAttribute("data-pqp-build", NEW);

  // No waiting for the new worker: the language change comes right behind the
  // hard reload, when the worker in charge is still the old build's.
  await page.goto(`${server.origin}/`);
  await chooseEnglish(page);

  await expect(page.locator("html")).toHaveAttribute("data-pqp-build", NEW);
  await context.close();
});

test("a person on a worker from before the fix: once the fixed worker is in, a language change stays on the new build", async ({
  browser,
}) => {
  server.serve(legacyDir);
  const context = await browser.newContext({ locale: "pt-BR" });
  const page = await context.newPage();
  await hardReloadWithAnotherTabOpen(context, page, () => server.serve(newDir));

  // The fixed worker installs and takes over from the old one even with the
  // other tab still open: that is what `skipWaiting` is for.
  await expect.poll(() => activeWorkerBuild(page), { timeout: 30_000 }).toBe(NEW);

  await chooseEnglish(page);
  await expect(page.locator("html")).toHaveAttribute("data-pqp-build", NEW);
  await context.close();
});

test("offline, a navigation is still answered: the precached shell is the fallback", async ({
  browser,
}) => {
  server.serve(newDir);
  const context = await browser.newContext({ locale: "pt-BR" });
  const page = await context.newPage();
  await openOn(page, NEW);

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-pqp-build", NEW);
  await context.close();
});

test("exactly one handler answers a navigation: Workbox's own navigation route is not built in", async () => {
  // Two fetch listeners that both call `respondWith` make the second throw
  // `InvalidStateError`. The network-first handler is the one; the legacy
  // fixture (a worker from before it) is the only build that has Workbox's.
  expect(readFileSync(path.join(newDir, "sw.js"), "utf8")).not.toContain("NavigationRoute");
  expect(readFileSync(path.join(legacyDir, "sw.js"), "utf8")).toContain("NavigationRoute");
});
