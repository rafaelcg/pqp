import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";

/**
 * THE MIXED CHANNEL LIST WITH TWO REAL ACCOUNTS (two dev users, two browser
 * contexts). The flag goes on for one server the way the operator does it
 * (a per-server override with the machine token) and its data moves through
 * the operator's migrate route, so this is the production path end to end:
 * flag, migration, `GET .../channel-layout`, the drag, the full-order PUT,
 * `channels-update`, the member's refetch.
 *
 * - The owner drags Lobby between two rows of another category; the member's
 *   sidebar follows live, without a reload.
 * - A second manager window that missed the update drags too, gets the 409,
 *   says so, and ends on the fresh list.
 *
 * With `SHOT_DIR` set it also saves the QA screenshots (1280 and 390, dark and
 * light, pt-BR), which are compared to the redesign mocks and not committed.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const SHOTS = process.env.SHOT_DIR ?? "";

test.setTimeout(120_000);

function headersFor(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

async function api<T>(suffix: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: headersFor(suffix) });
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function machine(path: string, method: string, body: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${E2E_ADMIN_TOKEN}` },
    body: JSON.stringify(body),
  });
  expect(res.status, `${method} ${path}`).toBe(200);
  return res.json();
}

async function materialise(suffix: string): Promise<void> {
  const me = await api<{ ageGate?: string }>(suffix, "/api/me");
  if (me.ageGate && me.ageGate !== "passed") {
    await api(suffix, "/api/me/age-check", {
      method: "POST",
      body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
    });
  }
  await api(suffix, "/api/me/preferences", {
    method: "PATCH",
    body: JSON.stringify({
      onboardedAt: new Date().toISOString(),
      firstRunDismissedAt: new Date().toISOString(),
    }),
  });
}

interface Seeded {
  serverId: string;
  ids: Record<string, string>;
}

/**
 * The redesign's "before" server (TEXTO, VOZ and a Jogos category), made with
 * the flag off, then switched on and migrated: Canais holds the old loose
 * channels in the same order, Jogos and an empty Cinema follow.
 */
async function seed(owner: string, member: string): Promise<Seeded> {
  await materialise(owner);
  await materialise(member);
  const { server } = await api<{ server: { id: string } }>(owner, "/api/servers", {
    method: "POST",
    body: JSON.stringify({ name: "Resenha dos Guris" }),
  });
  const create = async (name: string, type: string, parentId: string | null = null) =>
    (
      await api<{ channel: { id: string } }>(owner, `/api/servers/${server.id}/channels`, {
        method: "POST",
        body: JSON.stringify({ name, type, ...(type === "category" ? {} : { parentId }) }),
      })
    ).channel.id;
  await create("test", "text");
  await create("duvidas", "text");
  await create("Squad", "voice");
  const jogos = await create("Jogos", "category");
  await create("clipes", "text", jogos);
  await create("lfg", "text", jogos);
  await create("Cinema", "category");
  const { invite } = await api<{ invite: { code: string } }>(
    owner,
    `/api/servers/${server.id}/invites`,
    { method: "POST", body: JSON.stringify({}) },
  );
  await api(member, `/api/invites/${invite.code}/join`, { method: "POST" });

  await machine("/api/admin/flag-overrides", "PUT", {
    key: "mixed_channel_list",
    serverId: server.id,
    enabled: true,
  });
  const migrated = (await machine("/api/admin/channel-layout", "POST", {
    serverId: server.id,
    action: "migrate",
  })) as { status: string };
  expect(migrated.status).toBe("migrated");

  const { channels } = await api<{ channels: { id: string; name: string }[] }>(
    owner,
    `/api/servers/${server.id}/channels`,
  );
  return {
    serverId: server.id,
    ids: Object.fromEntries(channels.map((channel) => [channel.name, channel.id])),
  };
}

