import { expect, test, type Page } from "@playwright/test";

/**
 * The DM list itself at phone width (§7.1, §9 criteria 5, 6, 10, 11, 12, 13):
 * the row's unread/read/muted states, coalescing the preview onto the newest
 * message, the mute round trip through the row's own context menu, the two
 * badge colours (accent for requests, red for unread), the plain-text
 * "Pendentes (n)" tab, and no horizontal overflow at 390px.
 *
 * Same dev-bypass-over-HTTP harness as `dm-toast.spec.ts` /
 * `dm-toast-suppression.spec.ts`.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const headers = (suffix: string) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer dev-local-token:${suffix}`,
});

async function person(suffix: string, displayName: string): Promise<string> {
  await fetch(`${API}/api/me/age-check`, {
    method: "POST",
    headers: headers(suffix),
    body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
  });
  await fetch(`${API}/api/me`, {
    method: "PATCH",
    headers: headers(suffix),
    body: JSON.stringify({ displayName }),
  });
  const now = new Date().toISOString();
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers: headers(suffix),
    body: JSON.stringify({ onboardedAt: now, firstRunDismissedAt: now }),
  });
  const me = (await (await fetch(`${API}/api/me`, { headers: headers(suffix) })).json()) as {
    user?: { id: string };
    id?: string;
  };
  return (me.user ?? me).id!;
}

interface Setup {
  server: { id: string };
  conversation: { channelId: string };
  biaId: string;
}

async function seed(aSuffix: string, bSuffix: string): Promise<Setup> {
  await person(aSuffix, "Ana");
  const biaId = await person(bSuffix, "Bia");

  const { server } = (await (
    await fetch(`${API}/api/servers`, {
      method: "POST",
      headers: headers(aSuffix),
      body: JSON.stringify({ name: `Polish ${Date.now()}` }),
    })
  ).json()) as { server: { id: string } };
  const { invite } = (await (
    await fetch(`${API}/api/servers/${server.id}/invites`, {
      method: "POST",
      headers: headers(aSuffix),
      body: JSON.stringify({}),
    })
  ).json()) as { invite: { code: string } };
  await fetch(`${API}/api/invites/${invite.code}/join`, {
    method: "POST",
    headers: headers(bSuffix),
  });
  const { conversation } = (await (
    await fetch(`${API}/api/dms`, {
      method: "POST",
      headers: headers(aSuffix),
      body: JSON.stringify({ userIds: [biaId] }),
    })
  ).json()) as { conversation: { channelId: string } };

  return { server, conversation, biaId };
}

async function sendFrom(
  browser: import("@playwright/test").Browser,
  suffix: string,
  channelId: string,
  body: string,
): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript((s) => localStorage.setItem("pqp:dev-user-suffix", s), suffix);
  await page.goto(`/app/dm/${channelId}?lang=en`);
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 20_000 });
  await page.getByPlaceholder(/Message/).fill(body);
  await page.keyboard.press("Enter");
  await context.close();
}

/** The drawer is closed by default under `md`; the header hamburger opens it. */
async function openDrawer(page: Page): Promise<void> {
  const opener = page.getByRole("button", { name: "Open navigation" });
  if (await opener.isVisible().catch(() => false)) {
    await opener.click();
  }
}

test.use({ viewport: { width: 390, height: 844 } });

