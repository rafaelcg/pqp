/**
 * A JAM SONG TRAVELS INTO THE CONVERSATION, with real clicks and real keys.
 *
 *  1. SHARE. In an open song, "Send to chat" (the pill beside the title, and the
 *     "..." menu's first row) opens a picker of the server's TEXT channels the
 *     person may write in; one tap posts the song's link there.
 *  2. THE CARD. A message holding that link shows one compact card under it (the
 *     picture, the title, who is on it, what is missing); its round button plays
 *     the song right there through the Jam's one player (the clock advances and
 *     the Jam's row in the sidebar says it is playing) and the card itself opens
 *     the song. Somebody who may not open the Jam, a server that paused the
 *     feature, and a song with no take all see an ordinary link: never a card,
 *     never the title.
 *  3. FIND IT. Ctrl/Cmd+K lists the open server's Jam by name and its songs by
 *     title, and Enter opens the song.
 *
 * The audio is a ten second WAV declared as `audio/flac` (the server never
 * decodes audio; the browser decodes by the bytes). Needs object storage like
 * `jam-web.spec.ts` (`S3_*` exported); without it the spec skips with that reason.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";
import { call, seedJamShare, type JamShareSeed } from "./jam-share-seed";

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const RUN = Date.now().toString(36).slice(-5);
let people = 0;

test.setTimeout(150_000);
test.use({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });

async function setGlobalFlag(key: string, enabled: boolean | null): Promise<void> {
  const res = await fetch(`${API}/api/admin/flags`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${E2E_ADMIN_TOKEN}` },
    body: JSON.stringify({ key, enabled }),
  });
  expect(res.status).toBe(200);
}

async function setServerFlag(key: string, serverId: string, enabled: boolean): Promise<void> {
  const res = await fetch(`${API}/api/admin/flag-overrides`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${E2E_ADMIN_TOKEN}` },
    body: JSON.stringify({ key, serverId, enabled }),
  });
  expect(res.status).toBe(200);
}

test.beforeAll(async () => {
  // Ctrl/Cmd+K is the switcher only while Conversas is on (production has it on).
  await setGlobalFlag("conversations_home", true);
});

test.afterAll(async () => {
  await setGlobalFlag("conversations_home", null);
});

async function seedRoom(): Promise<JamShareSeed> {
  people += 1;
  const seeded = await seedJamShare(API, E2E_ADMIN_TOKEN, `${RUN}${people}`);
  test.skip(!seeded.uploads, "object storage is not configured (S3_*): no take can be uploaded");
  return seeded;
}

async function openAs(browser: Browser, suffix: string, route: string, viewport = { width: 1440, height: 900 }): Promise<Page> {
  const context = await browser.newContext({ viewport, colorScheme: "dark" });
  const page = await context.newPage();
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(`${route}${route.includes("?") ? "&" : "?"}lang=en`);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
  return page;
}

/** The clock's seconds on a card, as a person reads it ("0:03 / 0:10"). */
async function cardSeconds(card: ReturnType<Page["locator"]>): Promise<number> {
  const text = await card.innerText();
  const match = /(\d+):(\d{2}) \/ \d+:\d{2}/.exec(text);
  return match ? Number(match[1]) * 60 + Number(match[2]) : -1;
}

async function sendLink(page: Page, text: string) {
  const composer = page.getByPlaceholder(/Message/);
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await composer.fill(text);
  await page.keyboard.press("Enter");
}

