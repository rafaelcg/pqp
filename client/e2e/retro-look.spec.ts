import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Modo 2005, the hidden look: `/2005` in the composer turns it on and is never
 * sent, the DM column becomes a contact list grouped by status, the
 * conversation becomes a window, and `(H)` reads as 😎 for this reader only.
 * `/2005` again turns it off.
 *
 * Screenshots (desktop and a 390 px phone) land in the test's output folder,
 * or in `RETRO_SHOTS_DIR` when set, to compare by eye with the design mocks.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const WS_URL = API.replace(/^http/, "ws") + "/ws";
const DEV_TOKEN = "dev-local-token";

test.setTimeout(150_000);

const headers = (suffix: string) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
});

async function person(
  suffix: string,
  displayName: string,
  customStatus: string | null = null,
): Promise<string> {
  await fetch(`${API}/api/me/age-check`, {
    method: "POST",
    headers: headers(suffix),
    body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
  });
  await fetch(`${API}/api/me`, {
    method: "PATCH",
    headers: headers(suffix),
    body: JSON.stringify({ displayName, customStatus }),
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

async function befriend(a: string, aId: string, b: string, bId: string) {
  await fetch(`${API}/api/friends`, {
    method: "POST",
    headers: headers(a),
    body: JSON.stringify({ userId: bId }),
  });
  await fetch(`${API}/api/friends/${aId}/accept`, {
    method: "POST",
    headers: headers(b),
  });
}

/** A socket that keeps somebody online for as long as it is open. */
async function online(suffix: string): Promise<WebSocket> {
  const socket = new WebSocket(WS_URL);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("ws error")));
    });
    const ready = new Promise<void>((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        if ((JSON.parse(String(event.data)) as { type: string }).type === "ready") {
          resolve();
        }
      });
      socket.addEventListener("close", () => reject(new Error("ws closed before ready")));
    });
    socket.send(JSON.stringify({ type: "auth", token: `${DEV_TOKEN}:${suffix}` }));
    await ready;
    return socket;
  } catch (error) {
    socket.close();
    throw error;
  }
}

async function messageBodies(suffix: string, channelId: string): Promise<string[]> {
  const res = await fetch(`${API}/api/channels/${channelId}/messages`, {
    headers: headers(suffix),
  });
  const { messages } = (await res.json()) as { messages: { body: string }[] };
  return messages.map((message) => message.body);
}

/** One at a time, so the log reads in the order written. */
async function send(
  socket: WebSocket,
  suffix: string,
  channelId: string,
  body: string,
) {
  socket.send(JSON.stringify({ type: "message-create", channelId, body }));
  await expect.poll(() => messageBodies(suffix, channelId)).toContain(body);
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, theme);
  await page.waitForTimeout(250);
}

function composer(page: Page) {
  return page.getByPlaceholder(/^(Mensagem|Message) /);
}

