import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * The directory's language filter, driven end to end.
 *
 * ITS OWN FILE rather than four more tests in `communities.spec.ts`, because
 * what it needs from the fixture is different: every test in here seeds rooms
 * in two languages and asserts on which ones survive a filter, and folding that
 * into the suite that asserts "the compass opens the directory" would make both
 * harder to read.
 *
 * WHAT IS ACTUALLY BEING PINNED. Language is a second filter axis, not a
 * category — an English football room belongs on the football shelf, and
 * language is what narrows it afterwards. Three of the four tests below exist
 * to catch the ways that could quietly stop being true: the two axes
 * overriding each other, the default landing on the wrong value for a reader,
 * and the filter surviving a search. The fourth is the whole point of the
 * feature reaching a person: an English room appears when you ask for one.
 *
 * The suite's server runs with `COMMUNITIES_ENABLED=true` — see the note in
 * playwright.config.ts.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

/** Communities are owned by a second account, so the browser sees "Join". */
const OWNER = "lang-owner";
/** …and a third, purely to be the member that clears the directory's floor. */
const FILLER = "lang-filler";

test.setTimeout(90_000);

function headers(suffix?: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}${suffix ? `:${suffix}` : ""}`,
  };
}

async function ensureAccount(suffix: string): Promise<void> {
  const me = await fetch(`${API}/api/me`, { headers: headers(suffix) });
  const body = (await me.json()) as { ageGate?: string };
  if (body.ageGate === "passed") {
    return;
  }
  await fetch(`${API}/api/me/age-check`, {
    method: "POST",
    headers: headers(suffix),
    body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
  });
}

/** A listed community with two members, in a stated language. */
async function seedCommunity(
  name: string,
  category: string,
  language: "pt" | "en",
  tagline: string,
): Promise<string> {
  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headers(OWNER),
    body: JSON.stringify({ name }),
  });
  if (!created.ok) {
    throw new Error(`could not create ${name}: ${created.status}`);
  }
  const { server } = (await created.json()) as { server: { id: string } };

  const invite = await fetch(`${API}/api/servers/${server.id}/invites`, {
    method: "POST",
    headers: headers(OWNER),
    body: JSON.stringify({}),
  });
  const { invite: made } = (await invite.json()) as { invite: { code: string } };
  await fetch(`${API}/api/invites/${made.code}/join`, {
    method: "POST",
    headers: headers(FILLER),
  });

  const patched = await fetch(`${API}/api/servers/${server.id}/community`, {
    method: "PATCH",
    headers: headers(OWNER),
    body: JSON.stringify({ isCommunity: true, category, language, tagline }),
  });
  if (!patched.ok) {
    throw new Error(`could not list ${name}: ${patched.status}`);
  }
  return server.id;
}

/** Leave the directory as empty as this suite found it. See communities.spec.ts. */
async function clearDirectory(): Promise<void> {
  for (const suffix of [OWNER, undefined]) {
    const res = await fetch(`${API}/api/servers`, { headers: headers(suffix) });
    if (!res.ok) {
      continue;
    }
    const body = (await res.json()) as { servers?: { id: string }[] };
    for (const server of body.servers ?? []) {
      await fetch(`${API}/api/servers/${server.id}/community`, {
        method: "PATCH",
        headers: headers(suffix),
        body: JSON.stringify({ isCommunity: false }),
      }).catch(() => {});
    }
  }
}

async function openDirectory(page: Page): Promise<void> {
  await openApp(page);
  await page.locator("[data-communities-rail]").click();
  await expect(page.locator("[data-communities-view]")).toBeVisible();
}

function card(page: Page, name: string) {
  return page.locator("[data-community]").filter({ hasText: name });
}

const segment = (page: Page, id: "pt" | "en" | "all") =>
  page.locator(`[data-language="${id}"]`);

test.describe("Communities — language filter", () => {
  test.beforeEach(async () => {
    await ensureAccount(OWNER);
    await ensureAccount(FILLER);
    await clearDirectory();
  });

  test("the segment narrows the grid to one language and back", async ({
    page,
  }) => {
    await seedCommunity(
      "The Away End",
      "futebol",
      "en",
      "premier league at brunch hour",
    );
    await seedCommunity("Resenha FC", "futebol", "pt", "tabela e choro");
    await openDirectory(page);

    // The suite's browser is English (Playwright's default locale), so the
    // directory opens on "all" — see `defaultLanguageFilter`. Both are visible.
    await expect(segment(page, "all")).toHaveAttribute("aria-pressed", "true");
    await expect(card(page, "The Away End")).toBeVisible();
    await expect(card(page, "Resenha FC")).toBeVisible();

    await segment(page, "en").click();
    await expect(card(page, "The Away End")).toBeVisible();
    await expect(card(page, "Resenha FC")).toHaveCount(0);

    await segment(page, "pt").click();
    await expect(card(page, "Resenha FC")).toBeVisible();
    await expect(card(page, "The Away End")).toHaveCount(0);

    await segment(page, "all").click();
    await expect(card(page, "The Away End")).toBeVisible();
    await expect(card(page, "Resenha FC")).toBeVisible();
  });

  test("language and category narrow together rather than replacing each other", async ({
    page,
  }) => {
    // The design in one test: an English football room stays on the football
    // shelf. If either control overrode the other, one of these three
    // assertions shows the wrong room.
    await seedCommunity("Away End", "futebol", "en", "english football");
    await seedCommunity("Resenha", "futebol", "pt", "futebol brasileiro");
    await seedCommunity("Deu Merge", "tech", "pt", "ia e código");
    await openDirectory(page);

    await page.locator('[data-category="futebol"]').click();
    await expect(card(page, "Deu Merge")).toHaveCount(0);

    await segment(page, "en").click();
    await expect(card(page, "Away End")).toBeVisible();
    await expect(card(page, "Resenha")).toHaveCount(0);

    // Tech has no English room, so this combination is legitimately empty —
    // and the grid says so rather than quietly widening back out.
    await page.locator('[data-category="tech"]').click();
    await expect(card(page, "Away End")).toHaveCount(0);
    await expect(card(page, "Deu Merge")).toHaveCount(0);
  });

  test("a search stays inside the chosen language", async ({ page }) => {
    // Unlike the member floor, which a search is deliberately exempt from: this
    // is a control the reader set on purpose, one inch from the box they are
    // typing in.
    await seedCommunity("Football Weekly", "futebol", "en", "english football");
    await seedCommunity("Futebol Semanal", "futebol", "pt", "futebol daqui");
    await openDirectory(page);

    await segment(page, "en").click();
    await page
      .getByRole("searchbox", { name: "Search communities" })
      .fill("fut");
    await expect(card(page, "Futebol Semanal")).toHaveCount(0);
    await expect(page.getByText("Nothing here yet")).toBeVisible();
  });

  test("a Portuguese browser opens on Portuguese", async ({ browser }) => {
    // The one behaviour that cannot be driven from the default context: the
    // filter's opening value follows the app's own locale, and for the audience
    // this directory is built for that has to be `pt` rather than everything.
    await seedCommunity("Só PT", "geral", "pt", "em português");
    await seedCommunity("Only EN", "geral", "en", "in english");

    const context = await browser.newContext({
      locale: "pt-BR",
      colorScheme: "dark",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      await openDirectory(page);
      await expect(segment(page, "pt")).toHaveAttribute("aria-pressed", "true");
      await expect(card(page, "Só PT")).toBeVisible();
      await expect(card(page, "Only EN")).toHaveCount(0);

      // …and it is a starting point, not a cage.
      await segment(page, "all").click();
      await expect(card(page, "Only EN")).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