test("share from the song panel into a text channel, and the card there plays and opens the song", async ({ browser }) => {
  const seed = await seedRoom();
  const member = await openAs(browser, seed.member, `/app/server/${seed.serverId}/channel/${seed.jamId}/song/${seed.bloom}`);
  const panel = member.locator(`[data-jam-song="${seed.bloom}"]`);
  await expect(panel).toBeVisible({ timeout: 20_000 });

  // The visible button, the picker, and only text channels in it
  await panel.locator("[data-jam-share-open]").click();
  const picker = member.locator("[data-jam-share-picker]");
  await expect(picker).toBeVisible();
  await expect(picker.locator(`[data-jam-share-channel="${seed.musicaId}"]`)).toBeVisible();
  await expect(picker.locator(`[data-jam-share-channel="${seed.generalId}"]`)).toBeVisible();
  await expect(picker.locator(`[data-jam-share-channel="${seed.jamId}"]`)).toHaveCount(0);
  await picker.locator(`[data-jam-share-channel="${seed.musicaId}"]`).click();
  await expect(picker.locator(`[data-jam-share-channel="${seed.musicaId}"]`)).toContainText("Sent");
  await member.keyboard.press("Escape");

  // The "..." menu has it too (first row)
  await panel.locator("[data-jam-song-menu]").click();
  await expect(member.getByRole("menuitem", { name: "Send to chat" })).toBeVisible();
  await member.keyboard.press("Escape");

  // The host reads #musica: one card, no raw URL
  const host = await openAs(browser, seed.host, `/app/server/${seed.serverId}/channel/${seed.musicaId}`);
  const card = host.locator(`[data-jam-link-card="${seed.bloom}"]`);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText("In Bloom");
  await expect(card).toContainText("Nirvana");
  await expect(host.getByText(`/song/${seed.bloom}`)).toHaveCount(0);
  const box = await card.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(64);
  expect(box!.height).toBeLessThanOrEqual(72);

  // The round button plays right there: the clock advances and the sidebar's Jam row says playing
  await card.locator("[data-jam-card-play]").click();
  await expect(card).toHaveAttribute("data-state", "playing", { timeout: 15_000 });
  await expect(host.locator('[data-jam-icon][data-mood="playing"]')).toBeVisible();
  const first = await cardSeconds(card);
  await expect.poll(() => cardSeconds(card), { timeout: 8_000 }).toBeGreaterThan(first);
  // and pauses
  await card.locator("[data-jam-card-play]").click();
  await expect(card).toHaveAttribute("data-state", "paused");
  await expect(host.locator('[data-jam-icon][data-mood="playing"]')).toHaveCount(0);

  // Playing again, the card opens the song and the song goes on from where it is (the wall's tile too)
  await card.locator("[data-jam-card-play]").click();
  await expect(card).toHaveAttribute("data-state", "playing", { timeout: 15_000 });
  await card.locator("[data-jam-card-open]").click();
  await expect(host).toHaveURL(new RegExp(`/channel/${seed.jamId}/song/${seed.bloom}`));
  await expect(host.locator(`[data-jam-song="${seed.bloom}"]`)).toBeVisible({ timeout: 15_000 });
  const panelClock = async () => {
    const text = await host.locator(`[data-jam-song="${seed.bloom}"] [data-jam-clock]`).first().innerText();
    const match = /(\d+):(\d{2})/.exec(text);
    return match ? Number(match[1]) * 60 + Number(match[2]) : -1;
  };
  const before = await panelClock();
  await expect.poll(panelClock, { timeout: 8_000 }).toBeGreaterThan(before);
  await expect(host.locator('[data-jam-icon][data-mood="playing"]')).toBeVisible();
  await host.context().close();
  await member.context().close();
});

test("keyboard: the card is the title link plus the round button, and Space plays", async ({ browser }) => {
  const seed = await seedRoom();
  const member = await openAs(browser, seed.member, `/app/server/${seed.serverId}/channel/${seed.musicaId}`);
  // The pasted address is on this instance only when it is the page's own origin
  const origin = await member.evaluate(() => window.location.origin);
  await sendLink(member, `${origin}/app/server/${seed.serverId}/channel/${seed.jamId}/song/${seed.riff}`);
  const card = member.locator(`[data-jam-link-card="${seed.riff}"]`);
  await expect(card).toBeVisible({ timeout: 20_000 });
  // "Falta baixo": what the song is still missing, in words
  await expect(card).toContainText(/needs bass/i);
  const open = card.locator("[data-jam-card-open]");
  const play = card.locator("[data-jam-card-play]");
  await open.focus();
  await expect(open).toBeFocused();
  await member.keyboard.press("Tab");
  await expect(play).toBeFocused();
  await member.keyboard.press("Space");
  await expect(card).toHaveAttribute("data-state", "playing", { timeout: 15_000 });
  await member.keyboard.press("Enter");
  await expect(card).toHaveAttribute("data-state", "paused");
  await member.context().close();
});

