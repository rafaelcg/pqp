import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Reaching the ladder from where a moderator actually clicks.
 *
 * The report that started this: the owner of a 1790-member community said the
 * profile card offered Add friend / Message / Call / Mention / More, and More
 * held only Block and Report. The tools existed, behind a right-click, a
 * "Manage members…" item, a second list and another menu.
 *
 * These specs pin the two surfaces a person actually uses, in a COMMUNITY
 * (`is_community`), because that is the shape the report came from and nothing
 * in the client had ever been driven with that flag on:
 *
 *  1. the profile card opened from a name in the transcript, and
 *  2. the member row's own context menu in the sidebar.
 *
 * Both are asserted positively (a staff account sees the rungs and one of them
 * actually lands on the server) and negatively (a plain member sees none of
 * them, while Report, the only way a plain member reaches a moderator, is
 * still there, so the negative cannot pass by the whole menu being empty).
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

test.setTimeout(120_000);

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

interface Seeded {
  serverId: string;
  channelId: string;
  owner: Account;
  members: Account[];
}

/**
 * One COMMUNITY: `ownerSuffix` owns it, every `memberSuffix` joins as a member.
 *
 * The `is_community` flip is the point of the fixture. A community is only a
 * `servers` row with the flag set, so a spec that skipped it would prove
 * nothing about the surface the report came from.
 */
async function seedCommunity(
  ownerSuffix: string,
  memberSuffixes: string[],
): Promise<Seeded> {
  const owner = await materialiseAccount(ownerSuffix);
  const members: Account[] = [];

  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(ownerSuffix),
    body: JSON.stringify({ name: `Reach ${Date.now()}` }),
  });
  const { server } = (await created.json()) as { server: { id: string } };

  const listed = await fetch(`${API}/api/servers/${server.id}/community`, {
    method: "PATCH",
    headers: headersFor(ownerSuffix),
    body: JSON.stringify({ isCommunity: true }),
  });
  if (!listed.ok) {
    throw new Error(`could not list the community: ${listed.status}`);
  }

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

  for (const suffix of memberSuffixes) {
    members.push(await materialiseAccount(suffix));
    const joined = await fetch(`${API}/api/invites/${invite.code}/join`, {
      method: "POST",
      headers: headersFor(suffix),
    });
    if (!joined.ok) {
      throw new Error(`${suffix} could not join: ${joined.status}`);
    }
  }

  return { serverId: server.id, channelId: channel.id, owner, members };
}