test("criteria 5 & 6: unread state, then coalescing onto the newest message", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stamp = Date.now().toString(36);
  const a = `polish56-ana-${stamp}`;
  const b = `polish56-bia-${stamp}`;
  const { conversation } = await seed(a, b);

  const anaContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const anaPage = await anaContext.newPage();
  await anaPage.addInitScript((s) => localStorage.setItem("pqp:dev-user-suffix", s), a);
  await anaPage.goto(`/app/dm?lang=en`);
  await expect(anaPage.getByRole("tab", { name: "Online" })).toBeVisible({ timeout: 20_000 });

  await sendFrom(browser, b, conversation.channelId, "primeira mensagem");
  await openDrawer(anaPage);
  // The default-on arrival toast (criterion 14) also carries this same
  // text; dismiss it so every assertion below is unambiguously about the
  // LIST ROW under test here, not the corner card covered elsewhere.
  await anaPage.keyboard.press("Escape");

  const sidebar = anaPage.locator("aside");
  const badge = sidebar.locator(`[data-dm-unread]`).first();
  await expect(badge).toHaveText("1", { timeout: 15_000 });

  const row = sidebar.getByText("Bia", { exact: true }).first();
  await expect(row).toBeVisible();
  await expect(row).toHaveClass(/font-semibold/);
  await expect(sidebar.getByText("primeira mensagem")).toBeVisible();
  // The left unread marker (an absolutely positioned 3px bar), scoped to the
  // row via its container (found by text rather than `has:`, which checks a
  // *page-scoped* inner locator rather than one relative to each candidate)
  // so a false positive from some other absolute element cannot pass this.
  const rowContainer = sidebar.locator("div.group").filter({ hasText: "Bia" }).first();
  await expect(rowContainer.locator('[aria-hidden="true"].bg-text')).toHaveCount(1);

  // Two more messages — criterion 6: the pill reads 3 and the preview is the
  // THIRD message, never the first.
  await sendFrom(browser, b, conversation.channelId, "segunda mensagem");
  await sendFrom(browser, b, conversation.channelId, "terceira mensagem");
  await anaPage.keyboard.press("Escape");
  await expect(badge).toHaveText("3", { timeout: 15_000 });
  await expect(sidebar.getByText("terceira mensagem")).toBeVisible();
  await expect(sidebar.getByText("primeira mensagem")).toHaveCount(0);
  await expect(sidebar.getByText("segunda mensagem")).toHaveCount(0);

  await anaContext.close();
});

test("criterion 10: muting a conversation clears the pill and restores it, count intact", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stamp = Date.now().toString(36);
  const a = `polish10-ana-${stamp}`;
  const b = `polish10-bia-${stamp}`;
  const { conversation } = await seed(a, b);

  const anaContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const anaPage = await anaContext.newPage();
  await anaPage.addInitScript((s) => localStorage.setItem("pqp:dev-user-suffix", s), a);
  await anaPage.goto(`/app/dm?lang=en`);
  await expect(anaPage.getByRole("tab", { name: "Online" })).toBeVisible({ timeout: 20_000 });

  await sendFrom(browser, b, conversation.channelId, "toque de silencio");
  await openDrawer(anaPage);
  // Clear the arrival toast first — it sits on top of the sidebar at this
  // width and, unscoped, "Bia" would otherwise resolve ambiguously between
  // the card and the row this test means to right-click.
  await anaPage.keyboard.press("Escape");

  const sidebar = anaPage.locator("aside");
  const badge = sidebar.locator(`[data-dm-unread]`).first();
  await expect(badge).toHaveText("1", { timeout: 15_000 });

  const row = sidebar.getByText("Bia", { exact: true }).first();
  await row.click({ button: "right" });
  const menu = anaPage.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Nothing" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Nothing" }).click();

  // Pill gone, bell-off glyph in its place, row dimmed.
  await expect(sidebar.locator(`[data-dm-unread]`)).toHaveCount(0);
  const rowContainer = sidebar.locator("div.group").filter({ hasText: "Bia" }).first();
  await expect(rowContainer).toHaveClass(/opacity-60/);
  await expect(rowContainer.locator("svg.lucide-bell-off")).toBeVisible();

  // Unmuting restores the pill with the count intact — the mute only stops
  // it rendering, it never deletes the count (§5.3).
  await row.click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: "All messages" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "All messages" }).click();
  await expect(sidebar.locator(`[data-dm-unread]`).first()).toHaveText("1", {
    timeout: 10_000,
  });

  await anaContext.close();
});

