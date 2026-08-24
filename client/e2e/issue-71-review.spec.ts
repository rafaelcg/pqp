import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Visual proof for the #71 close-out: channel overwrites, live permission
 * refresh, hoist sections, and role colour. Gated so CI does not pay for a
 * three-client video run on every push.
 *
 *   ISSUE_71_REVIEW=1 pnpm --filter @pqp/client exec playwright test e2e/issue-71-review.spec.ts
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const REVIEW = process.env.ISSUE_71_REVIEW === "1";
const OUT = fileURLToPath(new URL("../../docs/review/issue-71/", import.meta.url));
const PINK = "#e91e8c";
const PINK_RGB = "rgb(233, 30, 140)";
const SEND = 1n << 7n;
const VIEW = 1n << 6n;

test.skip(!REVIEW, "set ISSUE_71_REVIEW=1 to capture review artifacts");
test.setTimeout(180_000);

const VIEWPORT = { width: 1440, height: 900 } as const;

function headersFor(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

interface Account {
  id: string;
  displayName: string;
  suffix: string;
}

interface Seed {
  serverId: string;
  generalId: string;
  announcementsId: string;
  staffRoomId: string;
  privateId: string;
  owner: Account;
  staff: Account;
  muted: Account;
}

async function api<T>(
  suffix: string,
  method: string,
  url: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: headersFor(suffix),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${url} → ${res.status} ${text}`);
  }
  if (res.status === 204) {
    return {} as T;
  }
  return (await res.json()) as T;
}

async function materialise(
  suffix: string,
  displayName: string,
): Promise<Account> {
  const headers = headersFor(suffix);
  const me = await api<{ id: string; ageGate?: string }>(suffix, "GET", "/api/me");
  if (me.ageGate && me.ageGate !== "passed") {
    await fetch(`${API}/api/me/age-check`, {
      method: "POST",
      headers,
      body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
    });
  }
  await api(suffix, "PATCH", "/api/me/preferences", {
    onboardedAt: new Date().toISOString(),
    firstRunDismissedAt: new Date().toISOString(),
  });
  await api(suffix, "PATCH", "/api/me", { displayName });
  const again = await api<{ id: string; displayName: string }>(
    suffix,
    "GET",
    "/api/me",
  );
  return { id: again.id, displayName: again.displayName, suffix };
}

async function seed(): Promise<Seed> {
  const owner = await materialise("i71o", "Ana Owner");
  const staff = await materialise("i71s", "Bia Staff");
  const muted = await materialise("i71m", "Cris Member");

  const { server } = await api<{ server: { id: string } }>(
    owner.suffix,
    "POST",
    "/api/servers",
    { name: `Issue 71 ${Date.now()}` },
  );

  const { channels: initial } = await api<{
    channels: { id: string; name: string; type: string }[];
  }>(owner.suffix, "GET", `/api/servers/${server.id}/channels`);
  const general = initial.find((row) => row.type === "text")!;

  const make = (name: string, isPrivate = false) =>
    api<{ channel: { id: string } }>(
      owner.suffix,
      "POST",
      `/api/servers/${server.id}/channels`,
      { name, type: "text", isPrivate },
    );

  const announcements = await make("announcements");
  const staffRoom = await make("staff-room");
  const privateDen = await make("private-den", true);

  const { invite } = await api<{ invite: { code: string } }>(
    owner.suffix,
    "POST",
    `/api/servers/${server.id}/invites`,
    {},
  );
  await api(staff.suffix, "POST", `/api/invites/${invite.code}/join`);
  await api(muted.suffix, "POST", `/api/invites/${invite.code}/join`);

  return {
    serverId: server.id,
    generalId: general.id,
    announcementsId: announcements.channel.id,
    staffRoomId: staffRoom.channel.id,
    privateId: privateDen.channel.id,
    owner,
    staff,
    muted,
  };
}

async function openAs(
  page: Page,
  shared: Seed,
  account: Account,
  channelId: string,
): Promise<void> {
  await page.addInitScript(
    ({ suffix }) => {
      localStorage.setItem("pqp:dev-user-suffix", suffix);
      localStorage.setItem("pqp:locale", "en");
    },
    { suffix: account.suffix },
  );
  await page.goto(
    `/app/server/${shared.serverId}/channel/${channelId}?lang=en`,
  );
  await expect(page.getByText("Dev auth bypass")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByPlaceholder(/^Message /)).toBeVisible({
    timeout: 20_000,
  });
}

async function client(browser: Browser) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    locale: "en-US",
    colorScheme: "dark",
    recordVideo: { dir: OUT, size: VIEWPORT },
  });
  const page = await context.newPage();
  return { context, page };
}

async function shot(target: Page | Locator, name: string): Promise<void> {
  await target.screenshot({
    path: path.join(OUT, name),
    animations: "disabled",
  });
}

function channelBtn(page: Page, name: string): Locator {
  return page.getByRole("button", { name: new RegExp(`^${name}(?:\\s|$)`) });
}

function permRow(dialog: Locator, label: string): Locator {
  return dialog.getByText(label, { exact: true }).locator("xpath=..");
}

async function closeDialog(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 10_000 });
}

async function send(page: Page, body: string): Promise<void> {
  const composer = page.getByPlaceholder(/^Message /);
  await composer.click();
  await composer.fill(body);
  await composer.press("Enter");
}

async function bitsFor(
  suffix: string,
  serverId: string,
  channelId: string,
): Promise<bigint> {
  const snap = await api<{ channels: Record<string, string> }>(
    suffix,
    "GET",
    `/api/servers/${serverId}/permissions`,
  );
  return BigInt(snap.channels[channelId] ?? "0");
}

test("issue 71: overwrites, hoist, colour, live eviction", async ({
  browser,
}) => {
  fs.mkdirSync(OUT, { recursive: true });
  const shared = await seed();

  const owner = await client(browser);
  const staff = await client(browser);
  const muted = await client(browser);

  try {
    await openAs(owner.page, shared, shared.owner, shared.announcementsId);
    await openAs(staff.page, shared, shared.staff, shared.announcementsId);
    await openAs(muted.page, shared, shared.muted, shared.announcementsId);

    await expect(owner.page.locator("[data-member-sidebar]")).toBeVisible();
    await expect(
      owner.page.locator('[data-member-section="online"]'),
    ).toContainText(shared.staff.displayName, { timeout: 20_000 });
    await expect(
      owner.page.locator('[data-member-section="online"]'),
    ).toContainText(shared.muted.displayName);

    // --- Roles: hoist + colour ---
    await owner.page.getByRole("button", { name: "Community settings" }).first().click();
    const settings = owner.page.getByRole("dialog");
    await expect(settings).toBeVisible();
    await settings.getByRole("tab", { name: "Roles", exact: true }).click();
    await expect(settings.getByRole("heading", { name: "Roles" })).toBeVisible();

    await settings.getByRole("button", { name: "@everyone" }).click();
    await expect(
      settings.getByRole("switch", { name: /Show separately/ }),
    ).toHaveCount(0);
    await expect(settings.locator('input[type="color"]')).toHaveCount(0);
    await shot(settings, "01-roles-everyone-no-hoist-colour.png");

    await settings.getByRole("textbox", { name: "New role" }).fill("Staff");
    await settings.getByRole("button", { name: "Add" }).click();
    await expect(settings.getByRole("textbox", { name: "Role name" })).toHaveValue(
      "Staff",
      { timeout: 10_000 },
    );

    const hoist = settings.getByRole("switch", { name: /Show separately/ });
    await hoist.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await expect(hoist).toBeVisible();
    if ((await hoist.getAttribute("aria-checked")) !== "true") {
      await hoist.click();
    }
    await expect(hoist).toHaveAttribute("aria-checked", "true");

    const colorInput = settings.locator('input[type="color"]');
    await colorInput.evaluate((el, value) => {
      const input = el as HTMLInputElement;
      const native = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      native?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, PINK);
    await expect(
      settings.getByRole("button", { name: "Remove colour" }),
    ).toBeVisible();
    await settings.getByRole("button", { name: "Save" }).click();
    await expect(settings.getByRole("button", { name: "Save" })).toBeEnabled();
    await hoist.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await shot(settings, "02-roles-staff-hoist-colour.png");
    await closeDialog(owner.page);

    const { roles } = await api<{
      roles: { id: string; name: string; hoist: boolean; color: string | null }[];
    }>(shared.owner.suffix, "GET", `/api/servers/${shared.serverId}/roles`);
    const staffRole = roles.find((role) => role.name === "Staff");
    expect(staffRole).toBeTruthy();
    expect(staffRole!.hoist).toBe(true);
    expect(staffRole!.color?.toLowerCase()).toBe(PINK);

    await api(
      shared.owner.suffix,
      "PUT",
      `/api/servers/${shared.serverId}/members/${shared.staff.id}/roles/${staffRole!.id}`,
    );

    const staffSection = owner.page.locator(
      `[data-member-section="role:${staffRole!.id}"]`,
    );
    await expect(staffSection).toBeVisible({ timeout: 20_000 });
    await expect(staffSection).toContainText(shared.staff.displayName);
    await expect(
      staffSection.getByText(shared.staff.displayName),
    ).toHaveCSS("color", PINK_RGB);
    await shot(owner.page, "03-member-list-staff-hoist.png");

    // --- Overwrite editor on a public channel ---
    await owner.page.getByRole("button", { name: "Permissions" }).click();
    const perms = owner.page.getByRole("dialog");
    await expect(perms.getByRole("heading", { name: "Permissions" })).toBeVisible();
    await expect(perms.getByRole("button", { name: "@everyone" })).toBeVisible();

    const viewRow = permRow(perms, "View channel");
    await expect(viewRow.getByRole("button", { name: "Inherit" })).toBeDisabled();
    await expect(viewRow.getByRole("button", { name: "Inherit" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(perms.getByText(/private setting to control who sees it/)).toBeVisible();
    await shot(perms, "04-overwrites-everyone-view-locked.png");

    const sendRow = permRow(perms, "Send messages");
    await sendRow.getByRole("button", { name: "Deny" }).click();
    await expect(sendRow.getByRole("button", { name: "Deny" })).toHaveAttribute(
      "aria-pressed",
      "true",
      { timeout: 10_000 },
    );
    await shot(perms, "05-everyone-deny-send.png");

    await perms.getByLabel("Add a role").selectOption({ label: "Staff" });
    await perms.getByRole("button", { name: "Staff", exact: true }).click();
    const staffSend = permRow(perms, "Send messages");
    await staffSend.getByRole("button", { name: "Allow" }).click();
    await expect(staffSend.getByRole("button", { name: "Allow" })).toHaveAttribute(
      "aria-pressed",
      "true",
      { timeout: 10_000 },
    );
    await shot(perms, "06-staff-allow-send.png");
    await closeDialog(owner.page);

    await expect
      .poll(async () => {
        const value = await bitsFor(
          shared.muted.suffix,
          shared.serverId,
          shared.announcementsId,
        );
        return (value & SEND) === 0n && (value & VIEW) === VIEW;
      })
      .toBe(true);
    await expect
      .poll(async () => {
        const value = await bitsFor(
          shared.staff.suffix,
          shared.serverId,
          shared.announcementsId,
        );
        return (value & SEND) === SEND;
      })
      .toBe(true);

    const staffBody = `staff-can-post-${Date.now()}`;
    const mutedBody = `muted-blocked-${Date.now()}`;
    await send(staff.page, staffBody);
    await expect(owner.page.getByText(staffBody, { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    const staffArticle = owner.page
      .locator("article")
      .filter({ hasText: staffBody });
    await expect(staffArticle.getByText(shared.staff.displayName)).toHaveCSS(
      "color",
      PINK_RGB,
    );
    await send(muted.page, mutedBody);
    await expect(muted.page.getByText(mutedBody, { exact: true })).toBeVisible();
    await expect(owner.page.getByText(mutedBody, { exact: true })).toHaveCount(0);
    await expect(staff.page.getByText(mutedBody, { exact: true })).toHaveCount(0);
    await shot(muted.page, "07b-muted-cannot-post.png");
    await shot(owner.page, "07-announcements-staff-coloured-name.png");

    // --- Private allowlist ---
    await channelBtn(owner.page, "private-den").click();
    await expect(owner.page.getByRole("button", { name: "Access" })).toBeVisible();
    await owner.page.getByRole("button", { name: "Access" }).click();
    const access = owner.page.getByRole("dialog");
    await expect(access.getByRole("heading", { name: "Permissions" })).toBeVisible();
    const privateView = permRow(access, "View channel");
    await expect(privateView.getByRole("button", { name: "Deny" })).toBeDisabled();
    await expect(privateView.getByRole("button", { name: "Deny" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await shot(access, "08-private-everyone-view-denied.png");
    await access
      .getByRole("button", {
        name: `Give ${shared.muted.displayName} access to this channel`,
      })
      .click();
    await expect(
      access.getByRole("button", {
        name: `Remove ${shared.muted.displayName} from this channel`,
      }),
    ).toBeVisible({ timeout: 10_000 });
    await shot(access, "09-private-allowlist-added.png");
    await closeDialog(owner.page);

    await expect(channelBtn(muted.page, "private-den")).toBeVisible({
      timeout: 20_000,
    });
    await shot(muted.page, "10-muted-gained-private-channel.png");

    // --- VIEW deny evicts a live viewer ---
    await channelBtn(muted.page, "staff-room").click();
    await expect(muted.page.getByPlaceholder(/^Message /)).toBeVisible();
    await shot(muted.page, "11-muted-in-staff-room.png");

    await channelBtn(owner.page, "staff-room").click();
    await owner.page.getByRole("button", { name: "Permissions" }).click();
    const viewPerms = owner.page.getByRole("dialog");
    await viewPerms.getByLabel("Add a member").selectOption({
      label: shared.muted.displayName,
    });
    await viewPerms.getByRole("button", { name: shared.muted.displayName }).click();
    const memberView = permRow(viewPerms, "View channel");
    await memberView.getByRole("button", { name: "Deny" }).click();
    await expect(memberView.getByRole("button", { name: "Deny" })).toHaveAttribute(
      "aria-pressed",
      "true",
      { timeout: 10_000 },
    );
    await shot(viewPerms, "12-member-deny-view.png");
    await closeDialog(owner.page);

    await expect(channelBtn(muted.page, "staff-room")).toHaveCount(0, {
      timeout: 20_000,
    });
    await expect(channelBtn(muted.page, "announcements")).toBeVisible();
    await shot(muted.page, "13-muted-evicted-from-staff-room.png");
    await shot(owner.page, "14-owner-after-eviction.png");
  } finally {
    const videos = [
      { page: owner.page, context: owner.context, name: "walkthrough-owner.webm" },
      { page: staff.page, context: staff.context, name: "walkthrough-staff.webm" },
      { page: muted.page, context: muted.context, name: "walkthrough-muted.webm" },
    ];
    for (const item of videos) {
      const video = item.page.video();
      await item.context.close();
      if (video) {
        await video.saveAs(path.join(OUT, item.name));
      }
    }
    for (const name of fs.readdirSync(OUT)) {
      if (name.startsWith("page@") && name.endsWith(".webm")) {
        fs.unlinkSync(path.join(OUT, name));
      }
    }
  }
});