test("a person who may not open the Jam, a paused Jam and a song with no take show an ordinary link", async ({ browser }) => {
  const seed = await seedRoom();
  // The outsider has a server of their own and pastes the host's song link there
  const { server } = await call<{ server: { id: string } }>(API, seed.outsider, "POST", "/api/servers", { name: `Fora ${RUN}${people}` });
  const channels = await call<{ channels: { id: string; type: string }[] }>(API, seed.outsider, "GET", `/api/servers/${server.id}/channels`);
  const general = channels.channels.find((channel) => channel.type === "text")!;
  const outsider = await openAs(browser, seed.outsider, `/app/server/${server.id}/channel/${general.id}`);
  const origin = await outsider.evaluate(() => window.location.origin);
  const link = (songId: string) => `${origin}/app/server/${seed.serverId}/channel/${seed.jamId}/song/${songId}`;
  await sendLink(outsider, `olha ${link(seed.bloom)}`);
  await expect(outsider.getByText(`olha ${link(seed.bloom)}`)).toBeVisible({ timeout: 20_000 });
  // give the card every chance to appear: it must not
  await outsider.waitForTimeout(1500);
  await expect(outsider.locator("[data-jam-link-card]")).toHaveCount(0);
  await expect(outsider.locator("[data-jam-link-card-skeleton]")).toHaveCount(0);
  await expect(outsider.getByText("In Bloom")).toHaveCount(0);
  await expect(outsider.getByText("Nirvana")).toHaveCount(0);
  await outsider.context().close();

  // A song with no take yet: its author sees a plain link, not a card
  const host = await openAs(browser, seed.host, `/app/server/${seed.serverId}/channel/${seed.musicaId}`);
  const hostOrigin = await host.evaluate(() => window.location.origin);
  await sendLink(host, `rascunho ${hostOrigin}/app/server/${seed.serverId}/channel/${seed.jamId}/song/${seed.draft}`);
  await expect(host.getByText(`/song/${seed.draft}`)).toBeVisible({ timeout: 20_000 });
  await host.waitForTimeout(1500);
  await expect(host.locator(`[data-jam-link-card="${seed.draft}"]`)).toHaveCount(0);

  // The feature paused for the server: a link that had a card is a link again
  await sendLink(host, `${hostOrigin}/app/server/${seed.serverId}/channel/${seed.jamId}/song/${seed.bloom}`);
  await expect(host.locator(`[data-jam-link-card="${seed.bloom}"]`)).toBeVisible({ timeout: 20_000 });
  await setServerFlag("jam_channels", seed.serverId, false);
  const again = await openAs(browser, seed.host, `/app/server/${seed.serverId}/channel/${seed.musicaId}`);
  await expect(again.getByText(`/song/${seed.bloom}`)).toBeVisible({ timeout: 20_000 });
  await again.waitForTimeout(1500);
  await expect(again.locator(`[data-jam-link-card="${seed.bloom}"]`)).toHaveCount(0);
  await host.context().close();
  await again.context().close();
});

test("Ctrl/Cmd+K finds the Jam by name and its songs by title, and Enter opens the song", async ({ browser }) => {
  const seed = await seedRoom();
  const page = await openAs(browser, seed.member, `/app/server/${seed.serverId}/channel/${seed.musicaId}`);
  await expect(page.getByRole("button", { name: "Search messages" })).toBeVisible({ timeout: 20_000 });
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  const switcher = page.locator("[data-quick-switcher]");

  await page.keyboard.press(`${mod}+k`);
  await expect(switcher).toBeVisible();
  await page.keyboard.type("jam");
  await expect(switcher.getByRole("option", { name: /jam/i }).first()).toBeVisible();
  await page.keyboard.press("Escape");

  await page.keyboard.press(`${mod}+k`);
  await page.keyboard.type("bloo");
  const hit = switcher.getByRole("option", { name: /In Bloom/ });
  await expect(hit).toBeVisible({ timeout: 10_000 });
  await expect(switcher.getByText("Songs", { exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/channel/${seed.jamId}/song/${seed.bloom}`));
  await expect(page.locator(`[data-jam-song="${seed.bloom}"]`)).toBeVisible({ timeout: 15_000 });

  await page.context().close();
});