async function open(
  browser: Browser,
  suffix: string,
  path: string,
  options: { phone?: boolean; scheme?: "dark" | "light"; lang?: string } = {},
): Promise<Page> {
  const context = await browser.newContext({
    viewport: options.phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    colorScheme: options.scheme ?? "dark",
    ...(options.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await context.newPage();
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(`${path}?lang=${options.lang ?? "en"}`);
  return page;
}

/** Channel names of one category, in the order the sidebar draws them. */
async function namesIn(page: Page, categoryId: string): Promise<string[]> {
  return page
    .locator(`[data-category-group="${categoryId}"] [data-channel-id]`)
    .evaluateAll((rows) =>
      rows.map((row) => row.querySelector("button span.truncate")?.textContent?.trim() ?? ""),
    );
}

function row(page: Page, id: string) {
  return page.locator(`[data-channel-id="${id}"] > [draggable]`).first();
}

/**
 * A real HTML5 drag with the mouse: press on the source, nudge it so the
 * drag starts, THEN measure the target (a drag can change what is on screen)
 * and release at `yFraction` of its height.
 */
async function drag(page: Page, source: Locator, target: Locator, yFraction = 0.5) {
  const from = (await source.boundingBox())!;
  await page.mouse.move(from.x + 30, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 34, from.y + from.height / 2 + 6, { steps: 3 });
  const to = (await target.boundingBox())!;
  await page.mouse.move(to.x + 30, to.y + to.height * yFraction, { steps: 10 });
  await page.mouse.up();
}

test.describe("mixed channel list", () => {
  test("the owner drags Lobby into Jogos; the member's sidebar follows live", async ({ browser }) => {
    const stamp = Date.now().toString(36);
    const owner = `layoutowner${stamp}`.slice(0, 32);
    const member = `layoutmember${stamp}`.slice(0, 32);
    const seeded = await seed(owner, member);
    const canais = seeded.ids.Canais!;
    const jogos = seeded.ids.Jogos!;

    const ownerPage = await open(browser, owner, `/app/server/${seeded.serverId}`);
    const memberPage = await open(browser, member, `/app/server/${seeded.serverId}`);
    for (const page of [ownerPage, memberPage]) {
      await expect(page.locator("[data-channel-list-mixed]")).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => namesIn(page, canais)).toEqual([
        "general",
        "test",
        "duvidas",
        "Lobby",
        "Squad",
      ]);
    }
    // Categories are the only headers; members see no empty category and no
    // Criar categoria; the owner does.
    await expect(ownerPage.locator("[data-create-category]")).toBeVisible();
    await expect(memberPage.locator("[data-create-category]")).toHaveCount(0);
    await expect(memberPage.locator(`[data-category-id="${seeded.ids.Cinema}"]`)).toHaveCount(0);
    await expect(ownerPage.locator(`[data-category-id="${seeded.ids.Cinema}"]`)).toBeVisible();

    // Lobby onto the lower half of clipes: between clipes and lfg.
    await drag(ownerPage, row(ownerPage, seeded.ids.Lobby!), row(ownerPage, seeded.ids.clipes!), 0.8);

    await expect.poll(() => namesIn(ownerPage, jogos)).toEqual(["clipes", "Lobby", "lfg"]);
    await expect(ownerPage.locator("[data-channel-list-status]")).toContainText(
      "Lobby moved to Jogos, position 2 of 3.",
    );
    // The member never reloaded.
    await expect.poll(() => namesIn(memberPage, jogos), { timeout: 15_000 }).toEqual([
      "clipes",
      "Lobby",
      "lfg",
    ]);
    await expect.poll(() => namesIn(memberPage, canais)).toEqual([
      "general",
      "test",
      "duvidas",
      "Squad",
    ]);

    await ownerPage.context().close();
    await memberPage.context().close();
  });

  test("a manager working from an old list is told, and ends on the fresh one", async ({ browser }) => {
    const stamp = Date.now().toString(36);
    const owner = `layoutrace${stamp}`.slice(0, 32);
    const member = `layoutracem${stamp}`.slice(0, 32);
    const seeded = await seed(owner, member);
    const canais = seeded.ids.Canais!;
    const jogos = seeded.ids.Jogos!;

    const first = await open(browser, owner, `/app/server/${seeded.serverId}`);
    const second = await open(browser, owner, `/app/server/${seeded.serverId}`);
    for (const page of [first, second]) {
      await expect(page.locator("[data-channel-list-mixed]")).toBeVisible({ timeout: 20_000 });
    }
    // The second window misses the update: its refetches never land.
    await second.route(`**/api/servers/${seeded.serverId}/channels`, (route) => route.abort());

    const intoJogos = (page: Page) =>
      page.locator(`[data-category-id="${jogos}"]`);
    await drag(first, row(first, seeded.ids.test!), intoJogos(first));
    await expect.poll(() => namesIn(first, jogos)).toEqual(["clipes", "lfg", "test"]);

    await drag(second, row(second, seeded.ids.duvidas!), intoJogos(second));
    await expect(second.locator("[data-channel-list-status]")).toContainText(
      "Couldn't move it. The list changed, try again.",
    );
    // The 409 carried the fresh list: the first window's move is there, the
    // refused one is not.
    await expect.poll(() => namesIn(second, jogos)).toEqual(["clipes", "lfg", "test"]);
    await expect.poll(() => namesIn(second, canais)).toEqual([
      "general",
      "duvidas",
      "Lobby",
      "Squad",
    ]);
    await second.unroute(`**/api/servers/${seeded.serverId}/channels`);

    await first.context().close();
    await second.context().close();
  });

  test("QA screenshots", async ({ browser }) => {
    test.skip(!SHOTS, "Set SHOT_DIR to save the redesign screenshots.");
    const stamp = Date.now().toString(36);
    const owner = `layoutshots${stamp}`.slice(0, 32);
    const member = `layoutshotsm${stamp}`.slice(0, 32);
    const seeded = await seed(owner, member);
    const path = `/app/server/${seeded.serverId}/channel/${seeded.ids.general}`;

    for (const scheme of ["dark", "light"] as const) {
      const page = await open(browser, owner, path, { scheme, lang: "pt-BR" });
      await expect(page.locator("[data-channel-list-mixed]")).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${SHOTS}/web-1280-${scheme}.png` });

      // Mid-drag: Lobby lifted over the lower half of clipes.
      const source = row(page, seeded.ids.Lobby!);
      const target = row(page, seeded.ids.clipes!);
      const from = (await source.boundingBox())!;
      await page.mouse.move(from.x + 40, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + 44, from.y + from.height / 2 + 6, { steps: 3 });
      const to = (await target.boundingBox())!;
      await page.mouse.move(to.x + 40, to.y + to.height * 0.8, { steps: 8 });
      // A browser repeats dragover while the pointer rests; the emulated drag
      // does not, so rest by wiggling a pixel.
      await page.mouse.move(to.x + 41, to.y + to.height * 0.8);
      await page.mouse.move(to.x + 40, to.y + to.height * 0.8);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/web-1280-${scheme}-drag-row.png` });
      // Over a category header: the whole header lights up.
      const header = page.locator(`[data-category-id="${seeded.ids.Cinema}"]`);
      const headerBox = (await header.boundingBox())!;
      await page.mouse.move(headerBox.x + 40, headerBox.y + headerBox.height / 2, { steps: 6 });
      await page.mouse.move(headerBox.x + 41, headerBox.y + headerBox.height / 2);
      await page.mouse.move(headerBox.x + 40, headerBox.y + headerBox.height / 2);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/web-1280-${scheme}-drag-header.png` });
      await page.keyboard.press("Escape");
      await page.mouse.up();

      // The per-category "+".
      await page.locator(`[data-category-id="${seeded.ids.Canais}"]`).hover();
      await page.locator(`[data-category-id="${seeded.ids.Canais}"] [data-category-add]`).click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/web-1280-${scheme}-category-add.png` });
      await page.keyboard.press("Escape");

      // The row menu, crossing a category border.
      await row(page, seeded.ids.clipes!).click({ button: "right" });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/web-1280-${scheme}-row-menu.png` });
      await page.keyboard.press("Escape");
      await page.context().close();

      const phone = await open(browser, owner, path, { phone: true, scheme, lang: "pt-BR" });
      await phone.getByRole("button", { name: "Abrir navegação" }).first().click({ timeout: 20_000 });
      await expect(phone.locator("[data-channel-list-mixed]")).toBeVisible({ timeout: 20_000 });
      await phone.waitForTimeout(600);
      await phone.screenshot({ path: `${SHOTS}/web-390-${scheme}.png` });
      // Organizar canais from the server menu.
      await phone.locator("[data-server-header] button").first().click();
      await phone.getByRole("menuitem", { name: "Organizar canais" }).click();
      await expect(phone.locator("[data-organize-channels]")).toBeVisible();
      await phone.waitForTimeout(300);
      await phone.screenshot({ path: `${SHOTS}/web-390-${scheme}-organize.png` });
      await phone.context().close();
    }
  });
});
