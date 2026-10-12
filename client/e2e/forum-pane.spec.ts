import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * The forum pane end to end (forum PR 3b, UX.md §6): two real accounts
 * (`pqp:dev-user-suffix`), the real server and the runtime flag
 * `forum_channels` overridden on for ONE server through the machine token, the
 * way the dashboard does. Nothing about the forum is stubbed:
 *
 *   1. bob publishes from the composer; alice, viewing the forum, sees the
 *      card arrive live (forum-post-upsert) with the Novo badge;
 *   2. alice replies; bob's card counts the new reply; bob marks alice's reply
 *      as the solution and alice's card turns Resolvido live;
 *   3. alice (staff) closes the post; bob's composer becomes the closed bar;
 *   4. alice deletes it; bob's open pane says so and the card leaves;
 *   5. a phone width: the list, a post full screen, back to the list.
 *
 * Needs the forum's server routes (forum PR 1). On a build without them the
 * spec skips with a note rather than failing, so it can land first.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const ADMIN_TOKEN = "e2e-admin-token-0123456789abcdef";

test.setTimeout(120_000);

const run = Date.now().toString(36);

function headersFor(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

async function api<T>(
  suffix: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: headersFor(suffix),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
  }
  return (res.status === 204 ? null : await res.json()) as T;
}

async function materialise(suffix: string, displayName: string): Promise<void> {
  const me = await api<{ ageGate?: string }>(suffix, "/api/me");
  if (me.ageGate && me.ageGate !== "passed") {
    await api(suffix, "/api/me/age-check", {
      method: "POST",
      body: { dateOfBirth: "1990-01-01" },
    });
  }
  await api(suffix, "/api/me/preferences", {
    method: "PATCH",
    body: {
      onboardedAt: new Date().toISOString(),
      firstRunDismissedAt: new Date().toISOString(),
    },
  });
  await api(suffix, "/api/me", { method: "PATCH", body: { displayName } });
}

interface Seed {
  serverId: string;
  forumId: string;
}

async function seed(alice: string, bob: string): Promise<Seed | null> {
  await materialise(alice, "Rafa");
  await materialise(bob, "Bob");
  const { server } = await api<{ server: { id: string } }>(alice, "/api/servers", {
    method: "POST",
    body: { name: `Fórum ${run}` },
  });
  const flag = await fetch(`${API}/api/admin/flag-overrides`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ key: "forum_channels", serverId: server.id, enabled: true }),
  });
  expect(flag.status).toBe(200);
  const { channel } = await api<{ channel: { id: string } }>(
    alice,
    `/api/servers/${server.id}/channels`,
    { method: "POST", body: { name: "ajuda", type: "forum" } },
  );
  await api(alice, `/api/channels/${channel.id}`, {
    method: "PATCH",
    body: { topic: "Um problema por post." },
  });
  // The post routes are forum PR 1's. Without them there is nothing to test.
  const probe = await fetch(`${API}/api/channels/${channel.id}/posts`, {
    headers: headersFor(alice),
  });
  if (probe.status === 404) {
    return null;
  }
  await api(alice, `/api/channels/${channel.id}/forum-tags`, {
    method: "PUT",
    body: {
      tags: [
        { name: "Bug", emoji: "🐛", moderated: false },
        { name: "Dúvida", emoji: "❓", moderated: false },
      ],
    },
  });
  const { invite } = await api<{ invite: { code: string } }>(
    alice,
    `/api/servers/${server.id}/invites`,
    { method: "POST", body: {} },
  );
  await api(bob, `/api/invites/${invite.code}/join`, { method: "POST" });
  return { serverId: server.id, forumId: channel.id };
}

async function openAs(
  browser: Browser,
  suffix: string,
  path: string,
  viewport = { width: 1440, height: 900 },
): Promise<Page> {
  const context = await browser.newContext({ viewport, locale: "en-US", colorScheme: "dark" });
  await context.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  const page = await context.newPage();
  await page.goto(`${path}?lang=en`);
  await expect(page.locator("[data-forum-pane]")).toBeVisible({ timeout: 30_000 });
  // The roster takes the width the post would sit in.
  const toggle = page.locator("[data-member-sidebar-toggle]");
  if ((await toggle.count()) && (await toggle.first().getAttribute("aria-pressed")) === "true") {
    await toggle.first().click();
  }
  return page;
}