test("criteria 11 & 12: friend-request accent badge, and a plain-text Pending tab count", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stamp = Date.now().toString(36);
  const a = `polish1112-ana-${stamp}`;
  const b = `polish1112-bia-${stamp}`;
  await person(a, "Ana");
  const biaId = await person(b, "Bia");

  const anaContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const anaPage = await anaContext.newPage();
  await anaPage.addInitScript((s) => localStorage.setItem("pqp:dev-user-suffix", s), a);
  await anaPage.goto(`/app/dm?lang=en`);
  await expect(anaPage.getByRole("tab", { name: "Online" })).toBeVisible({ timeout: 20_000 });

  const sent = await fetch(`${API}/api/friends`, {
    method: "POST",
    headers: headers(b),
    body: JSON.stringify({ userId: (await (await fetch(`${API}/api/me`, { headers: headers(a) })).json()).id ?? undefined }),
  });
  expect(sent.status).toBe(201);
  void biaId;

  await openDrawer(anaPage);
  // `[data-friend-requests]` also exists on the rail's own Home bubble
  // (`server-rail.tsx`), out of scope for this PR and pre-existing —
  // scoped to the drawer's `<aside>` (the rail root is a `<nav>`) to reach
  // the "Amigos" row badge criterion 11 actually names.
  const badge = anaPage.locator("aside [data-friend-requests]").first();
  await expect(badge).toHaveAttribute("data-friend-requests", "1", { timeout: 20_000 });
  // Accent, not the danger red the unread pill uses — one colour per meaning
  // (principle 2 / §2.6). `bg-danger` must not appear on this element.
  await expect(badge).toHaveClass(/bg-accent/);
  await expect(badge).not.toHaveClass(/bg-danger/);

  // The Pendentes tab: plain text, no pill. Scoped to the drawer's own
  // "Amigos" nav button — the page also has an `<h1>Friends</h1>` heading
  // once that view is open, which an unscoped text/role query would
  // collide with.
  await anaPage.locator("aside").getByRole("button", { name: /Friends/ }).click();
  const pendingTab = anaPage.getByRole("tab", { name: "Pending (1)" });
  await expect(pendingTab).toBeVisible({ timeout: 15_000 });
  // No pill sitting inside/near the tab — the count is the tab's own label.
  await expect(pendingTab.locator("[data-dm-unread]")).toHaveCount(0);
  await expect(pendingTab.locator(".bg-danger")).toHaveCount(0);

  await anaContext.close();
});

test("criterion 13: nothing in the sidebar wraps or overflows at 390px", async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now().toString(36);
  const a = `polish13-ana-${stamp}`;
  const b = `polish13-bia-${stamp}`;
  const { conversation } = await seed(a, b);
  // A deliberately long display name and message, the kind of input the
  // spec's own 390px note (§7.1) calls out.
  await fetch(`${API}/api/me`, {
    method: "PATCH",
    headers: headers(b),
    body: JSON.stringify({ displayName: "Bia Fernandes Albuquerque" }),
  });

  const anaContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const anaPage = await anaContext.newPage();
  await anaPage.addInitScript((s) => localStorage.setItem("pqp:dev-user-suffix", s), a);
  await anaPage.goto(`/app/dm?lang=en`);
  await expect(anaPage.getByRole("tab", { name: "Online" })).toBeVisible({ timeout: 20_000 });

  await sendFrom(
    browser,
    b,
    conversation.channelId,
    "uma mensagem bem comprida para checar o truncamento no telefone",
  );
  await openDrawer(anaPage);
  await expect(anaPage.locator(`[data-dm-unread]`).first()).toHaveText("1", {
    timeout: 15_000,
  });

  const sidebar = anaPage.locator("aside").first();
  await expect(sidebar).toBeVisible();
  const overflow = await sidebar.evaluate(
    (el) => el.scrollWidth - el.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  const docOverflow = await anaPage.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(docOverflow).toBeLessThanOrEqual(1);

  if (process.env.SHOT_DIR) {
    await anaPage.screenshot({ path: `${process.env.SHOT_DIR}/dm-list-390.png` });
  }

  await anaContext.close();
});
