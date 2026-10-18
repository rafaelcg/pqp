import { expect, test, type Page } from "@playwright/test";
import { FRIENDS_FAMILY_TEMPLATE } from "../../packages/shared/src/discord-import.fixture";

/**
 * The home page at "/", in a real browser: what a render to a string cannot
 * see (the pinned scenes, the sticky bar, scroll restoration, the hash jump,
 * the paste bar talking to Discord).
 *
 * MEDIA. The page's reels and stills live in `public/media/home/`, which is
 * not in git (a CI build has none), so every test here must pass with the
 * folder present and absent. Console errors from those files are filtered by
 * the URL of the failing resource, nothing else is, and one test takes the
 * folder away itself so the absent case is checked on a developer's machine
 * too.
 *
 * Selectors are ids, attributes and hrefs, not copy: the wording is edited
 * under these tests and the page speaks three languages.
 */

/** The sections of the page, in order. Every one must exist, media or not. */
const SECTION_IDS = [
  "noite",
  "mudanca",
  "brinquedos",
  "celular",
  "arroba",
  "limites",
  "codigo",
  "perguntas",
  "fim",
] as const;

/** Where the section's top edge is, relative to the top of the viewport. */
async function topOf(page: Page, id: string): Promise<number> {
  return page.evaluate(
    (elementId) => document.getElementById(elementId)?.getBoundingClientRect().top ?? NaN,
    id,
  );
}

/** The header is 4rem and the page keeps 5rem clear above a jump target. */
async function expectLandedOn(page: Page, id: string) {
  await expect.poll(() => topOf(page, id), { timeout: 10_000 }).toBeGreaterThan(40);
  await expect.poll(() => topOf(page, id), { timeout: 10_000 }).toBeLessThan(140);
}

/**
 * Scrolls the whole page once, instantly, so lazy media and scenes that start
 * on entry all get their turn, then comes back to the top.
 */
async function scrollThrough(page: Page) {
  await page.evaluate(async () => {
    const step = Math.max(400, Math.round(window.innerHeight * 0.8));
    for (let y = 0, guard = 0; y < document.documentElement.scrollHeight && guard < 200; y += step, guard += 1) {
      window.scrollTo({ top: y, behavior: "instant" });
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    window.scrollTo({ top: 0, behavior: "instant" });
  });
}

/**
 * Opens a path and waits for the LIVE page. A production build ships the first
 * screen as static markup in index.html (one block per language, so three
 * h1), and React replaces it a moment after load. The live page has one h1 and
 * `main#conteudo`; the static blocks' mains are `conteudo-<locale>`.
 */
async function openHome(page: Page, path = "/") {
  await page.goto(path);
  await expect(page.locator("main#conteudo")).toBeAttached();
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator("h1")).toBeVisible();
}

/**
 * Collects what the page logs. A failed file under `/media/home/` is the one
 * thing allowed: the folder is not in git, and a page that works without it
 * is the point of the media-absent test.
 */
function watch(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (message.location().url.includes("/media/home/")) return;
    consoleErrors.push(`${message.text()} (${message.location().url})`);
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { consoleErrors, pageErrors };
}

/**
 * The download chip asks api.github.com for the latest desktop build. A real
 * answer would make the run depend on the network and on GitHub's rate limit
 * (a 403 is a console error), so it gets an empty release instead: the chip
 * falls back to the releases page, which is the same code path.
 */
test.beforeEach(async ({ page }) => {
  await page.route("https://api.github.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ assets: [] }),
    }),
  );
});