async function openAs(page: Page, path: string, suffix: string): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(path);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({
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

/** Type and send, the only way a message gets created. */
async function say(page: Page, body: string): Promise<void> {
  const composer = page.getByPlaceholder(/^Message /);
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await composer.click();
  await composer.fill(body);
  await composer.press("Enter");
  await expect(page.getByText(body, { exact: true }).last()).toBeVisible();
}

/** The roster column, opened from the header toggle if it is not already up. */
async function memberRow(page: Page, userId: string) {
  const roster = page.locator("[data-member-sidebar]");
  if (!(await roster.isVisible().catch(() => false))) {
    await page.locator("[data-member-sidebar-toggle]").first().click();
  }
  await expect(roster).toBeVisible({ timeout: 20_000 });
  const row = roster.locator(`[data-member-sidebar-trigger="${userId}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  return row;
}

test("an owner sees the ladder on a community member's card, from the transcript", async ({
  page,
  browser,
}) => {
  const seeded = await seedCommunity("reachown", ["reachmem"]);
  const member = seeded.members[0]!;
  const channelPath = `/app/server/${seeded.serverId}/channel/${seeded.channelId}`;
  const second = await secondClient(browser);

  try {
    await openAs(second.page, channelPath, "reachmem");
    const body = `community-offence-${Date.now()}`;
    await say(second.page, body);

    await openAs(page, channelPath, "reachown");
    await expect(page.getByText(body, { exact: true }).last()).toBeVisible({
      timeout: 20_000,
    });

    await page.locator(`[data-author-trigger="${member.id}"]`).last().click();
    const card = page.locator("[data-profile-card]");
    await expect(card).toBeVisible();

    // On the card itself, under a heading, not hidden behind the ellipsis
    // whose other entries are all friendly.
    await expect(card.getByText("This community")).toBeVisible();
    await expect(card.locator('[data-profile-mod="timeout"]')).toBeVisible();
    await expect(card.locator('[data-profile-mod="kick"]')).toBeVisible();
    await expect(card.locator('[data-profile-mod="ban"]')).toBeVisible();
  } finally {
    await second.context.close();
  }
});

test("an owner times a community member out from the member list, without a second list", async ({
  page,
}) => {
  const seeded = await seedCommunity("reachown2", ["reachmem2"]);
  const member = seeded.members[0]!;
  const channelPath = `/app/server/${seeded.serverId}/channel/${seeded.channelId}`;

  await openAs(page, channelPath, "reachown2");
  const row = await memberRow(page, member.id);

  await row.click({ button: "right" });
  const menu = page.locator("[data-context-menu]");
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-menu-item="mod-kick"]')).toBeVisible();
  await expect(menu.locator('[data-menu-item="mod-ban"]')).toBeVisible();
  await menu.locator('[data-menu-item="mod-timeout"]').click();

  // The same composer the card uses: a duration has to be chosen, and choosing
  // it is the confirmation.
  const composer = page.locator("[data-member-timeout-composer]");
  await expect(composer).toBeVisible();
  await composer.locator('[data-timeout-minutes="5"]').click();
  await composer.getByLabel("Reason").fill("Reading the room");
  await page.locator("[data-member-timeout-apply]").click();

  await expect(composer).toBeHidden({ timeout: 20_000 });

  // The server agrees, with the reason attached.
  const listed = await fetch(`${API}/api/servers/${seeded.serverId}/timeouts`, {
    headers: headersFor("reachown2"),
  });
  const { timeouts } = (await listed.json()) as {
    timeouts: { userId: string; reason: string | null }[];
  };
  expect(timeouts.map((one) => one.userId)).toContain(member.id);
  expect(timeouts.find((one) => one.userId === member.id)?.reason).toBe(
    "Reading the room",
  );

  // And the menu now offers ENDING it rather than a second sentence.
  await row.click({ button: "right" });
  await expect(
    page.locator('[data-context-menu] [data-menu-item="mod-endTimeout"]'),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.locator('[data-context-menu] [data-menu-item="mod-timeout"]'),
  ).toHaveCount(0);
});

test("a plain member is offered no moderation in the member list menu", async ({
  page,
}) => {
  // TWO members, so the negative is about RANK and not about the target
  // happening to be the owner. That would pass for the wrong reason and keep
  // passing if the staff check were deleted.
  const seeded = await seedCommunity("reachown3", ["reachmem3", "reachmem4"]);
  const peer = seeded.members[1]!;
  const channelPath = `/app/server/${seeded.serverId}/channel/${seeded.channelId}`;

  await openAs(page, channelPath, "reachmem3");
  const row = await memberRow(page, peer.id);
  await row.click({ button: "right" });

  const menu = page.locator("[data-context-menu]");
  await expect(menu).toBeVisible();
  // Report survives: it is how a plain member reaches a moderator at all, and
  // asserting it is what stops this test passing on an empty menu.
  await expect(menu.getByText("Report", { exact: true })).toBeVisible();
  await expect(menu.locator("[data-menu-item^='mod-']")).toHaveCount(0);
  await expect(menu.getByText("Manage members…")).toHaveCount(0);
});

test("the owner can still ban somebody who has left the community", async ({
  page,
  browser,
}) => {
  // THE BUG THIS FILE WAS OPENED FOR, in its purest form. The rungs are drawn
  // from the rank the shell's roster carries, and somebody who left is not in
  // it, so the card offered Block and Report and nothing else, on the one
  // person a moderator most wants to close the door on.
  const seeded = await seedCommunity("reachown4", ["reachmem5"]);
  const member = seeded.members[0]!;
  const channelPath = `/app/server/${seeded.serverId}/channel/${seeded.channelId}`;
  const second = await secondClient(browser);

  try {
    await openAs(second.page, channelPath, "reachmem5");
    await say(second.page, `parting-shot-${Date.now()}`);
  } finally {
    await second.context.close();
  }

  const left = await fetch(`${API}/api/servers/${seeded.serverId}/leave`, {
    method: "POST",
    headers: headersFor("reachmem5"),
  });
  expect(left.ok).toBe(true);

  await openAs(page, channelPath, "reachown4");
  const trigger = page.locator(`[data-author-trigger="${member.id}"]`).last();
  await expect(trigger).toBeVisible({ timeout: 20_000 });
  await trigger.click();

  const card = page.locator("[data-profile-card]");
  await expect(card).toBeVisible();
  await expect(card.locator('[data-profile-mod="ban"]')).toBeVisible();
  // A kick and a timeout genuinely need a membership, so they stay off: they
  // would 404 on somebody who has gone.
  await expect(card.locator('[data-profile-mod="kick"]')).toHaveCount(0);
  await expect(card.locator('[data-profile-mod="timeout"]')).toHaveCount(0);

  await card.locator('[data-profile-mod="ban"]').click();
  const confirm = card.locator('[data-profile-mod-confirm="ban"]');
  await expect(confirm).toBeVisible();
  await confirm.getByLabel("Reason").fill("Left after the fact");
  await confirm.getByRole("button", { name: "Ban from community" }).click();

  await expect(async () => {
    const listed = await fetch(`${API}/api/servers/${seeded.serverId}/bans`, {
      headers: headersFor("reachown4"),
    });
    const { bans } = (await listed.json()) as {
      bans: { userId: string; reason: string | null }[];
    };
    expect(bans.map((one) => one.userId)).toContain(member.id);
    expect(bans.find((one) => one.userId === member.id)?.reason).toBe(
      "Left after the fact",
    );
  }).toPass({ timeout: 20_000 });
});
