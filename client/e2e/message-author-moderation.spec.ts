import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Moderating the person who just said the thing, from where they said it.
 *
 * Every moderation action lived on the members panel: a moderator reading a
 * message that needed acting on had to open the roster, find the person in it,
 * and act at a distance from the thing they were reacting to. The author's name
 * is right there in the transcript and already opens a profile card, so the card
 * is where the ladder belongs — behind the same ellipsis Block and Report ride
 * in, because a punitive button the size of "Add friend" makes a profile read as
 * a charge sheet.
 *
 * Two halves, and the reason they are e2e rather than unit tests: the rank rule
 * is proved as pure logic in `packages/shared/src/friends.test.ts` and
 * `profile-relations.test.ts`, and what only a browser can prove is that the
 * wiring hands the right role to the right card — that an owner's card is built
 * from the owner's role and a member's from the member's.
 *
 * Two dev-bypass accounts via the `pqp:dev-user-suffix` localStorage hook in
 * `lib/dev-auth.ts`, the same mechanism `profile-popover-friends.spec.ts` uses.
 * Messages are typed in a real browser because there is no HTTP route that
 * creates one — sending is a WebSocket frame.
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

/** One server: `ownerSuffix` owns it, every `memberSuffix` joins as a member. */
async function seedServer(
  ownerSuffix: string,
  memberSuffixes: string[],
): Promise<Seeded> {
  const owner = await materialiseAccount(ownerSuffix);
  const members: Account[] = [];

  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(ownerSuffix),
    body: JSON.stringify({ name: `Mod ${Date.now()}` }),
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

test("the owner times a member out from the member's own message", async ({
  page,
  browser,
}) => {
  const seeded = await seedServer("modown", ["modmem"]);
  const member = seeded.members[0]!;
  const channelPath = `/app/server/${seeded.serverId}/channel/${seeded.channelId}`;
  const second = await secondClient(browser);

  try {
    // --- the member says something the owner has to react to -------------
    await openAs(second.page, channelPath, "modmem");
    const body = `offence-${Date.now()}`;
    await say(second.page, body);

    await openAs(page, channelPath, "modown");
    await expect(page.getByText(body, { exact: true }).last()).toBeVisible({
      timeout: 20_000,
    });

    // --- the whole errand, from the name in the transcript ---------------
    const trigger = page.locator(`[data-author-trigger="${member.id}"]`).last();
    await expect(trigger).toBeVisible();
    await trigger.click();
    const card = page.locator("[data-profile-card]");
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "More" }).click();

    // The ladder, reversible rung first: the order IS the ladder.
    await expect(card.locator('[data-profile-mod="timeout"]')).toBeVisible();
    await expect(card.locator('[data-profile-mod="kick"]')).toBeVisible();
    await expect(card.locator('[data-profile-mod="ban"]')).toBeVisible();

    await card.locator('[data-profile-mod="timeout"]').click();

    // The composer, not a second "are you sure": a duration has to be chosen,
    // so choosing it is the confirmation.
    const composer = card.locator("[data-profile-timeout-composer]");
    await expect(composer).toBeVisible();
    await composer.locator('[data-timeout-minutes="5"]').click();
    await composer.getByLabel("Reason").fill("Reading the room");
    await card.locator("[data-profile-timeout-apply]").click();

    // The server writes the sentence — when it ends, and what it takes away —
    // and it is the SAME string the sanctioned person is shown. Rendering it
    // verbatim is how the two sides cannot disagree about what was done.
    await expect(
      card.getByText(/You are timed out in this server until/),
    ).toBeVisible({ timeout: 20_000 });

    // And the API agrees, with the reason attached — the field the members panel
    // drops on the floor and this surface does not.
    const listed = await fetch(
      `${API}/api/servers/${seeded.serverId}/timeouts`,
      { headers: headersFor("modown") },
    );
    const { timeouts } = (await listed.json()) as {
      timeouts: { userId: string; reason: string | null }[];
    };
    expect(timeouts.map((one) => one.userId)).toContain(member.id);
    expect(timeouts.find((one) => one.userId === member.id)?.reason).toBe(
      "Reading the room",
    );

    // Reopening offers ENDING it rather than issuing a second one: two rows that
    // both said "timeout" is how somebody gets double-sanctioned by accident.
    await page.keyboard.press("Escape");
    await trigger.click();
    await page
      .locator("[data-profile-card]")
      .getByRole("button", { name: "More" })
      .click();
    await expect(
      page.locator('[data-profile-card] [data-profile-mod="endTimeout"]'),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.locator('[data-profile-card] [data-profile-mod="timeout"]'),
    ).toHaveCount(0);
  } finally {
    await second.context.close();
  }
});

test("a plain member is offered no moderation on another member's card", async ({
  page,
  browser,
}) => {
  // TWO members, so the negative is about RANK — "I am not a manager" — and not
  // about the target happening to be the owner, which would pass for the wrong
  // reason and keep passing if the manager check were deleted.
  const seeded = await seedServer("modown2", ["modmem2", "modmem3"]);
  const author = seeded.members[1]!;
  const channelPath = `/app/server/${seeded.serverId}/channel/${seeded.channelId}`;
  const second = await secondClient(browser);

  try {
    await openAs(second.page, channelPath, "modmem3");
    const body = `peer-${Date.now()}`;
    await say(second.page, body);

    await openAs(page, channelPath, "modmem2");
    await expect(page.getByText(body, { exact: true }).last()).toBeVisible({
      timeout: 20_000,
    });
    await page.locator(`[data-author-trigger="${author.id}"]`).last().click();

    const card = page.locator("[data-profile-card]");
    await expect(card).toBeVisible();
    // The menu still exists, and still has Report on it — Report is how a plain
    // member reaches the moderators at all, so it must not have been swept up.
    await card.getByRole("button", { name: "More" }).click();
    await expect(card.getByRole("menuitem", { name: "Report" })).toBeVisible();
    // But no rung of the ladder is on it.
    await expect(card.locator("[data-profile-mod]")).toHaveCount(0);
  } finally {
    await second.context.close();
  }
});
