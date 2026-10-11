import { expect, test, type Browser, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";

/**
 * CONVERSAS, end to end, with two real accounts (`pqp:dev-user-suffix`).
 *
 * The flag is turned on the way production turns it on: a `feature_flags`
 * row written through the operator's machine token (CLAUDE.md pitfall 12),
 * and cleared after the file so no other spec sees it. The suite runs one
 * worker, so nothing else is on the server while it is set.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const headers = (suffix: string) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer dev-local-token:${suffix}`,
});

async function setGlobalFlag(key: string, enabled: boolean | null): Promise<void> {
  const res = await fetch(`${API}/api/admin/flags`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${E2E_ADMIN_TOKEN}` },
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
  // Both, even if the first fails, so no other spec inherits a flag.
  const results = await Promise.allSettled([
    setGlobalFlag("conversations_home", null),
    setGlobalFlag("conversations_home_phone_tabs", null),
  ]);
  const failed = results.find((result) => result.status === "rejected");
  if (failed) {
    throw (failed as PromiseRejectedResult).reason;
  }
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

async function sendAs(
  browser: Browser,
  suffix: string,
  channelId: string,
  body: string,
): Promise<void> {
  const page = await openAs(browser, suffix, `/app/dm/${channelId}`);
  const composer = page.getByPlaceholder(/Message/);
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await composer.fill(body);
  await page.keyboard.press("Enter");
  await expect(page.getByText(body, { exact: true }).last()).toBeVisible();
  await page.context().close();
}

async function idOf(suffix: string): Promise<string> {
  const me = (await (await fetch(`${API}/api/me`, { headers: headers(suffix) })).json()) as {
    user?: { id: string };
    id?: string;
  };
  return (me.user ?? me).id!;
}

test("the rail: the door counts conversations, the people waiting surface under it", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const stamp = Date.now().toString(36);
  const { ana, bia, dm: withBia } = await pair(stamp);
  const cris = `conv-cris-${stamp}`;
  const crisId = await person(cris, "Cris");
  // Friends, so Ana's privacy setting lets Cris write first.
  await fetch(`${API}/api/friends`, {
    method: "POST",
    headers: headers(ana),
    body: JSON.stringify({ userId: crisId }),
  });
  await fetch(`${API}/api/friends/${await idOf(ana)}/accept`, {
    method: "POST",
    headers: headers(cris),
  });
  const { conversation: withCris } = (await (
    await fetch(`${API}/api/dms`, {
      method: "POST",
      headers: headers(cris),
      body: JSON.stringify({ userIds: [await idOf(ana)] }),
    })
  ).json()) as { conversation: { channelId: string } };

  const anaPage = await openAs(browser, ana, "/app/dm");
  await expect(anaPage.locator("aside[data-conversations]")).toBeVisible({ timeout: 20_000 });

  // Three lines from Bia, one from Cris: two conversations waiting, not four.
  for (const line of ["um", "dois", "três"]) {
    await sendAs(browser, bia, withBia, line);
  }
  await sendAs(browser, cris, withCris.channelId, "e aí");

  const rail = anaPage.getByRole("navigation");
  const door = rail.locator("[data-rail-conversations]");
  await expect(door.locator("[data-rail-conversations-label]")).toHaveText("Chats");
  await expect(door.locator("[data-conversations-waiting]")).toHaveText("2", {
    timeout: 20_000,
  });
  const faces = rail.locator('[data-rail-conversation="waiting"]');
  await expect(faces).toHaveCount(2);

  // One click: Cris's face opens the conversation, and once read she leaves
  // the rail and the door says 1.
  await rail.getByRole("button", { name: "Cris" }).click();
  await expect(anaPage).toHaveURL(new RegExp(`/app/dm/${withCris.channelId}`));
  await expect(faces).toHaveCount(1);
  await expect(door.locator("[data-conversations-waiting]")).toHaveText("1");

  // The door itself opens Conversas.
  await door.getByRole("button").first().click();
  await expect(anaPage.locator("aside[data-conversations]")).toBeVisible();

  await anaPage.context().close();
});

test("Nova conversa: a friend is one click, no typing; ticks make a group", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now().toString(36);
  const ana = `conv-new-ana-${stamp}`;
  const dani = `conv-new-dani-${stamp}`;
  const edu = `conv-new-edu-${stamp}`;
  await person(ana, "Ana");
  for (const [suffix, name] of [
    [dani, "Dani"],
    [edu, "Edu"],
  ] as const) {
    const id = await person(suffix, name);
    await fetch(`${API}/api/friends`, {
      method: "POST",
      headers: headers(ana),
      body: JSON.stringify({ userId: id }),
    });
    await fetch(`${API}/api/friends/${await idOf(ana)}/accept`, {
      method: "POST",
      headers: headers(suffix),
    });
  }

  const page = await openAs(browser, ana, "/app/dm");
  const list = page.locator("aside[data-conversations]");
  await expect(list).toBeVisible({ timeout: 20_000 });

  // A brand new account: the list says how conversations arrive.
  await expect(list.locator("[data-conversations-empty]")).toBeVisible();

  await list.getByRole("button", { name: "New conversation" }).click();
  const dialog = page.getByRole("dialog", { name: "New conversation" });
  await expect(dialog.getByText("Dani", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Edu", { exact: true })).toBeVisible();

  // Ticks build a group; the button says so.
  await dialog.getByRole("checkbox", { name: "Add Dani" }).click();
  await dialog.getByRole("checkbox", { name: "Add Edu" }).click();
  await expect(dialog.getByRole("button", { name: "Create group" })).toBeEnabled();
  await dialog.getByRole("checkbox", { name: "Add Edu" }).click();
  await dialog.getByRole("checkbox", { name: "Add Dani" }).click();

  // Nothing ticked: a name is a door.
  await dialog.getByText("Dani", { exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/app\/dm\/[0-9a-f-]{36}/);
  await expect(page.getByPlaceholder(/Message/)).toBeVisible();
  await expect(list.locator("[data-conversation-row]")).toHaveCount(1);

  await page.context().close();
});

test("a friend accepts: a card offers to say hi and opens the conversation", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now().toString(36);
  const ana = `conv-acc-ana-${stamp}`;
  const fer = `conv-acc-fer-${stamp}`;
  await person(ana, "Ana");
  const ferId = await person(fer, "Fer");

  const page = await openAs(browser, ana, "/app/dm");
  await expect(page.locator("aside[data-conversations]")).toBeVisible({ timeout: 20_000 });
  await fetch(`${API}/api/friends`, {
    method: "POST",
    headers: headers(ana),
    body: JSON.stringify({ userId: ferId }),
  });
  // Ana's tab has its friends snapshot (the request is in it) before Fer
  // answers: the card is about a change, so it needs a before.
  await expect(page.getByRole("tab", { name: "Online" })).toBeVisible();
  await page.waitForTimeout(2_000);
  // Fer accepts from somewhere else; Ana's socket is nudged.
  await fetch(`${API}/api/friends/${await idOf(ana)}/accept`, {
    method: "POST",
    headers: headers(fer),
  });

  const card = page.locator(`[data-friend-accepted="${ferId}"]`);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText("You and Fer are friends now");
  await card.getByRole("button", { name: "Say hi" }).click();
  await expect(page).toHaveURL(/\/app\/dm\/[0-9a-f-]{36}/);
  await expect(page.getByPlaceholder(/Message/)).toBeVisible();

  await page.context().close();
});

test("Ctrl/Cmd+K jumps to a person from a server; message search moved to Ctrl/Cmd+F", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { ana, dm } = await pair(Date.now().toString(36));
  const { server } = (await (
    await fetch(`${API}/api/servers`, {
      method: "POST",
      headers: headers(ana),
      body: JSON.stringify({ name: `Sala ${Date.now().toString(36)}` }),
    })
  ).json()) as { server: { id: string } };

  const page = await openAs(browser, ana, `/app/server/${server.id}`);
  await expect(page.getByRole("button", { name: "Search messages" })).toBeVisible({
    timeout: 20_000,
  });
  const mod = process.platform === "darwin" ? "Meta" : "Control";

  // F: message search, as K used to be.
  await page.keyboard.press(`${mod}+f`);
  const search = page.getByRole("dialog", { name: "Search messages" });
  await expect(search).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(search).toBeHidden();

  // K: "go to". Two letters and Enter open Bia's conversation from a server.
  await page.keyboard.press(`${mod}+k`);
  const switcher = page.locator("[data-quick-switcher]");
  await expect(switcher).toBeVisible();
  await page.keyboard.type("bi");
  await expect(switcher.locator("[data-switcher-active]")).toContainText("Bia");
  await page.keyboard.press("Enter");
  await expect(switcher).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/app/dm/${dm}`));

  // The switcher's last row hands its words to message search.
  await page.goto(`/app/server/${server.id}?lang=en`);
  await expect(page.getByRole("button", { name: "Search messages" })).toBeVisible({
    timeout: 20_000,
  });
  await page.keyboard.press(`${mod}+k`);
  await page.keyboard.type("bora");
  await switcher.getByRole("option", { name: /Search “bora”/ }).click();
  await expect(search.getByRole("searchbox").or(search.locator("input")).first()).toHaveValue("bora");

  await page.context().close();
});

test("phone at 390px: the bottom bar, Servidores first, the stack, and the remembered tab", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  await setGlobalFlag("conversations_home_phone_tabs", true);
  try {
    const { ana, dm } = await pair(Date.now().toString(36));
    const page = await openAs(browser, ana, "/app", { width: 390, height: 844 });
    const bar = page.locator("[data-phone-tab-bar]");
    await expect(bar).toBeVisible({ timeout: 20_000 });
    // An account with no stored choice starts where the app always started.
    await expect(bar.getByRole("tab", { name: /Servers/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("[data-phone-screen=servidores]")).toBeVisible();
    // No rail, and nothing wider than the phone.
    await expect(page.locator("nav[data-rail-phone-hidden]")).toBeHidden();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await bar.getByRole("tab", { name: /Chats/ }).click();
    const list = page.locator("aside[data-conversations]");
    await expect(list.locator(`[data-flip-key="${dm}"]`)).toBeVisible();
    await expect(list.locator(`[data-flip-key="${dm}"]`)).toBeInViewport();

    // A conversation is the whole screen; back returns to the list and the bar.
    await list.locator(`[data-flip-key="${dm}"] button`).first().click();
    await expect(page).toHaveURL(new RegExp(`/app/dm/${dm}`));
    await expect(bar).toBeHidden();
    await expect(page.getByPlaceholder(/Message/)).toBeInViewport();
    await page.getByRole("button", { name: "Back" }).click();
    await expect(bar).toBeVisible();
    await expect(list.locator(`[data-flip-key="${dm}"]`)).toBeInViewport();

    // Tu holds the account.
    await bar.getByRole("tab", { name: /You/ }).click();
    await expect(page.locator("[data-phone-screen=tu]")).toBeVisible();
    await expect(
      page.locator("[data-phone-screen=tu]").getByRole("button", { name: "Edit profile" }),
    ).toBeVisible();

    // The last tab is remembered across a reload.
    await bar.getByRole("tab", { name: /Chats/ }).click();
    await page.goto("/app?lang=en");
    await expect(bar.getByRole("tab", { name: /Chats/ })).toHaveAttribute("aria-selected", "true", {
      timeout: 20_000,
    });
    await expect(list).toBeInViewport();
    await page.context().close();
  } finally {
    await setGlobalFlag("conversations_home_phone_tabs", null);
  }
});