test.describe("home page", () => {
  test("loads and scrolls end to end with nothing in the console", async ({ page }) => {
    const log = watch(page);
    await openHome(page);
    await scrollThrough(page);
    for (const id of SECTION_IDS) await expect(page.locator(`#${id}`), `#${id}`).toBeAttached();
    expect(log.pageErrors).toEqual([]);
    expect(log.consoleErrors).toEqual([]);
  });

  test("still stands without its footage", async ({ page }) => {
    // The folder is untracked: a CI build, a fresh clone and a deploy without
    // the media all look like this. Nothing may throw, and no section may
    // fail (a section that throws is dropped by its boundary, which logs
    // `[home] section "<name>" failed`).
    await page.route("**/media/home/**", (route) => route.fulfill({ status: 404, body: "" }));
    const log = watch(page);
    const sectionFailures: string[] = [];
    page.on("console", (message) => {
      if (message.text().startsWith("[home] section")) sectionFailures.push(message.text());
    });
    await openHome(page);
    await scrollThrough(page);
    for (const id of SECTION_IDS) await expect(page.locator(`#${id}`), `#${id}`).toBeAttached();
    expect(sectionFailures).toEqual([]);
    expect(log.pageErrors).toEqual([]);
    expect(log.consoleErrors).toEqual([]);
  });

  test("keeps the create and import CTAs on their intents", async ({ page }) => {
    // The e2e bundle runs on the dev auth bypass, where both are links.
    await openHome(page);
    await expect(page.locator('a[href="/app?create=new"]').first()).toBeAttached();
    await expect(page.locator('a[href="/app?import=discord"]').first()).toBeAttached();
  });

  test("stays dark for a visitor whose system prefers light", async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: "light" });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.localStorage.setItem("pqp-theme", "light");
    });
    await openHome(page);
    expect(await page.evaluate(() => document.documentElement.dataset.theme ?? "")).toBe("dark");
    // The page paints its own dark ground, whatever the system prefers. The
    // body colour may still be easing across from the light default when the
    // theme flips, so it is polled rather than read once. Chromium reports an
    // oklch() token as written and everything else as rgb().
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const background = getComputedStyle(document.body).backgroundColor;
            const oklch = /^oklch\(\s*([\d.]+)(%?)/.exec(background);
            if (oklch) return Number(oklch[1]) / (oklch[2] ? 100 : 1);
            const [red = 255, green = 255, blue = 255] = (background.match(/\d+(\.\d+)?/g) ?? []).map(Number);
            return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
          }),
        { timeout: 5_000 },
      )
      .toBeLessThan(0.3);
    await context.close();
  });

  test("/#where lands on the status strip's place", async ({ page }) => {
    // Old links and three blog posts say /#where. The strip hides itself when
    // there is no reading, so the target is a wrapper that always renders.
    await openHome(page, "/#where");
    await expect(page).toHaveURL(/\/#where$/);
    await expectLandedOn(page, "where");
  });

  test("a malformed hash does not throw", async ({ page }) => {
    const log = watch(page);
    await openHome(page, "/#%E0");
    await openHome(page, "/#%");
    await page.waitForTimeout(500);
    expect(log.pageErrors).toEqual([]);
    expect(log.consoleErrors).toEqual([]);
  });

  test("a reload from mid-page comes back to the same place, and a hash beats it", async ({ page }) => {
    await openHome(page);
    await page.evaluate(() => window.scrollTo({ top: 3200, behavior: "instant" }));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(3000);
    const before = await page.evaluate(() => window.scrollY);
    await page.reload();
    await expect(page.locator("main#conteudo")).toBeAttached();
    await expect(page.locator("h1")).toHaveCount(1);
    await expect
      .poll(() => page.evaluate(() => window.scrollY), { timeout: 10_000 })
      .toBeGreaterThan(before - 150);
    expect(await page.evaluate(() => window.scrollY)).toBeLessThan(before + 150);

    // With a hash in the URL, the hash decides, not the saved position.
    await openHome(page, "/#perguntas");
    await expectLandedOn(page, "perguntas");
    await page.evaluate(() => window.scrollTo({ top: 900, behavior: "instant" }));
    await page.reload();
    await expect(page.locator("main#conteudo")).toBeAttached();
    await expectLandedOn(page, "perguntas");
  });

  test("a hash jump from the header lands the section under the header", async ({ page }) => {
    await openHome(page);
    await page.locator('header nav a[href="#mudanca"]').click();
    await expectLandedOn(page, "mudanca");
  });
});

/** Older ids that links and blog posts still use, each landing on its section. */
test.describe("older anchors", () => {
  for (const id of ["features", "chat", "roles", "hosting", "import", "discord", "faq", "voice", "screen", "where"]) {
    test(`/#${id} lands under the header`, async ({ page }) => {
      await openHome(page, `/#${id}`);
      await expect(page).toHaveURL(new RegExp(`/#${id}$`));
      await expectLandedOn(page, id);
    });
  }
});

