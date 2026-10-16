import { expect, test, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";

/**
 * "Veio do Discord? Traz teu servidor pra cá" (`discord_import_notice`),
 * driven with real mouse and keyboard input and a real second account.
 *
 * The flag is turned on the way production turns it on: a `feature_flags`
 * row written through the operator's machine token, and cleared after the
 * file so no other spec sees it. Dismissals persist per user and server in the
 * hints store, which never persists on localhost, so each page sets
 * `pqp:hints-persist` the way a developer previewing the cards would.
 *
 * Set `NOTICE_SHOTS_DIR` to also write screenshots there (for a human to look
 * at; nothing asserts on them).
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const SHOTS = process.env.NOTICE_SHOTS_DIR ?? "";
const DAY = 24 * 60 * 60 * 1000;

test.setTimeout(90_000);

const headersFor = (suffix: string) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer dev-local-token:${suffix}`,
});

async function setFlag(enabled: boolean | null): Promise<void> {
  const res = await fetch(`${API}/api/admin/flags`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${E2E_ADMIN_TOKEN}` },
    body: JSON.stringify({ key: "discord_import_notice", enabled }),
  });
  expect(res.status).toBe(200);
}

async function person(suffix: string, displayName: string): Promise<string> {
  const headers = headersFor(suffix);
  const me = (await (await fetch(`${API}/api/me`, { headers })).json()) as { id: string };
  await fetch(`${API}/api/me/age-check`, {
    method: "POST",
    headers,
    body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
  });
  await fetch(`${API}/api/me`, { method: "PATCH", headers, body: JSON.stringify({ displayName }) });
  const now = new Date().toISOString();
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ onboardedAt: now, firstRunDismissedAt: now }),
  });
  return me.id;
}

/** An owner with a fresh server, and a second account that joined it. */
async function seed(stamp: string) {
  const owner = `dn-own-${stamp}`;
  const member = `dn-mem-${stamp}`;
  const ownerId = await person(owner, "Dona");
  await person(member, "Visita");
  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(owner),
    body: JSON.stringify({ name: "Mesa do Rafa" }),
  });
  const { server } = (await created.json()) as { server: { id: string } };
  const invite = (await (
    await fetch(`${API}/api/servers/${server.id}/invites`, {
      method: "POST",
      headers: headersFor(owner),
      body: JSON.stringify({}),
    })
  ).json()) as { invite: { code: string } };
  await fetch(`${API}/api/invites/${invite.invite.code}/join`, {
    method: "POST",
    headers: headersFor(member),
    body: JSON.stringify({}),
  });
  return { owner, member, ownerId, serverId: server.id };
}

async function openAs(
  page: Page,
  suffix: string,
  serverId: string,
  lang = "en",
  stored: Record<string, string> = {},
  /** The dev-bypass strip is desktop chrome: a phone waits on the card itself. */
  waitForShell = true,
): Promise<void> {
  await page.addInitScript(
    ([s, extra]) => {
      localStorage.setItem("pqp:dev-user-suffix", s as string);
      localStorage.setItem("pqp:hints-persist", "1");
      // Only when absent: a reload must keep what the app itself wrote.
      for (const [key, value] of Object.entries(extra as Record<string, string>)) {
        if (localStorage.getItem(key) === null) {
          localStorage.setItem(key, value);
        }
      }
    },
    [suffix, stored] as const,
  );
  await page.goto(`/app/server/${serverId}?lang=${lang}`);
  if (waitForShell) {
    await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 30_000 });
  }
}

const notice = (page: Page) => page.locator("[data-discord-import-notice]");