test("two people: publish, reply, solution, close and delete, all live", async ({ browser }) => {
  const alice = `fa${run}`;
  const bob = `fb${run}`;
  const ids = await seed(alice, bob);
  test.skip(ids === null, "the forum server routes (forum PR 1) are not in this build");
  if (!ids) {
    return;
  }
  const forumPath = `/app/server/${ids.serverId}/channel/${ids.forumId}`;
  const a = await openAs(browser, alice, forumPath);
  const b = await openAs(browser, bob, forumPath);

  // 1. bob publishes; alice sees it arrive with Novo.
  await b.keyboard.press("c");
  await expect(b.locator("[data-forum-composer]")).toBeVisible();
  await b.keyboard.type("Notebook não liga depois da BIOS");
  await b.locator("[data-forum-composer] textarea").click();
  await b.keyboard.type("Luz acende e apaga.");
  await b.locator("[data-forum-composer]").getByRole("button", { name: "Bug", exact: true }).click();
  await b.keyboard.press("ControlOrMeta+Enter");
  await expect(b.locator("[data-forum-post-panel]")).toContainText("Luz acende e apaga.");
  const card = a.locator("[data-forum-post]").filter({ hasText: "Notebook não liga" });
  await expect(card).toBeVisible({ timeout: 5_000 });
  await expect(card).toHaveAttribute("data-unread", "new");

  // Accent-insensitive title search finds it.
  await a.keyboard.press("/");
  await a.keyboard.type("notebook nao liga");
  await expect(card).toBeVisible();
  await a.keyboard.press("Escape");

  // 2. alice opens it and replies; bob marks the reply as the solution.
  await card.getByRole("link").click();
  await expect(a.locator("[data-forum-post-panel]")).toContainText("Luz acende e apaga.");
  await a.locator("[data-forum-post-panel] textarea").click();
  await a.keyboard.type("Tira a bateria do CMOS por 1 minuto.");
  await a.keyboard.press("Enter");
  const reply = b.locator("[data-forum-post-panel] article").filter({
    hasText: "Tira a bateria do CMOS",
  });
  await expect(reply).toBeVisible({ timeout: 5_000 });
  await reply.click({ button: "right" });
  await b.getByRole("menuitem", { name: "Mark as solution" }).click();
  await expect(b.locator("[data-forum-solution]")).toBeVisible();
  // Live on alice's card too: compact beside the open post, so the status is
  // the named icon rather than the word.
  const aliceCard = a.locator("[data-forum-post]").filter({ hasText: "Notebook não liga" });
  await expect(aliceCard.getByRole("img", { name: "Resolved" })).toBeVisible({ timeout: 5_000 });
  // The post she is reading never lights up as unread beside her.
  await expect(aliceCard).toHaveAttribute("data-unread", "read");

  // 3. alice closes it; bob's composer turns into the closed bar.
  await a.locator("[data-forum-post-menu]").click();
  await a.getByRole("menuitem", { name: "Close to replies" }).click();
  await expect(b.locator("[data-forum-locked]")).toBeVisible({ timeout: 5_000 });
  await expect(b.locator("[data-forum-post-panel] textarea")).toHaveCount(0);
  // Staff still have a composer.
  await expect(a.locator("[data-forum-post-panel] textarea")).toBeVisible();

  // 4. alice deletes it; bob's pane says so.
  await a.locator("[data-forum-post-menu]").click();
  await a.getByRole("menuitem", { name: "Delete post" }).click();
  await a.getByRole("button", { name: "Delete post" }).click();
  await expect(b.locator("[data-forum-post-removed]")).toBeVisible({ timeout: 5_000 });
  await expect(b.locator("[data-forum-post]").filter({ hasText: "Notebook não liga" })).toHaveCount(0);
});

test("a phone: the list fills the screen, a post opens full screen and back returns", async ({
  browser,
}) => {
  const alice = `fpa${run}`;
  const bob = `fpb${run}`;
  const ids = await seed(alice, bob);
  test.skip(ids === null, "the forum server routes (forum PR 1) are not in this build");
  if (!ids) {
    return;
  }
  await api(bob, `/api/channels/${ids.forumId}/posts`, {
    method: "POST",
    body: { title: "Tela azul no CS2", body: "Só no CS2.", nonce: `n-${run}` },
  });
  const page = await openAs(
    browser,
    alice,
    `/app/server/${ids.serverId}/channel/${ids.forumId}`,
    { width: 390, height: 844 },
  );
  await expect(page.getByRole("link", { name: /Tela azul no CS2/ })).toBeVisible();
  await page.getByRole("link", { name: /Tela azul no CS2/ }).click();
  const panel = page.locator("[data-forum-post-panel]");
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(388);
  await page.getByRole("button", { name: "Back to list" }).first().click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Tela azul no CS2/ })).toBeFocused();
});
