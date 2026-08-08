import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * The member sidebar: the roster that is simply there.
 *
 * The bug this covers is not "the panel is broken" — it is "we have no user
 * list", reported by somebody who had a working modal members panel the whole
 * time and never found it. So these tests are about the list being VISIBLE
 * without being asked for, staying hidden once it has been dismissed, and
 * telling the truth about who is around while you watch it.
 *
 * Two dev-bypass accounts via the `pqp:dev-user-suffix` hook in
 * `lib/dev-auth.ts`, the same mechanism `profile-popover-friends.spec.ts` uses:
 * a second REAL client is the only way to make somebody come online, because
 * status is resolved from live sockets and cannot be faked over HTTP.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

// Two full app boots, plus a poll interval to wait out in the live test.
test.setTimeout(120_000);

/**
 * Pinned, because the `Desktop Chrome` device in `playwright.config.ts` is
 * applied *after* the file's own `use` block there and overrides its 1440 with
 * 1280 — and these tests measure where the column lands. The one test about the
 * narrow case builds its own 1000px context explicitly.
 */
test.use({ viewport: { width: 1440, height: 900 } });

function headersFor(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

interface Account {
  id: string;
  displayName: string;
}

async function materialiseAccount(suffix: string): Promise<Account> {
  const headers = headersFor(suffix);
  const me = await fetch(`${API}/api/me`, { headers });
  const body = (await me.json()) as {
    id: string;
    displayName: string;
    ageGate?: string;
  };
  if (body.ageGate && body.ageGate !== "passed") {
    await fetch(`${API}/api/me/age-check`, {
      method: "POST",
      headers,
      body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
    });
  }
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ onboardedAt: new Date().toISOString() }),
  });
  return { id: body.id, displayName: body.displayName };
}

interface Shared {
  serverId: string;
  channelId: string;
  owner: Account;
  guest: Account;
}

/** A server the first account owns and the second one has joined. */
async function seedServer(
  ownerSuffix: string,
  guestSuffix: string,
): Promise<Shared> {
  const owner = await materialiseAccount(ownerSuffix);
  const guest = await materialiseAccount(guestSuffix);

  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(ownerSuffix),
    body: JSON.stringify({ name: `Roster ${Date.now()}` }),
  });
  const { server } = (await created.json()) as { server: { id: string } };

  const channelsRes = await fetch(`${API}/api/servers/${server.id}/channels`, {
    headers: headersFor(ownerSuffix),
  });
  const { channels } = (await channelsRes.json()) as {
    channels: { id: string; type: string }[];
  };
  const channel = channels.find((one) => one.type === "text")!;

  const inviteRes = await fetch(`${API}/api/servers/${server.id}/invites`, {
    method: "POST",
    headers: headersFor(ownerSuffix),
    body: JSON.stringify({}),
  });
  const { invite } = (await inviteRes.json()) as { invite: { code: string } };
  const joined = await fetch(`${API}/api/invites/${invite.code}/join`, {
    method: "POST",
    headers: headersFor(guestSuffix),
  });
  if (!joined.ok) {
    throw new Error(`the guest could not join: ${joined.status}`);
  }

  return { serverId: server.id, channelId: channel.id, owner, guest };
}

async function openAs(page: Page, path: string, suffix: string): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(path);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByPlaceholder(/^Message /)).toBeVisible({
    timeout: 20_000,
  });
}

async function secondClient(browser: Browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  });
  const page = await context.newPage();
  return { context, page };
}

const sidebar = (page: Page) => page.locator("[data-member-sidebar]");
/**
 * By attribute, not by accessible name. "Member list" is a case-insensitive
 * substring of the panel's own "Hide the member list" close button, so a
 * `getByRole` name lookup would match two elements and trip strict mode — and it
 * would only do so once both are on screen at the same time.
 */