test.describe("header", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("puts the Communities link last in the row and a language picker beside it", async ({ page }) => {
    await page.route("**/api/public/communities/config", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ enabled: true }),
      }),
    );
    await openHome(page, "/?lang=pt-BR");
    const nav = page.locator("header nav");
    await expect(nav.locator("a").last()).toHaveAttribute("href", "/#communities");
    await expect(nav.locator("a").last()).toBeVisible();
    // Its accessible name is "<CODE>, <nav.language>": "PT, Idioma" in pt-BR.
    // e2e/stale-bundle/update.spec.ts clicks the first button named /Idioma/.
    await expect(page.locator("header").getByRole("button", { name: /Idioma/ })).toBeVisible();
  });

  test("shows no Communities link while the server says it is off", async ({ page }) => {
    await page.route("**/api/public/communities/config", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ enabled: false }),
      }),
    );
    await openHome(page, "/?lang=pt-BR");
    await expect(page.locator("header nav a").first()).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.locator('header nav a[href="/#communities"]')).toHaveCount(0);
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("has no horizontal overflow, top to bottom", async ({ page }) => {
    await openHome(page);
    await scrollThrough(page);
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
      inner: window.innerWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.inner);
    expect(widths.client).toBeLessThanOrEqual(widths.inner);
  });

  test("brings the sticky create bar in once the hero buttons are gone, and takes it out where a section has its own", async ({
    page,
  }) => {
    await openHome(page);
    // The bar is the aside that holds the create link. Hidden, it is inert:
    // no taps and no Tab stops.
    const bar = page.locator('aside:has(a[href="/app?create=new"])');
    await expect(bar).toBeAttached();
    const inert = () => bar.evaluate((el) => (el as HTMLElement).inert);
    const opacity = () => bar.evaluate((el) => Number(getComputedStyle(el).opacity));

    // Up top the hero's own buttons are on screen: the bar is down.
    expect(await inert()).toBe(true);
    expect(await opacity()).toBe(0);

    // Past the hero, in a section with no create button of its own: it is up.
    await page.evaluate(() => {
      const target = document.getElementById("brinquedos");
      window.scrollTo({ top: (target?.getBoundingClientRect().top ?? 0) + window.scrollY + 300, behavior: "instant" });
    });
    await expect.poll(inert, { timeout: 10_000 }).toBe(false);
    await expect.poll(opacity, { timeout: 10_000 }).toBe(1);

    // In the section that has its own import button, it steps aside.
    await page.evaluate(() => {
      const target = document.getElementById("mudanca-cta");
      target?.scrollIntoView({ block: "center", behavior: "instant" });
    });
    await expect.poll(inert, { timeout: 10_000 }).toBe(true);

    // And it stays gone at the closer.
    await page.evaluate(() => document.getElementById("fim")?.scrollIntoView({ block: "center", behavior: "instant" }));
    await expect.poll(inert, { timeout: 10_000 }).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

/**
 * Paste your own Discord template. The visitor types or pastes a template
 * link into Vindo do Discord, the page reads
 * `https://discord.com/api/v10/guilds/templates/<code>` from the browser (no
 * other event sends a request), draws that server on the bench, and both CTAs
 * then carry the code. The stub answers with the frozen Friends & Family
 * snapshot, so CI never reaches Discord.
 *
 * It asserts the bench's data attributes (`data-bench-*`), not its copy.
 */

const CODE = "xTdwZ53KdBKz";
const LINK = `https://discord.new/${CODE}`;
const TEMPLATE_URL = `https://discord.com/api/v10/guilds/templates/${CODE}`;

/**
 * Answers the template route and refuses everything else on discord.com, and
 * records both. The catch-all goes first because the LAST registered route
 * that matches wins, so the template stub overrides it for its own URL.
 */
async function stubDiscord(
  page: Page,
  answer: { status: number; body: unknown } | "abort" = { status: 200, body: FRIENDS_FAMILY_TEMPLATE },
) {
  const templateRequests: string[] = [];
  const unexpected: string[] = [];
  await page.route("https://discord.com/**", (route) => {
    unexpected.push(`${route.request().method()} ${route.request().url()}`);
    return route.abort();
  });
  await page.route("https://discord.com/api/v10/guilds/templates/**", (route) => {
    const request = route.request();
    // A CORS preflight is not a read; count the GETs.
    if (request.method() === "GET") templateRequests.push(request.url());
    if (answer === "abort") return route.abort("failed");
    return route.fulfill({
      status: answer.status,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(answer.body),
    });
  });
  return { templateRequests, unexpected };
}

const FIELD = 'input[name="discord-template"]';

async function pasteScenario(page: Page, { wide }: { wide: boolean }) {
  const discord = await stubDiscord(page);
  await page.goto("/#mudanca");
  const bench = page.locator("[data-bench-source]");
  const field = page.locator(FIELD);
  const cta = page.locator("#mudanca-cta a");

  // The start state: the sample is drawn, the field is empty, the CTA asks
  // for any template, and nothing has been sent anywhere.
  await expect(bench).toHaveAttribute("data-bench-source", "sample");
  await expect(field).toHaveValue("");
  await expect(cta).toHaveAttribute("href", "/app?import=discord");
  expect(discord.templateRequests).toEqual([]);

  // Paste the link and press Enter.
  await field.fill(LINK);
  await field.press("Enter");

  // The bench is now the pasted server. The build plays row by row, about two
  // seconds with motion on.
  await expect(bench).toHaveAttribute("data-bench-source", "template");
  await expect(bench).toHaveAttribute("data-bench-phase", "preview");

  // Exactly one read, of exactly the template the link names.
  expect(discord.templateRequests).toEqual([TEMPLATE_URL]);

  // The tree on the pqp side (the one a phone shows after a build): the same
  // eight rows as on Discord, in order.
  const pqpRows = page.locator('[data-bench-panel="pqp"] [data-bench-row]');
  await expect(pqpRows).toHaveCount(8);
  await expect(pqpRows.nth(0)).toContainText("Friends & Family");
  await expect(pqpRows.nth(6)).toContainText("Lounge");
  if (wide) {
    await expect(page.locator('[data-bench-panel="discord"] [data-bench-row]')).toHaveCount(8);
  }

  // What came along: two categories and five channels.
  await expect(page.locator('[data-bench-count="categories"]')).toHaveText(/^\s*2\s*$/);
  await expect(page.locator('[data-bench-count="channels"]')).toHaveText(/^\s*5\s*$/);

  // The status line is ready, and both CTAs carry the code.
  await expect(page.locator('[data-bench-status="ready"][data-on]')).toBeVisible();
  await expect(cta).toHaveAttribute("href", `/app?import=${CODE}`);

  // Nothing else reached Discord, and nothing spilled off the side.
  expect(discord.unexpected).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("paste your own Discord template, wide", () => {
  test("reads the template and builds that server", async ({ page }) => {
    await pasteScenario(page, { wide: true });
  });

  test("turns an invite link away without asking Discord", async ({ page }) => {
    const discord = await stubDiscord(page);
    await page.goto("/#mudanca");
    const field = page.locator(FIELD);
    await field.fill("https://discord.gg/abc123");
    await field.press("Enter");
    await expect(page.locator("[data-bench-message]")).toHaveAttribute("data-bench-message", "inviteLink");
    expect(discord.templateRequests).toEqual([]);
    expect(discord.unexpected).toEqual([]);
    await expect(page.locator("[data-bench-source]")).toHaveAttribute("data-bench-source", "sample");
  });

  test("falls back to the offline note when Discord cannot be reached", async ({ page }) => {
    const discord = await stubDiscord(page, "abort");
    await page.goto("/#mudanca");
    const field = page.locator(FIELD);
    await field.fill(LINK);
    await field.press("Enter");
    await expect(page.locator("[data-bench-source]")).toHaveAttribute("data-bench-source", "offline");
    await expect(page.locator('[data-bench-status="offline"][data-on]')).toBeVisible();
    // The code is known even though the read failed, so the CTA still carries it.
    await expect(page.locator("#mudanca-cta a")).toHaveAttribute("href", `/app?import=${CODE}`);
    expect(discord.unexpected).toEqual([]);
  });
});

test.describe("paste your own Discord template, on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("reads the template and builds that server", async ({ page }) => {
    await pasteScenario(page, { wide: false });
  });
});