/** A real click at the element's centre, after proving nothing covers it. */
async function realClick(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  expect(box, `${selector} has a box`).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  const hit = await page.evaluate(
    ([px, py, sel]) => document.elementFromPoint(px as number, py as number)?.closest(sel as string) != null,
    [x, y, selector] as const,
  );
  expect(hit, `${selector} is what a click at its centre lands on`).toBe(true);
  await page.mouse.click(x, y);
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) {
    // Past the card's rise, so the picture is the settled state.
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${SHOTS}/${name}.png` });
  }
}

test.beforeAll(async () => {
  await setFlag(true);
});

test.afterAll(async () => {
  await setFlag(null);
});

test("shows to the owner of a small, new server, and not to a member", async ({ page, browser }) => {
  const { owner, member, serverId } = await seed(`a${Date.now().toString(36)}`);
  await openAs(page, owner, serverId);
  await expect(notice(page)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("region", { name: "Coming from Discord? Bring your server over" })).toBeVisible();
  await expect(notice(page)).toContainText("Nothing gets deleted, here or on your Discord.");
  await shot(page, "desktop-dark-en");

  const other = await browser.newPage();
  await openAs(other, member, serverId);
  // Give the arrivals answer time to land: the member is refused it (403).
  await other.waitForTimeout(1500);
  await expect(notice(other)).toHaveCount(0);
  await other.close();
});

test("is not in the conversations area", async ({ page }) => {
  const { owner, serverId } = await seed(`b${Date.now().toString(36)}`);
  await openAs(page, owner, serverId);
  await expect(notice(page)).toBeVisible({ timeout: 20_000 });
  await page.goto(`/app/dm?lang=en`);
  await expect(page.getByText("Dev auth bypass")).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
});

test("the X closes it for good on this server, per user, and it survives a reload", async ({ page }) => {
  const { owner, serverId } = await seed(`c${Date.now().toString(36)}`);
  await openAs(page, owner, serverId);
  await expect(notice(page)).toBeVisible({ timeout: 20_000 });
  await realClick(page, "[data-discord-import-notice-close]");
  await expect(notice(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await expect(notice(page)).toHaveCount(0);
});

test("comes back once after two weeks, and a second close ends it", async ({ browser }) => {
  const { owner, ownerId, serverId } = await seed(`d${Date.now().toString(36)}`);
  const key = `pqp:discord-import-notice:${ownerId}:${serverId}`;
  const closedAgo = (days: number, closes: number) =>
    JSON.stringify({ closes, lastClosedAt: Date.now() - days * DAY, clicked: false });
  /** A fresh browser profile that already holds this history. */
  const withHistory = async (history: string) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await openAs(page, owner, serverId, "en", { [key]: history });
    return page;
  };

  // Closed 3 days ago: still quiet.
  const quiet = await withHistory(closedAgo(3, 1));
  await quiet.waitForTimeout(2000);
  await expect(notice(quiet)).toHaveCount(0);
  await quiet.context().close();

  // Closed 15 days ago: the one more showing. Closing it again records the second close.
  const again = await withHistory(closedAgo(15, 1));
  await expect(notice(again)).toBeVisible({ timeout: 20_000 });
  await realClick(again, "[data-discord-import-notice-close]");
  await expect(notice(again)).toHaveCount(0);
  const stored = await again.evaluate((k) => localStorage.getItem(k), key);
  expect(JSON.parse(stored ?? "{}").closes).toBe(2);
  await again.reload();
  await expect(again.getByText("Dev auth bypass")).toBeVisible({ timeout: 30_000 });
  await again.waitForTimeout(2000);
  await expect(notice(again)).toHaveCount(0);
  await again.context().close();

  // Closed twice, however long ago: never again.
  const never = await withHistory(closedAgo(90, 2));
  await never.waitForTimeout(2500);
  await expect(notice(never)).toHaveCount(0);
  await never.context().close();
});

test("the button opens the Discord import and ends the card", async ({ page }) => {
  const { owner, serverId } = await seed(`e${Date.now().toString(36)}`);
  await openAs(page, owner, serverId);
  await expect(notice(page)).toBeVisible({ timeout: 20_000 });
  await realClick(page, "[data-discord-import-notice-action]");
  await expect(
    page.getByRole("dialog").getByPlaceholder("discord.new/… or a template code"),
  ).toBeVisible({ timeout: 20_000 });
  await shot(page, "import-dialog-opened");
  await page.getByRole("button", { name: "Cancel" }).click();
  // Pressing it answered the question: it does not come back after Cancel.
  await expect(notice(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await expect(notice(page)).toHaveCount(0);
});

test("a keyboard reaches the button and the close, each with a name and a visible focus ring", async ({ page }) => {
  const { owner, serverId } = await seed(`f${Date.now().toString(36)}`);
  await openAs(page, owner, serverId);
  await expect(notice(page)).toBeVisible({ timeout: 20_000 });
  await page.locator("[data-discord-import-notice-action]").focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(notice(page).getByRole("button", { name: "Import from Discord" })).toBeFocused();
  await shot(page, "focus-action");
  await page.keyboard.press("Tab");
  await expect(notice(page).getByRole("button", { name: "Dismiss" })).toBeFocused();
  const ring = await page
    .locator("[data-discord-import-notice-close]")
    .evaluate((el) => getComputedStyle(el).boxShadow);
  expect(ring).not.toBe("none");
  await shot(page, "focus-close");
  await page.keyboard.press("Enter");
  await expect(notice(page)).toHaveCount(0);
});

test("pt-BR and es read as written, and a phone fits the card without a sideways scroll", async ({ page }) => {
  const { owner, serverId } = await seed(`g${Date.now().toString(36)}`);
  await page.setViewportSize({ width: 390, height: 800 });
  await openAs(page, owner, serverId, "pt-BR", {}, false);
  await expect(notice(page)).toContainText("Veio do Discord? Traz teu servidor pra cá", { timeout: 20_000 });
  await expect(notice(page)).toContainText("Nada é apagado, nem aqui nem no teu Discord.");
  await expect(page.getByRole("button", { name: "Importar do Discord" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, "phone-dark-pt");

  await page.goto(`/app/server/${serverId}?lang=es`);
  await expect(notice(page)).toContainText("¿Vienes de Discord? Trae tu servidor", { timeout: 20_000 });
  await shot(page, "phone-dark-es");
});

test("reduced motion: it is there at once, nothing slides in", async ({ browser }) => {
  const { owner, serverId } = await seed(`h${Date.now().toString(36)}`);
  const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await openAs(page, owner, serverId);
  await expect(notice(page)).toBeVisible({ timeout: 20_000 });
  const animation = await notice(page).evaluate((el) => {
    const style = getComputedStyle(el);
    return { name: style.animationName, duration: style.animationDuration };
  });
  expect(animation.name === "none" || parseFloat(animation.duration) === 0).toBe(true);
  await shot(page, "reduced-motion");
  await context.close();
});

test("light theme: the card is legible", async ({ browser }) => {
  const { owner, serverId } = await seed(`j${Date.now().toString(36)}`);
  const context = await browser.newContext({ colorScheme: "light", viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  // The readiness strip is worded per language; the card itself is the wait.
  await openAs(page, owner, serverId, "pt-BR", {}, false);
  await expect(notice(page)).toContainText("Veio do Discord?", { timeout: 20_000 });
  await shot(page, "desktop-light-pt");
  await context.close();
});

test("flag off: nothing shows", async ({ page }) => {
  const { owner, serverId } = await seed(`i${Date.now().toString(36)}`);
  await setFlag(false);
  try {
    await openAs(page, owner, serverId);
    await page.waitForTimeout(2500);
    await expect(notice(page)).toHaveCount(0);
  } finally {
    await setFlag(true);
  }
});