const toggle = (page: Page) => page.locator("[data-member-sidebar-toggle]");
const section = (page: Page, id: string) =>
  page.locator(`[data-member-section="${id}"]`);

test("at 1440 the roster is already open, in sections, with counts", async ({
  page,
}) => {
  const shared = await seedServer("roster-a", "roster-b");
  await openAs(
    page,
    `/app/server/${shared.serverId}/channel/${shared.channelId}`,
    "roster-a",
  );

  // NOT clicked open. Nothing in this test asks for the list; that is the point.
  await expect(sidebar(page)).toBeVisible();

  // The account driving the browser owns the server and is connected, so it is
  // under Owner; the guest has never opened a socket, so it is under Offline.
  await expect(section(page, "role:owner")).toBeVisible({ timeout: 20_000 });
  await expect(section(page, "role:owner")).toContainText("Owner — 1");
  await expect(section(page, "role:owner")).toContainText(
    shared.owner.displayName,
  );
  await expect(section(page, "offline")).toContainText("Offline — 1");
  await expect(section(page, "offline")).toContainText(
    shared.guest.displayName,
  );
  // No heading for a section nobody is in.
  await expect(section(page, "role:admin")).toHaveCount(0);
  await expect(section(page, "online")).toHaveCount(0);

  // It is a column, not an overlay: the transcript ends where the roster begins.
  const box = (await sidebar(page).boundingBox())!;
  expect(box.x + box.width).toBeGreaterThan(1400);
  const composer = (await page.getByPlaceholder(/^Message /).boundingBox())!;
  expect(composer.x + composer.width).toBeLessThanOrEqual(box.x + 1);

  await page.screenshot({ path: "/tmp/memberlist-1440.png", fullPage: false });
});