test("/2005 turns Modo 2005 on, never sends, and /2005 turns it off", async ({
  browser,
}, testInfo) => {
  const shots = process.env.RETRO_SHOTS_DIR ?? testInfo.outputPath("shots");
  mkdirSync(shots, { recursive: true });

  const stamp = Date.now().toString(36);
  const ana = `retro-ana-${stamp}`;
  const lu = `retro-lu-${stamp}`;
  const guga = `retro-guga-${stamp}`;
  const pedro = `retro-pedro-${stamp}`;
  const anaId = await person(ana, "Ana", "♫ ouvindo Pitty, Na Sua Estante");
  const luId = await person(lu, "~*Lu*~", "indo pro CS às 22h, cola");
  const gugaId = await person(guga, "Guga", "estudando, não chama");
  const pedroId = await person(pedro, "Pedrão", "tô off");
  await befriend(ana, anaId, lu, luId);
  await befriend(ana, anaId, guga, gugaId);
  await befriend(ana, anaId, pedro, pedroId);
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers: headers(guga),
    body: JSON.stringify({ status: "dnd" }),
  });

  const { conversation } = (await (
    await fetch(`${API}/api/dms`, {
      method: "POST",
      headers: headers(ana),
      body: JSON.stringify({ userIds: [luId] }),
    })
  ).json()) as { conversation: { channelId: string } };
  const channelId = conversation.channelId;

  const sockets: WebSocket[] = [];
  try {
    const luSocket = await online(lu);
    sockets.push(luSocket);
    sockets.push(await online(guga));
    const anaSocket = await online(ana);
    sockets.push(anaSocket);
    await send(luSocket, lu, channelId, "oiii");
    await send(anaSocket, ana, channelId, "calma kkkk tava pegando água :)");
    await send(luSocket, lu, channelId, "vai jogar hj?? (H)");
    await send(anaSocket, ana, channelId, "vou sim, 22h no QG (L)");
    await send(luSocket, lu, channelId, "fechou (Y) `(H)` http://x.com/(L)");

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await page.addInitScript((s) => localStorage.setItem("pqp:dev-user-suffix", s), ana);
    await page.goto(`/app/dm/${channelId}?lang=pt-BR`);
    await expect(composer(page)).toBeVisible({ timeout: 30_000 });

    // Hidden until found: not in the slash menu.
    await composer(page).fill("/20");
    await expect(page.getByText("/2005")).toHaveCount(0);

    await composer(page).fill("/2005");
    await composer(page).press("Enter");
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "retro");
    await expect(page.getByText("Tu achou o Modo 2005!")).toBeVisible();
    await expect(composer(page)).toHaveValue("");

    // The contact list, grouped by status, and the conversation window.
    const contacts = page.locator("[data-retro-contacts]");
    await expect(contacts.locator('[data-retro-group="online"]')).toContainText("~*Lu*~");
    await expect(contacts.locator('[data-retro-group="dnd"]')).toContainText("Guga");
    await expect(contacts.locator('[data-retro-group="offline"]')).toContainText("Offline (1)");
    await expect(page.locator("[data-retro-chrome]")).toContainText("~*Lu*~ · Conversa");

    // Emoticons render for this reader, and never inside code or a URL.
    const log = page.locator("[data-retro-window]");
    await expect(log.getByText("vai jogar hj?? 😎")).toBeVisible();
    await expect(log.locator("code", { hasText: "(H)" })).toBeVisible();
    await expect(log.locator('a[href="http://x.com/(L)"]')).toBeVisible();

    await page.screenshot({ path: join(shots, "retro-found-card.png") });
    await page.getByRole("button", { name: "Massa!" }).click();
    await expect(page.locator("[data-retro-found]")).toHaveCount(0);

    // Modo 2005 is the light half, Madrugada the dark one.
    await setTheme(page, "light");
    await page.screenshot({ path: join(shots, "retro-desktop.png") });
    await setTheme(page, "dark");
    await page.screenshot({ path: join(shots, "retro-madrugada.png") });
    await setTheme(page, "light");

    // Nothing was sent: the command is local.
    expect(await messageBodies(ana, channelId)).not.toContain("/2005");

    // A phone: no sideways scroll, the conversation and then the contacts.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(390);
    await page.screenshot({ path: join(shots, "retro-mobile-chat.png") });
    await page
      .locator("[data-retro-chrome]")
      .getByRole("button", { name: "Abrir navegação" })
      .click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(shots, "retro-mobile-contacts.png") });
    await setTheme(page, "dark");
    await page.screenshot({ path: join(shots, "retro-mobile-madrugada.png") });
    await setTheme(page, "light");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(300);

    // Once found, the command is offered and turns the look off.
    await composer(page).fill("/20");
    await expect(page.getByText("/2005").first()).toBeVisible();
    await composer(page).fill("/2005");
    await composer(page).press("Enter");
    await expect(page.locator("html")).not.toHaveAttribute("data-appearance", "retro");
    await expect(page.locator("[data-retro-contacts]")).toHaveCount(0);
    await expect(page.getByText("vai jogar hj?? (H)")).toBeVisible();
    expect(await messageBodies(ana, channelId)).not.toContain("/2005");
    await context.close();
  } finally {
    for (const socket of sockets) socket.close();
  }
});

