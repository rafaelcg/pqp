import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * CONVERSAS, end to end, with two real accounts (`pqp:dev-user-suffix`).
 *
 * The flag is turned on the way production turns it on: a `feature_flags`
 * row written through the operator's machine token (CLAUDE.md pitfall 12),
 * and cleared after the file so no other spec sees it. The suite runs one
 * worker, so nothing else is on the server while it is set.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const ADMIN_TOKEN = "e2e-admin-token-0123456789abcdef";
const headers = (suffix: string) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer dev-local-token:${suffix}`,
});

async function setGlobalFlag(key: string, enabled: boolean | null): Promise<void> {
  const res = await fetch(`${API}/api/admin/flags`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ key, enabled }),
  });
  expect(res.status).toBe(200);
}

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

/** Two accounts who are friends, with a conversation between them. */
async function pair(stamp: string): Promise<{ ana: string; bia: string; biaId: string; dm: string }> {
  const ana = `conv-ana-${stamp}`;
  const bia = `conv-bia-${stamp}`;
  await person(ana, "Ana");
  const biaId = await person(bia, "Bia");
  const anaId = (
    (await (await fetch(`${API}/api/me`, { headers: headers(ana) })).json()) as {
      user?: { id: string };
      id?: string;
    }
  );
  await fetch(`${API}/api/friends`, {
    method: "POST",
    headers: headers(ana),
    body: JSON.stringify({ userId: biaId }),
  });
  await fetch(`${API}/api/friends/${(anaId.user ?? anaId).id}/accept`, {
    method: "POST",
    headers: headers(bia),
  });
  const { conversation } = (await (
    await fetch(`${API}/api/dms`, {
      method: "POST",
      headers: headers(ana),
      body: JSON.stringify({ userIds: [biaId] }),
    })
  ).json()) as { conversation: { channelId: string } };
  return { ana, bia, biaId, dm: conversation.channelId };
}

async function openAs(
  browser: Browser,
  suffix: string,
  path: string,
  viewport = { width: 1280, height: 820 },
): Promise<Page> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.addInitScript((s) => localStorage.setItem("pqp:dev-user-suffix", s), suffix);
  await page.goto(`${path}${path.includes("?") ? "&" : "?"}lang=en`);
  return page;
}

test.beforeAll(async () => {
  await setGlobalFlag("conversations_home", true);
});

test.afterAll(async () => {
  await setGlobalFlag("conversations_home", null);
  await setGlobalFlag("conversations_home_phone_tabs", null);
});

test("the Conversas list: unread row, the Não lidas chip, typing, and search", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { ana, bia, dm } = await pair(Date.now().toString(36));

  const anaPage = await openAs(browser, ana, "/app/dm");
  const list = anaPage.locator("aside[data-conversations]");
  await expect(list.getByRole("heading", { name: "Conversations" })).toBeVisible({
    timeout: 20_000,
  });

  // Bia writes while Ana is on the Friends view.
  const biaPage = await openAs(browser, bia, `/app/dm/${dm}`);
  const composer = biaPage.getByPlaceholder(/Message/);
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await composer.fill("oi ana");
  await biaPage.keyboard.press("Enter");

  const row = list.locator(`[data-flip-key="${dm}"]`);
  await expect(row).toHaveAttribute("data-unread", "", { timeout: 15_000 });
  await expect(row.locator("[data-dm-unread]")).toHaveText("1");
  await expect(row.locator("[data-conversations-preview]")).toHaveText("oi ana");
  await expect(list.locator("[data-conversations-unread-count]")).toHaveText("1");
  // A friend: presence on the face.
  await expect(row.locator("[data-conversations-face] svg[role=img]")).toBeVisible();

  // Bia types without sending: Ana's LIST says so, though Ana has the
  // conversation closed (the server addresses typing to participants).
  // Past the client's typing throttle, so the sends above do not swallow it.
  await biaPage.waitForTimeout(3_500);
  await composer.pressSequentially("tô digitando", { delay: 40 });
  await expect(row.locator("[data-conversations-typing]")).toHaveText("typing…", {
    timeout: 10_000,
  });

  // Search narrows the list; no match offers a way to look for somebody.
  const search = list.getByRole("searchbox");
  await search.fill("zzz");
  await expect(row).toHaveCount(0);
  await expect(list.getByRole("button", { name: "Look for someone else" })).toBeVisible();
  await search.fill("bi");
  await expect(row).toHaveCount(1);
  // Enter opens the first match.
  await search.press("Enter");
  await expect(anaPage).toHaveURL(new RegExp(`/app/dm/${dm}`));
  await expect(row).toHaveAttribute("data-selected", "");

  await anaPage.context().close();
  await biaPage.context().close();
});

test("flag off: the classic list is exactly what it was", async ({ browser }) => {
  test.setTimeout(90_000);
  await setGlobalFlag("conversations_home", false);
  try {
    const { ana } = await pair(Date.now().toString(36));
    const page = await openAs(browser, ana, "/app/dm");
    await expect(page.getByRole("tab", { name: "Online" })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("aside[data-conversations]")).toHaveCount(0);
    await expect(page.getByText("Messages", { exact: true }).first()).toBeVisible();
    await page.context().close();
  } finally {
    await setGlobalFlag("conversations_home", true);
  }
});