test("the header toggle hides it, and it stays hidden across a reload", async ({
  page,
}) => {
  const shared = await seedServer("roster-c", "roster-d");
  const path = `/app/server/${shared.serverId}/channel/${shared.channelId}`;
  await openAs(page, path, "roster-c");

  await expect(sidebar(page)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(toggle(page)).toHaveAccessibleName("Member list");
  await toggle(page).click();
  await expect(sidebar(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");

  // The whole point of persisting it: a hidden sidebar stays hidden.
  await page.reload();
  await expect(page.getByPlaceholder(/^Message /)).toBeVisible({
    timeout: 20_000,
  });
  await expect(sidebar(page)).toHaveCount(0);

  // And back on, still persisted.
  await toggle(page).click();
  await expect(sidebar(page)).toBeVisible();
  await page.reload();
  await expect(page.getByPlaceholder(/^Message /)).toBeVisible({
    timeout: 20_000,
  });
  await expect(sidebar(page)).toBeVisible();
});

test("below the column breakpoint it starts closed and opens as a drawer", async ({
  browser,
}) => {
  const shared = await seedServer("roster-e", "roster-f");
  const context = await browser.newContext({
    viewport: { width: 1000, height: 800 },
    colorScheme: "dark",
  });
  const page = await context.newPage();

  try {
    await openAs(
      page,
      `/app/server/${shared.serverId}/channel/${shared.channelId}`,
      "roster-e",
    );

    // 1000px has no room for a third column, so the default is off — but the
    // toggle is still there, which is the difference between "narrow" and "gone".
    await expect(sidebar(page)).toHaveCount(0);
    await expect(toggle(page)).toBeVisible();
    await toggle(page).click();

    await expect(sidebar(page)).toBeVisible();
    await expect(section(page, "role:owner")).toContainText("Owner — 1");
    // A drawer, not a column: it sits over the transcript rather than pushing
    // it, so the composer still runs under it.
    const box = (await sidebar(page).boundingBox())!;
    const composer = (await page.getByPlaceholder(/^Message /).boundingBox())!;
    expect(box.x + box.width).toBeGreaterThan(990);
    expect(composer.x + composer.width).toBeGreaterThan(box.x);

    await page.screenshot({ path: "/tmp/memberlist-1000.png" });

    // Escape closes a drawer, the way every transient panel in the app does.
    await page.keyboard.press("Escape");
    await expect(sidebar(page)).toHaveCount(0);

    // …and so does tapping outside it, the way the mobile channel list does.
    await toggle(page).click();
    await expect(sidebar(page)).toBeVisible();
    await page.mouse.click(200, 400);
    await expect(sidebar(page)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("a second account coming online moves out of Offline while you watch", async ({
  page,
  browser,
}) => {
  const shared = await seedServer("roster-g", "roster-h");
  const path = `/app/server/${shared.serverId}/channel/${shared.channelId}`;
  const second = await secondClient(browser);

  try {
    await openAs(page, path, "roster-g");
    await expect(
      section(page, "offline").getByText(shared.guest.displayName),
    ).toBeVisible({ timeout: 20_000 });

    // The guest opens a real client. Nothing is clicked on the first page.
    await openAs(second.page, path, "roster-h");

    // Status is a pull surface by design; the sidebar's `presence-update` nudge
    // usually lands this in about a second, and the 15s poll is the ceiling.
    await expect(
      section(page, "online").getByText(shared.guest.displayName),
    ).toBeVisible({ timeout: 25_000 });
    await expect(section(page, "online")).toContainText("Online — 1");
    await expect(
      section(page, "offline").getByText(shared.guest.displayName),
    ).toHaveCount(0);

    // …and back again when they leave.
    await second.context.close();
    await expect(
      section(page, "offline").getByText(shared.guest.displayName),
    ).toBeVisible({ timeout: 25_000 });
  } finally {
    if (!second.page.isClosed()) {
      await second.context.close();
    }
  }
});

test("clicking a row opens the same profile card the transcript does", async ({
  page,
}) => {
  const shared = await seedServer("roster-i", "roster-j");
  await openAs(
    page,
    `/app/server/${shared.serverId}/channel/${shared.channelId}`,
    "roster-i",
  );

  const row = page.locator(
    `[data-member-sidebar-trigger="${shared.guest.id}"]`,
  );
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();

  const card = page.locator("[data-profile-card]");
  await expect(card).toBeVisible();
  await expect(card.locator("[data-profile-name]")).toHaveText(
    shared.guest.displayName,
  );
  // The card is the real one, so the errand it exists for is one click away.
  await expect(card.locator('[data-profile-primary="addFriend"]')).toBeVisible();
});

test("a big server starts with Offline folded away and a bounded DOM", async ({
  page,
}) => {
  const shared = await seedServer("roster-big", "roster-big-2");
  const inviteRes = await fetch(
    `${API}/api/servers/${shared.serverId}/invites`,
    {
      method: "POST",
      headers: headersFor("roster-big"),
      // The default invite is capped; a batch join needs the cap lifted.
      body: JSON.stringify({ maxUses: null }),
    },
  );
  const { invite } = (await inviteRes.json()) as { invite: { code: string } };

  // Two requests each and no onboarding stamp: none of these accounts is ever
  // going to open a browser, and only the membership row makes it into the list.
  // The age answer is not skippable — the gate refuses every route but a handful
  // until it is given, `join` included.
  // Past one page (100) on purpose: the point is that expanding mounts a page
  // and a "show more", not a hundred and eleven rows.
  const CROWD = 110;
  for (let i = 0; i < CROWD; i++) {
    const suffix = `crowd-${i}`;
    await fetch(`${API}/api/me/age-check`, {
      method: "POST",
      headers: headersFor(suffix),
      body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
    });
    const joined = await fetch(`${API}/api/invites/${invite.code}/join`, {
      method: "POST",
      headers: headersFor(suffix),
    });
    if (!joined.ok) {
      throw new Error(`crowd-${i} could not join: ${joined.status}`);
    }
  }

  await openAs(
    page,
    `/app/server/${shared.serverId}/channel/${shared.channelId}`,
    "roster-big",
  );

  const offline = section(page, "offline");
  // The crowd plus the guest, none of them connected.
  await expect(offline).toContainText(`Offline — ${CROWD + 1}`, {
    timeout: 20_000,
  });
  // Folded: the heading is there, the hundred and eleven rows are not. This is
  // the whole reason the threshold exists — the alternative is a scrollbar whose
  // entire travel is people who are not here.
  const rows = offline.locator("[data-member-sidebar-trigger]");
  await expect(rows).toHaveCount(0);
  await expect(offline.getByRole("button", { expanded: false })).toBeVisible();

  // Opening it mounts ONE page, not all of them.
  await offline.getByRole("button", { expanded: false }).click();
  await expect(rows).toHaveCount(100);
  const more = offline.getByRole("button", {
    name: `Show ${CROWD + 1 - 100} more`,
  });
  await expect(more).toBeVisible();
  await more.click();
  await expect(rows).toHaveCount(CROWD + 1);
  await expect(more).toHaveCount(0);
});

test("a group conversation gets a participant list; a 1:1 gets nothing", async ({
  page,
}) => {
  // Three accounts in one server, so both conversations are allowed to exist
  // (DM privacy is `server_members` by default).
  const shared = await seedServer("roster-m", "roster-n");
  const third = await materialiseAccount("roster-o");
  const inviteRes = await fetch(
    `${API}/api/servers/${shared.serverId}/invites`,
    {
      method: "POST",
      headers: headersFor("roster-m"),
      body: JSON.stringify({}),
    },
  );
  const { invite } = (await inviteRes.json()) as { invite: { code: string } };
  await fetch(`${API}/api/invites/${invite.code}/join`, {
    method: "POST",
    headers: headersFor("roster-o"),
  });

  const direct = await fetch(`${API}/api/dms`, {
    method: "POST",
    headers: headersFor("roster-m"),
    body: JSON.stringify({ userIds: [shared.guest.id] }),
  });
  const { conversation: one } = (await direct.json()) as {
    conversation: { channelId: string };
  };
  const group = await fetch(`${API}/api/dms`, {
    method: "POST",
    headers: headersFor("roster-m"),
    body: JSON.stringify({ userIds: [shared.guest.id, third.id] }),
  });
  const { conversation: many } = (await group.json()) as {
    conversation: { channelId: string };
  };

  // A 1:1's member list would be one row naming the person in the title.
  await openAs(page, `/app/dm/${one.channelId}`, "roster-m");
  await expect(sidebar(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveCount(0);

  // A group's is the thing a group chat actually lacks.
  await page.goto(`/app/dm/${many.channelId}`);
  await expect(page.getByPlaceholder(/^Message /)).toBeVisible({
    timeout: 20_000,
  });
  await expect(sidebar(page)).toBeVisible();
  // Three, counting the reader — `participants` excludes them on the wire.
  await expect(section(page, "all")).toContainText("Participants — 3");
  await expect(section(page, "all")).toContainText(third.displayName);
});

test("right-click offers the light actions and a door to the panel, not a second ban button", async ({
  page,
}) => {
  const shared = await seedServer("roster-k", "roster-l");
  await openAs(
    page,
    `/app/server/${shared.serverId}/channel/${shared.channelId}`,
    "roster-k",
  );

  const row = page.locator(
    `[data-member-sidebar-trigger="${shared.guest.id}"]`,
  );
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click({ button: "right" });

  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Block" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Report" })).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Manage members" }),
  ).toBeVisible();
  // The enforcement ladder lives in one place. If these ever appear here, two
  // copies of it exist.
  await expect(
    menu.getByRole("menuitem", { name: "Ban from server" }),
  ).toHaveCount(0);
  await expect(
    menu.getByRole("menuitem", { name: "Time out" }),
  ).toHaveCount(0);
});