test("the Konami code toggles the look, but not while typing", async ({ page }) => {
  const stamp = Date.now().toString(36);
  const who = `retro-konami-${stamp}`;
  const other = `retro-konami-friend-${stamp}`;
  const whoId = await person(who, "Konami");
  const otherId = await person(other, "Amiga");
  await befriend(who, whoId, other, otherId);
  const { conversation } = (await (
    await fetch(`${API}/api/dms`, {
      method: "POST",
      headers: headers(who),
      body: JSON.stringify({ userIds: [otherId] }),
    })
  ).json()) as { conversation: { channelId: string } };
  await page.addInitScript((s) => localStorage.setItem("pqp:dev-user-suffix", s), who);
  await page.goto(`/app/dm/${conversation.channelId}?lang=pt-BR`);
  // The composer is drawn once the account is loaded, which is when the
  // listener is attached.
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
  const keys = [
    "ArrowUp",
    "ArrowUp",
    "ArrowDown",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "ArrowLeft",
    "ArrowRight",
    "b",
    "a",
  ];
  // Inside the composer it is just typing (arrow up there edits a message).
  await composer(page).focus();
  for (const key of keys) await page.keyboard.press(key);
  await page.waitForTimeout(500);
  await expect(page.locator("html")).not.toHaveAttribute("data-appearance", "retro");
  await composer(page).fill("");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (const key of keys) await page.keyboard.press(key);
  await expect(page.locator("html")).toHaveAttribute("data-appearance", "retro");
  // And again turns it off.
  await page.getByRole("button", { name: "Massa!" }).click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (const key of keys) await page.keyboard.press(key);
  await expect(page.locator("html")).not.toHaveAttribute("data-appearance", "retro");
});

test("a friend signing in gets the corner card, and the tile sits in Aparência", async ({
  browser,
}, testInfo) => {
  // Two friends-list polls (15 s apart) must see somebody offline before
  // their sign-in counts, so a deploy reconnect never toasts.
  test.setTimeout(180_000);
  const shots = process.env.RETRO_SHOTS_DIR ?? testInfo.outputPath("shots");
  mkdirSync(shots, { recursive: true });
  const stamp = Date.now().toString(36);
  const ana = `retro-toast-ana-${stamp}`;
  const pedro = `retro-toast-pedro-${stamp}`;
  const anaId = await person(ana, "Ana");
  const pedroId = await person(pedro, "Pedrão", "♫ Charlie Brown Jr.");
  await befriend(ana, anaId, pedro, pedroId);

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.addInitScript((s) => {
    localStorage.setItem("pqp:dev-user-suffix", s);
    localStorage.setItem("pqp-appearance-retro", "1");
    localStorage.setItem("pqp-retro-found", new Date().toISOString());
    localStorage.setItem("pqp-theme", "light");
  }, ana);
  await page.goto(`/app/dm?lang=pt-BR`);
  await expect(page.locator("[data-retro-contacts]")).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator('[data-retro-contacts] [data-retro-group="offline"]'),
  ).toContainText("Offline (1)");

  // Two offline polls, then Pedro connects.
  await page.waitForTimeout(32_000);
  const pedroSocket = await online(pedro);
  try {
    const card = page.locator("[data-retro-online]");
    await expect(card).toContainText("Pedrão acabou de entrar.", { timeout: 25_000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(shots, "retro-online-toast.png") });
    await expect(
      page.locator('[data-retro-contacts] [data-retro-group="online"]'),
    ).toContainText("Pedrão");
  } finally {
    pedroSocket.close();
  }

  // Found once, the look has its own tile (with the "novo" tag) in Aparência.
  await page.getByRole("button", { name: "Abrir configurações" }).click();
  await page.getByRole("tab", { name: "Aparência e idioma" }).click();
  const tile = page.getByRole("radio", { name: /Modo 2005/ });
  await expect(tile).toBeVisible();
  await expect(tile).toHaveAttribute("aria-checked", "true");
  await expect(tile).toContainText("novo");
  await expect(page.getByText("Sons do Modo 2005")).toBeVisible();
  await page.screenshot({ path: join(shots, "retro-settings.png") });

  // Picking another look turns it off.
  await page.getByRole("radio", { name: /Clássico/ }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-appearance", "retro");
  await context.close();
});
