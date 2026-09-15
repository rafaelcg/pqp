import { expect, test, type Page } from "@playwright/test";

/**
 * The bottom-left user bar's status menu (`docs/plans/DM_NOTIFICATIONS_POLISH.md`
 * §8, acceptance criteria 47-53, 55, 57, 58, 60): four states in order with
 * distinct pip shapes, roving arrow-key focus that wraps, Home/End, the
 * group's accessible name, `away` surviving activity, what the other window
 * sees, the Não Perturbe chip's appearance/click-out, and persistence across
 * a reload and a second account window.
 *
 * Same dev-bypass-over-HTTP harness as the other DM-polish specs.
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

async function seedServer(aSuffix: string, bSuffix?: string): Promise<{
  serverId: string;
  channelId: string;
}> {
  const { server } = (await (
    await fetch(`${API}/api/servers`, {
      method: "POST",
      headers: headers(aSuffix),
      body: JSON.stringify({ name: `Status ${Date.now()}` }),
    })
  ).json()) as { server: { id: string } };
  const channelsRes = await fetch(`${API}/api/servers/${server.id}/channels`, {
    headers: headers(aSuffix),
  });
  const { channels } = (await channelsRes.json()) as {
    channels: { id: string; type: string }[];
  };
  const channel = channels.find((c) => c.type === "text")!;
  if (bSuffix) {
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
  }
  return { serverId: server.id, channelId: channel.id };
}

async function openAs(page: Page, path: string, suffix: string): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(`${path}?lang=en`);
  await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 20_000 });
}

const avatarButton = (page: Page) =>
  page.getByRole("button", { name: "Change your status" });
const statusGroup = (page: Page) => page.getByRole("group", { name: "Change your status" });
const row = (page: Page, name: "Online" | "Away" | "Do not disturb" | "Invisible") =>
  statusGroup(page).getByRole("menuitemradio", { name: new RegExp(`^${name}`) });

test("criterion 47: opens on click, and Escape closes it and returns focus to the avatar", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const stamp = Date.now().toString(36);
  const suffix = `stmenu-escape-${stamp}`;
  await person(suffix, "Ana");
  const { serverId, channelId } = await seedServer(suffix);

  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  await openAs(page, `/app/server/${serverId}/channel/${channelId}`, suffix);

  await avatarButton(page).click();
  await expect(statusGroup(page)).toBeVisible();
  await row(page, "Away").focus();

  await page.keyboard.press("Escape");
  await expect(statusGroup(page)).toBeHidden();
  await expect(avatarButton(page)).toBeFocused();

  // Clicking the avatar again toggles it shut too.
  await avatarButton(page).click();
  await expect(statusGroup(page)).toBeVisible();
  await avatarButton(page).click();
  await expect(statusGroup(page)).toBeHidden();

  await context.close();
});

test("criteria 47-50 & 52: opens, four states in order with distinct pips, a check on the selected row, and a group role", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const stamp = Date.now().toString(36);
  const suffix = `stmenu-abcd-${stamp}`;
  await person(suffix, "Ana");
  const { serverId, channelId } = await seedServer(suffix);

  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  await openAs(page, `/app/server/${serverId}/channel/${channelId}`, suffix);

  await avatarButton(page).click();
  const group = statusGroup(page);
  await expect(group).toBeVisible();

  // Order: Online, Away, Do not disturb, Invisible (criterion 48).
  const rows = group.getByRole("menuitemradio");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("Online");
  await expect(rows.nth(1)).toContainText("Away");
  await expect(rows.nth(2)).toContainText("Do not disturb");
  await expect(rows.nth(3)).toContainText("Invisible");

  // Online is selected by default: a check mark, and `aria-checked`.
  await expect(rows.nth(0)).toHaveAttribute("aria-checked", "true");
  await expect(rows.nth(0).locator("svg.lucide-check")).toBeVisible();
  for (const i of [1, 2, 3]) {
    await expect(rows.nth(i)).toHaveAttribute("aria-checked", "false");
  }

  // Criterion 49: each pip carries its own shape, not only its colour —
  // filled (online), a crescent cutout (away/idle), a barred rect (dnd), a
  // hollow ring (invisible/offline). Distinguished by the mask geometry
  // `status-dot.tsx` draws, not by colour alone.
  // `.first()`: the selected row (Online) also carries a trailing lucide
  // Check icon, itself an `<svg>` — the status pip is always the first one.
  const svgHtml = async (index: number) =>
    rows.nth(index).locator("svg").first().innerHTML();
  expect(await svgHtml(0)).not.toContain("<circle cx=\"2.5\"");
  expect(await svgHtml(0)).not.toContain("<rect x=\"2\" y=\"5\"");
  expect(await svgHtml(1)).toContain("<circle cx=\"2.5\""); // crescent
  expect(await svgHtml(2)).toContain("<rect x=\"2\" y=\"5\""); // dash
  expect(await svgHtml(3)).toContain("<circle cx=\"6\" cy=\"6\" r=\"3\""); // hollow ring

  // Choosing a row updates the avatar's own pip immediately (criterion 50).
  await rows.nth(1).click();
  await expect(avatarButton(page).locator("svg.text-warning")).toBeVisible({
    timeout: 5_000,
  });

  await context.close();
});

test("criterion 51: ArrowDown/ArrowUp wrap, Home/End jump, Tab reaches Send feedback", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const stamp = Date.now().toString(36);
  const suffix = `stmenu-arrows-${stamp}`;
  await person(suffix, "Ana");
  const { serverId, channelId } = await seedServer(suffix);

  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  await openAs(page, `/app/server/${serverId}/channel/${channelId}`, suffix);

  await avatarButton(page).click();
  await row(page, "Online").focus();

  await page.keyboard.press("ArrowDown");
  await expect(row(page, "Away")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(row(page, "Do not disturb")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(row(page, "Invisible")).toBeFocused();
  // Wraps forward past the last row.
  await page.keyboard.press("ArrowDown");
  await expect(row(page, "Online")).toBeFocused();
  // Wraps backward past the first row.
  await page.keyboard.press("ArrowUp");
  await expect(row(page, "Invisible")).toBeFocused();

  await page.keyboard.press("Home");
  await expect(row(page, "Online")).toBeFocused();
  await page.keyboard.press("End");
  await expect(row(page, "Invisible")).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(page.getByRole("menuitem", { name: "Send feedback" })).toBeFocused();

  await context.close();
});

test("criterion 53: Away survives typing, clicking and moving the pointer", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const stamp = Date.now().toString(36);
  const suffix = `stmenu-away-${stamp}`;
  await person(suffix, "Ana");
  const { serverId, channelId } = await seedServer(suffix);

  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  await openAs(page, `/app/server/${serverId}/channel/${channelId}`, suffix);

  await avatarButton(page).click();
  await row(page, "Away").click();
  await expect(avatarButton(page).locator("svg.text-warning")).toBeVisible({
    timeout: 5_000,
  });

  // Activity that would clear a DERIVED idle: typing, a click, pointer
  // movement. `away` is a declaration (`resolveOwnStatus` returns "idle"
  // unconditionally for it, never reading the idle timer), so this is
  // deterministic rather than a race against the 10-minute idle timer — the
  // full "still amber after a minute" from the spec is the same property
  // over a longer, untested wall clock, which a live suite has no business
  // waiting out (same reasoning `dm-toast.spec.ts` gives for not waiting out
  // the real 6s toast expiry).
  const composer = page.getByPlaceholder(/Message/);
  await composer.click();
  await composer.type("ainda ausente");
  await page.mouse.move(200, 200);
  await page.mouse.move(400, 300);
  await page.waitForTimeout(3_000);

  await expect(avatarButton(page).locator("svg.text-warning")).toBeVisible();
  await composer.fill("");

  await context.close();
});

test("criterion 55: window B sees window A's Away as the ordinary amber crescent", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stamp = Date.now().toString(36);
  const a = `stmenu-55a-${stamp}`;
  const b = `stmenu-55b-${stamp}`;
  await person(a, "Ana");
  const bId = await person(b, "Bia");
  void bId;
  const { serverId, channelId } = await seedServer(a, b);

  const aContext = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const aPage = await aContext.newPage();
  await openAs(aPage, `/app/server/${serverId}/channel/${channelId}`, a);
  await avatarButton(aPage).click();
  await row(aPage, "Away").click();

  const bContext = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const bPage = await bContext.newPage();
  await openAs(bPage, `/app/server/${serverId}/channel/${channelId}`, b);

  // Ana's member row on Bia's screen: amber crescent, same pip a derived
  // idle member would get — no third-party signal that it was a choice.
  const anaRow = bPage.locator('[data-member-sidebar-trigger]', { hasText: "Ana" }).first();
  await expect(anaRow).toBeVisible({ timeout: 20_000 });
  const pip = anaRow.locator("svg.text-warning");
  await expect(pip).toBeVisible({ timeout: 15_000 });

  await aContext.close();
  await bContext.close();
});

test("criteria 57 & 58: the DND chip appears only for Não Perturbe, and clicking it clears the status", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const stamp = Date.now().toString(36);
  const suffix = `stmenu-chip-${stamp}`;
  await person(suffix, "Ana");
  const { serverId, channelId } = await seedServer(suffix);

  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  await openAs(page, `/app/server/${serverId}/channel/${channelId}`, suffix);

  const chip = page.locator('button:has(svg.lucide-bell-off)').first();

  // Absent on Online (default).
  await expect(chip).toHaveCount(0);

  // Absent on Away too.
  await avatarButton(page).click();
  await row(page, "Away").click();
  await expect(chip).toHaveCount(0);

  // Appears on Do not disturb.
  await avatarButton(page).click();
  await row(page, "Do not disturb").click();
  await expect(chip).toBeVisible({ timeout: 10_000 });

  // Clicking it clears the status back to Online and the chip disappears.
  await chip.click();
  await expect(chip).toHaveCount(0, { timeout: 10_000 });
  await avatarButton(page).click();
  await expect(row(page, "Online")).toHaveAttribute("aria-checked", "true");

  // Absent on Invisible.
  await row(page, "Invisible").click();
  await expect(chip).toHaveCount(0);

  await context.close();
});

test("criterion 60: the choice survives a reload and shows up in a second window", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stamp = Date.now().toString(36);
  const suffix = `stmenu-persist-${stamp}`;
  await person(suffix, "Ana");
  const { serverId, channelId } = await seedServer(suffix);

  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  await openAs(page, `/app/server/${serverId}/channel/${channelId}`, suffix);

  await avatarButton(page).click();
  await row(page, "Do not disturb").click();
  await expect(page.locator('button:has(svg.lucide-bell-off)').first()).toBeVisible({
    timeout: 10_000,
  });

  await page.reload();
  await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 20_000 });
  await avatarButton(page).click();
  await expect(row(page, "Do not disturb")).toHaveAttribute("aria-checked", "true", {
    timeout: 10_000,
  });

  // A second window, same account (no suffix override — the dev bypass's
  // shared "Dev User" identity would not prove this; instead reuse the SAME
  // suffix in a second context so it is genuinely the same server-side row).
  const second = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const secondPage = await second.newPage();
  await openAs(secondPage, `/app/server/${serverId}/channel/${channelId}`, suffix);
  await avatarButton(secondPage).click();
  await expect(row(secondPage, "Do not disturb")).toHaveAttribute("aria-checked", "true", {
    timeout: 15_000,
  });

  await context.close();
  await second.close();
});
