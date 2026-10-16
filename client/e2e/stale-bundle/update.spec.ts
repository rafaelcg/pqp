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
const INDICATOR = "[data-update-indicator]";
const POPOVER = "[data-update-popover]";

let server: PagesServer;
let oldDir: string;
let newDir: string;
/** A worker from BEFORE the fix: it waits instead of taking over, and answers navigations from its precache. */
let legacyDir: string;
/** The old build, with the daily announcement ON (09:00 UTC), as production ships it. */
let oldGatedDir: string;

test.beforeAll(async () => {
  oldDir = buildFixture("old", OLD);
  oldGatedDir = buildFixture("old-gated", "fixture-old-gated", {
    announceHourUtc: "9",
  });
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
  server.fail("/robots.txt", null);
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


/**
 * Age the page's clock until `target` shows, in small steps.
 *
 * One big `fastForward` would also fire the API client's own 12-second request
 * timeout (a page timer) in the same jump, aborting the force-config request the
 * check has just made and reading as "no force": the page then reloads itself
 * instead of blocking. Real time does not do that, so neither may the test.
 */
async function ageUntilVisible(page: Page, target: ReturnType<Page["locator"]>) {
  await page.clock.fastForward("11:50");
  for (let i = 0; i < 100; i += 1) {
    if (await target.isVisible()) {
      return;
    }
    await page.clock.fastForward(5_000);
    await page.waitForTimeout(100);
  }
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

test("a deploy under an open page becomes a quiet indicator, and the popover's button lands on the new build", async ({
  page,
}) => {
  await page.clock.install();
  await openOn(page, OLD);
  await startTyping(page);

  server.serve(newDir);
  // Past the twelve-minute timer and its jitter. Nothing navigated, nothing
  // reloaded: the page finds out by itself.
  await ageUntilVisible(page, page.locator(INDICATOR));

  const indicator = page.locator(INDICATOR);
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveAttribute("aria-label", "Nova versão pronta");
  // It does not open by itself, and there is no dialog and no card.
  await expect(page.locator(POPOVER)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator('[data-corner-card="update"]')).toHaveCount(0);
  // Still the old build: somebody was typing, and nothing reloads under them.
  expect(await buildOf(page)).toBe(OLD);

  await indicator.click();
  const popover = page.locator(POPOVER);
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("Nova versão pronta");
  await expect(popover).toContainText("O que mudou");
  await popover.getByRole("button", { name: "Atualizar", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-pqp-build", NEW);
  await expect(page.locator(INDICATOR)).toHaveCount(0);
});

test("the popover closes on Escape, the indicator stays, and it never comes back on its own", async ({
  page,
}) => {
  await page.clock.install();
  await openOn(page, OLD);
  await startTyping(page);
  server.serve(newDir);
  await ageUntilVisible(page, page.locator(INDICATOR));

  await page.locator(INDICATOR).click();
  await expect(page.locator(POPOVER)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(POPOVER)).toHaveCount(0);
  await expect(page.locator(INDICATOR)).toBeVisible();

  // Twenty minutes was the old card's snooze: nothing pops back up.
  await page.clock.fastForward("21:00");
  await expect(page.locator(POPOVER)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a build is not announced the minute it lands: the daily announcement holds it, then lets it out", async ({
  page,
}) => {
  server.serve(oldGatedDir);
  await page.clock.install();
  await openOn(page, "fixture-old-gated");
  await startTyping(page);

  server.serve(newDir);
  await page.clock.fastForward("11:50");
  for (let i = 0; i < 12; i += 1) {
    await page.clock.fastForward(5_000);
    await page.waitForTimeout(100);
  }
  // Twelve minutes on, and the page knows about the new build and says nothing.
  await expect(page.locator(INDICATOR)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await buildOf(page)).toBe("fixture-old-gated");

  // The next 09:00 UTC (and the page's own few minutes of jitter) is at most
  // a day and an hour away.
  await page.clock.fastForward("26:00:00");
  await ageUntilVisible(page, page.locator(INDICATOR));
  await expect(page.locator(INDICATOR)).toBeVisible();
  expect(await buildOf(page)).toBe("fixture-old-gated");
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

test("the operator's force switch announces at once and draws the indicator louder, and blocks nobody", async ({
  page,
}) => {
  // `client_force_update` used to put a blocking screen up for everybody on
  // every deploy. It now means "announce this one now, with emphasis".
  await page.route("**/api/client-update/config", (route) =>
    route.fulfill({ json: { forceUpdate: true, minBuiltAt: null } }),
  );
  await page.clock.install();
  server.serve(oldGatedDir);
  await openOn(page, "fixture-old-gated");
  await startTyping(page);

  server.serve(newDir);
  await ageUntilVisible(page, page.locator(INDICATOR));

  const indicator = page.locator(INDICATOR);
  // Even on a bundle that holds new builds for the morning: the operator asked.
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveAttribute("data-update-emphasis", "");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 5);
  expect(await buildOf(page)).toBe("fixture-old-gated");
  // The page is fully usable: nothing sits over it.
  await expect(page.locator("textarea")).toBeVisible();
});

test("a CRITICAL update reloads by itself, once, even with somebody typing", async ({
  page,
}) => {
  await page.route("**/api/client-update/config", (route) =>
    route.fulfill({
      json: {
        forceUpdate: false,
        minBuiltAt: null,
        interruptCalls: false,
        criticalMinBuiltAt: Date.now() + 86_400_000,
      },
    }),
  );
  await page.clock.install();
  await openOn(page, OLD);
  await startTyping(page);

  server.serve(newDir);
  await page.clock.fastForward("11:50");
  for (let i = 0; i < 100; i += 1) {
    if ((await buildOf(page).catch(() => OLD)) === NEW) {
      break;
    }
    await page.clock.fastForward(5_000).catch(() => {});
    await page.waitForTimeout(100);
  }
  await expect(page.locator("html")).toHaveAttribute("data-pqp-build", NEW);
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
  await ageUntilVisible(page, page.locator(INDICATOR));

  await expect(page.locator(INDICATOR)).toBeVisible();
  await page.locator(INDICATOR).click();
  await page
    .locator(POPOVER)
    .getByRole("button", { name: "Atualizar", exact: true })
    .click();

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

// ------------------------------------------------- the worker can install at all

/**
 * Found on 2026-10-10: production's worker could not install, in any browser.
 * Three standalone pages in `public/` were precached, Pages answers `/x.html`
 * with a 308 to `/x`, and the edge middleware turned `/x` into a 404 because
 * no SPA route knew it. One non-200 entry fails Workbox's install, so the new
 * worker went redundant on every deploy, and a person whose worker predated
 * the network-first handler kept getting the old build on every plain reload
 * (a hard reload skips the worker, so it showed the new one).
 */

/** The URLs the built worker precaches, as it would request them. */
function precacheUrls(dir: string): string[] {
  const sw = readFileSync(path.join(dir, "sw.js"), "utf8");
  return [...sw.matchAll(/\{url:"([^"]+)",revision:/g)].map((m) => `/${m[1]!}`);
}

test("every precached URL answers 200 at the edge", async ({ page }) => {
  server.serve(newDir);
  const urls = precacheUrls(newDir);
  expect(urls.length).toBeGreaterThan(20);
  const failed: string[] = [];
  for (const url of urls) {
    const response = await page.request.get(`${server.origin}${url}`);
    if (response.status() !== 200) {
      failed.push(`${url} ${response.status()}`);
    }
  }
  expect(failed).toEqual([]);
});

test("a fresh worker installs and activates", async ({ browser }) => {
  server.serve(newDir);
  const context = await browser.newContext({ locale: "pt-BR" });
  const page = await context.newPage();
  await page.goto(`${server.origin}/`);
  const states = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register("/sw.js");
    const worker = registration.installing ?? registration.waiting ?? registration.active!;
    const seen = [worker.state];
    await new Promise<void>((resolve) => {
      if (worker.state === "activated") {
        resolve();
        return;
      }
      worker.addEventListener("statechange", () => {
        seen.push(worker.state);
        if (worker.state === "activated" || worker.state === "redundant") {
          resolve();
        }
      });
    });
    return seen;
  });
  expect(states.at(-1)).toBe("activated");
  await context.close();
});

test("a failed install tells the page which file broke it", async ({ browser }) => {
  server.serve(newDir);
  // `robots.txt` is precached with a revision, so a 404 on it fails the install.
  server.fail("/robots.txt", 404);
  const context = await browser.newContext({ locale: "pt-BR" });
  const page = await context.newPage();
  await page.goto(`${server.origin}/`);
  const result = await page.evaluate(async () => {
    const messages: unknown[] = [];
    navigator.serviceWorker.addEventListener("message", (event) => messages.push(event.data));
    navigator.serviceWorker.startMessages();
    const registration = await navigator.serviceWorker.register("/sw.js");
    const worker = registration.installing ?? registration.waiting ?? registration.active!;
    await new Promise<void>((resolve) => {
      if (worker.state === "redundant") {
        resolve();
        return;
      }
      worker.addEventListener("statechange", () => {
        if (worker.state === "redundant" || worker.state === "activated") {
          resolve();
        }
      });
    });
    // The message is posted before the install fails; give delivery a moment.
    for (let i = 0; i < 20 && messages.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { state: worker.state, messages };
  });
  expect(result.state).toBe("redundant");
  expect(result.messages).toContainEqual({
    type: "PQP_SW_INSTALL_FAILED",
    build: NEW,
    reason: "bad-precaching-response",
    path: "/robots.txt",
    status: 404,
  });
  await context.close();
});

test("a person on a worker from before the fix: a plain reload reaches the new build", async ({
  browser,
}) => {
  server.serve(legacyDir);
  const context = await browser.newContext({ locale: "pt-BR" });
  const page = await context.newPage();
  await page.goto(`${server.origin}/`);
  // The legacy worker does not claim the page it installed from: one reload
  // puts the page under it, as for anybody who came back the next day.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await expect(page.locator("html")).toHaveAttribute("data-pqp-build", "fixture-legacy");

  server.serve(newDir);
  await expect
    .poll(
      async () => {
        // Cmd+R, then read the build the page booted (set once the bundle runs).
        await page.reload();
        await page.waitForFunction(() => !!document.documentElement.dataset.pqpBuild);
        return buildOf(page);
      },
      { timeout: 30_000, intervals: [500, 1000, 2000] },
    )
    .toBe(NEW);
  await context.close();
});

test("exactly one handler answers a navigation: Workbox's own navigation route is not built in", async () => {
  // Two fetch listeners that both call `respondWith` make the second throw
  // `InvalidStateError`. The network-first handler is the one; the legacy
  // fixture (a worker from before it) is the only build that has Workbox's.
  expect(readFileSync(path.join(newDir, "sw.js"), "utf8")).not.toContain("NavigationRoute");
  expect(readFileSync(path.join(legacyDir, "sw.js"), "utf8")).toContain("NavigationRoute");
});

// ------------------------------------------------- a forced update that FAILS

test("an update with no network says so, gives the button back, and lands once the network is back", async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: "pt-BR" });
  const page = await context.newPage();
  await page.clock.install();
  server.serve(oldDir);
  await openOn(page, OLD);
  await startTyping(page);
  server.serve(newDir);
  await ageUntilVisible(page, page.locator(INDICATOR));

  await page.locator(INDICATOR).click();
  const dialog = page.locator(POPOVER);
  await expect(dialog).toBeVisible();

  await context.setOffline(true);
  // `navigator.onLine` follows a moment after the emulation does.
  await page.waitForFunction(() => navigator.onLine === false);
  await dialog.getByRole("button", { name: "Atualizar", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("sem internet");
  // The button is the person's again, and the page is still the old one.
  const retry = dialog.getByRole("button", { name: "Tentar de novo" });
  await expect(retry).toBeEnabled();
  expect(await buildOf(page)).toBe(OLD);

  await context.setOffline(false);
  await page.waitForFunction(() => navigator.onLine === true);
  await retry.click();
  await expect(page.locator("html")).toHaveAttribute("data-pqp-build", NEW);
  await context.close();
});

test("the cache-busting query an update navigates with is taken off the address", async ({
  page,
}) => {
  server.serve(newDir);
  await page.goto(`${server.origin}/?x=1&_pqp=123456#frag`);
  await expect(page.locator("html")).toHaveAttribute("data-pqp-build", NEW);
  const url = new URL(page.url());
  expect(url.searchParams.has("_pqp")).toBe(false);
  expect(url.searchParams.get("x")).toBe("1");
  expect(url.hash).toBe("#frag");
});
