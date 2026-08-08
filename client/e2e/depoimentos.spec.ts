import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Depoimentos, driven end to end with two real clients.
 *
 * The three things proved here are the three the feature would be worthless
 * without, and each is a whole-stack claim that no unit test can make:
 *
 *  1. THE LOOP. A befriends B, writes a depoimento from B's profile card, B's
 *     front door lights up on its own, B publishes it from the queue, and it
 *     then renders on B's profile card for A — the "trophy" §05 is about.
 *  2. THE DM FORK ACTUALLY OPENS THE DM, carrying what was typed. This is the
 *     "Não aceita!" mitigation, and a fork that only looks like a button is not
 *     a mitigation: if the private-message use has no working home, users go on
 *     making one out of the pending queue.
 *  3. THE BADGE OPT-OUT HIDES A COMMUNITY, from the community's own menu.
 *
 * Two dev-bypass accounts via the `pqp:dev-user-suffix` localStorage hook in
 * `lib/dev-auth.ts` — the same mechanism `profile-popover-friends.spec.ts` uses.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

// Two full app boots, a friendship, a socket round trip and a publish.
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
    body: JSON.stringify({
      onboardedAt: new Date().toISOString(),
      // B opens `/app/dm` to work the queue, and a fresh account with no
      // friends and no avatar would draw the first-run checklist above it.
      firstRunDismissedAt: new Date().toISOString(),
    }),
  });
  return { id: body.id, displayName: body.displayName };
}

interface Shared {
  serverId: string;
  channelId: string;
  a: Account;
  b: Account;
}

/**
 * A server both accounts are in, plus the friendship — depoimentos are
 * friends-only, so the handshake is setup here rather than something under
 * test (`profile-popover-friends.spec.ts` already proves it through the UI).
 */
async function seedFriends(
  aSuffix: string,
  bSuffix: string,
): Promise<Shared> {
  const a = await materialiseAccount(aSuffix);
  const b = await materialiseAccount(bSuffix);

  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(aSuffix),
    body: JSON.stringify({ name: `Dep ${Date.now()}` }),
  });
  const { server } = (await created.json()) as { server: { id: string } };

  const channelsRes = await fetch(`${API}/api/servers/${server.id}/channels`, {
    headers: headersFor(aSuffix),
  });
  const { channels } = (await channelsRes.json()) as {
    channels: { id: string; type: string }[];
  };
  const channel = channels.find((one) => one.type === "text")!;

  const inviteRes = await fetch(`${API}/api/servers/${server.id}/invites`, {
    method: "POST",
    headers: headersFor(aSuffix),
    body: JSON.stringify({}),
  });
  const { invite } = (await inviteRes.json()) as { invite: { code: string } };
  const joined = await fetch(`${API}/api/invites/${invite.code}/join`, {
    method: "POST",
    headers: headersFor(bSuffix),
  });
  if (!joined.ok) {
    throw new Error(`B could not join: ${joined.status}`);
  }

  /**
   * The handshake, idempotently. The suite shares one persistent database and
   * these suffixes are fixed, so a second run finds the two already friends —
   * `POST /api/friends` answers `accepted` for that, and accepting a request
   * that no longer stands is a 404. Reading the state the send reports is what
   * makes the run order-independent.
   */
  const asked = await fetch(`${API}/api/friends`, {
    method: "POST",
    headers: headersFor(aSuffix),
    body: JSON.stringify({ userId: b.id }),
  });
  if (!asked.ok) {
    throw new Error(`A could not ask: ${asked.status}`);
  }
  const { state } = (await asked.json()) as { state: string };
  if (state !== "accepted") {
    const accepted = await fetch(`${API}/api/friends/${a.id}/accept`, {
      method: "POST",
      headers: headersFor(bSuffix),
    });
    if (!accepted.ok) {
      throw new Error(`B could not accept: ${accepted.status}`);
    }
  }

  // Same reason: a depoimento left standing by an earlier run would sit in B's
  // queue and badge B's door before this test has written anything, which is
  // the one thing every assertion here is measured against. Both queues are
  // emptied — refusing is what the subject would do, and it deletes the row.
  await Promise.all(
    [aSuffix, bSuffix].map(async (suffix) => {
      const queue = await fetch(`${API}/api/me/depoimentos/pending`, {
        headers: headersFor(suffix),
      });
      const { depoimentos } = (await queue.json()) as {
        depoimentos: { id: string }[];
      };
      for (const one of depoimentos) {
        await fetch(`${API}/api/depoimentos/${one.id}`, {
          method: "DELETE",
          headers: headersFor(suffix),
        });
      }
    }),
  );
  // And the published ones, which are the subject's to take down.
  await Promise.all(
    [
      { suffix: aSuffix, id: a.id },
      { suffix: bSuffix, id: b.id },
    ].map(async ({ suffix, id }) => {
      const shown = await fetch(`${API}/api/users/${id}/depoimentos`, {
        headers: headersFor(suffix),
      });
      const { depoimentos } = (await shown.json()) as {
        depoimentos: { id: string }[];
      };
      for (const one of depoimentos) {
        await fetch(`${API}/api/depoimentos/${one.id}`, {
          method: "DELETE",
          headers: headersFor(suffix),
        });
      }
    }),
  );

  return { serverId: server.id, channelId: channel.id, a, b };
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

/**
 * Open B's card from the member SIDEBAR, which is already on screen at this
 * viewport — `data-member-sidebar-trigger`, not the modal panel's
 * `data-member-trigger`. Both can be on screen at once, and the sidebar is the
 * one a person actually clicks.
 */
async function openCardForB(page: Page, shared: Shared) {
  const trigger = page.locator(
    `[data-member-sidebar-trigger="${shared.b.id}"]`,
  );
  await expect(trigger).toBeVisible({ timeout: 20_000 });
  await trigger.click();
  const card = page.locator("[data-profile-card]");
  await expect(card).toBeVisible();
  return card;
}

/**
 * Reload and open the card again.
 *
 * A RELOAD rather than a reopen, and deliberately: the card reads the profile
 * ONCE, on mount, and it is keyed by subject — so a card that was already open
 * when the other side published keeps whatever it read the first time. That is
 * correct behaviour (nothing about a profile is pushed) and it is exactly why
 * proving the depoimento landed needs a genuinely fresh client, which is also
 * what the person refreshing to see whether it worked would do.
 */
async function reopenCardForB(
  page: Page,
  shared: Shared,
  path: string,
) {
  await page.goto(path);
  await expect(page.getByPlaceholder(/^Message /)).toBeVisible({
    timeout: 20_000,
  });
  return await openCardForB(page, shared);
}

test("A writes a depoimento, B's door lights up, B publishes it, and it lands on B's profile", async ({
  page,
  browser,
}) => {
  const shared = await seedFriends("dep-a", "dep-b");
  const channelPath = `/app/server/${shared.serverId}/channel/${shared.channelId}`;
  const second = await secondClient(browser);
  const words = `melhor call da minha vida ${Date.now()}`;

  try {
    // --- B sits in a channel and never leaves it until they answer -------
    await openAs(second.page, channelPath, "dep-b");
    await expect(second.page.getByPlaceholder(/^Message /)).toBeVisible({
      timeout: 20_000,
    });
    // Nothing is waiting yet, which is what makes the badge's arrival mean
    // something.
    await expect(second.page.locator("[data-friend-requests]")).toHaveCount(0);

    // --- A writes one from B's profile card ------------------------------
    await openAs(page, channelPath, "dep-a");
    await expect(page.getByPlaceholder(/^Message /)).toBeVisible({
      timeout: 20_000,
    });
    const card = await openCardForB(page, shared);

    // The action exists only because they are friends — see canWriteDepoimento.
    const write = card.locator("[data-depoimento-write]");
    await expect(write).toBeVisible();
    await write.click();

    const composer = card.locator("[data-depoimento-composer]");
    await expect(composer).toBeVisible();
    // THE SENTENCE THAT HAS TO BE THERE. The whole "Não aceita!" mitigation is
    // that the author is told, before sending, that this becomes public — and
    // is offered the private route in the same breath.
    await expect(composer.getByText(/public on their profile/i)).toBeVisible();
    await expect(composer.locator("[data-depoimento-dm]")).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: "/tmp/depo-compose.png" });

    await composer.locator("[data-depoimento-body]").fill(words);
    await composer.locator("[data-depoimento-send]").click();
    await expect(card.getByText(/They decide whether to show it/i)).toBeVisible();

    // --- B's front door lights up on its own, with no reload -------------
    const badge = second.page.locator("[data-friend-requests]").first();
    await expect(badge).toHaveAttribute("data-friend-requests", "1", {
      timeout: 20_000,
    });
    // Still where they were: a nudge must not navigate anybody.
    await expect(second.page.getByPlaceholder(/^Message /)).toBeVisible();

    // --- B works the queue ----------------------------------------------
    await second.page.getByRole("button", { name: "Direct messages" }).click();
    await second.page.getByRole("tab", { name: "Pending" }).click();
    const queued = second.page.locator("[data-depoimentos-pending]");
    await expect(queued).toBeVisible({ timeout: 20_000 });
    // The author is named ABOVE the text, so nobody is ambushed by a paragraph
    // from a name they were not ready to read.
    await expect(queued.getByText(shared.a.displayName).first()).toBeVisible();
    await expect(queued.getByText(words)).toBeVisible();
    await second.page.waitForTimeout(500);
    await second.page.screenshot({ path: "/tmp/depo-queue.png" });

    // Publishing is TWO taps over a preview of what becomes public. §05 calls
    // this the most important UI decision in the feature.
    await queued.locator("[data-depoimento-publish]").first().click();
    const confirm = second.page.locator("[data-depoimento-confirm]");
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText(/Publish this on your profile/i)).toBeVisible();
    await second.page.waitForTimeout(500);
    await second.page.screenshot({ path: "/tmp/depo-confirm.png" });
    await confirm.locator("[data-depoimento-approve]").click();

    // The queue empties and the badge goes with it.
    await expect(second.page.locator("[data-friend-requests]")).toHaveCount(0, {
      timeout: 20_000,
    });

    // --- and it is on B's profile, for A --------------------------------
    const reopened = await reopenCardForB(page, shared, channelPath);
    const profile = reopened.locator("[data-depoimentos]");
    await expect(profile).toBeVisible();
    await expect(profile.getByText(words)).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: "/tmp/depo-profile.png" });
  } finally {
    await second.context.close();
  }
});

/**
 * The fork, driven for real.
 *
 * §02 is the whole argument: because Orkut's pending queue was a private
 * message with a publish button on it, people wrote confessions into it. The
 * only defence that works is giving that use a real, working door — so this
 * asserts that the door opens AND that it carries what was already typed. A
 * fork that made you retype would be a fork nobody takes.
 */
test("the DM fork opens the conversation carrying what was typed", async ({
  page,
}) => {
  const shared = await seedFriends("dep-c", "dep-d");
  const channelPath = `/app/server/${shared.serverId}/channel/${shared.channelId}`;
  const secret = `nao aceita ${Date.now()}`;

  await openAs(page, channelPath, "dep-c");
  await expect(page.getByPlaceholder(/^Message /)).toBeVisible({
    timeout: 20_000,
  });

  const card = await openCardForB(page, shared);
  await card.locator("[data-depoimento-write]").click();
  const composer = card.locator("[data-depoimento-composer]");
  await composer.locator("[data-depoimento-body]").fill(secret);
  await composer.locator("[data-depoimento-dm]").click();

  // The card closed and the conversation with B is what is on screen now.
  await expect(page.locator("[data-profile-card]")).toHaveCount(0);
  const dmComposer = page.getByPlaceholder(new RegExp(`^Message `));
  await expect(dmComposer).toBeVisible({ timeout: 20_000 });
  await expect(dmComposer).toHaveValue(new RegExp(secret), {
    timeout: 10_000,
  });
  await page.waitForTimeout(500);
    await page.screenshot({ path: "/tmp/depo-dm-fork.png" });

  // NOTHING WAS WRITTEN as a depoimento — the fork is a fork, not a copy.
  const queue = await fetch(`${API}/api/me/depoimentos/pending`, {
    headers: headersFor("dep-d"),
  });
  const { depoimentos } = (await queue.json()) as { depoimentos: unknown[] };
  expect(depoimentos).toHaveLength(0);
});

/**
 * The community chips, and the switch that turns one off.
 *
 * The badge is on by default because a listed community is already public —
 * its directory card already counts this member. The opt-out is per membership
 * because "public" and "advertised on my profile" are different consents, and
 * the cases that matter are always one specific room.
 */
test("a community chip appears on a profile and the opt-out hides it", async ({
  page,
  browser,
}) => {
  const shared = await seedFriends("dep-e", "dep-f");
  const second = await secondClient(browser);
  const name = `Comunidade ${Date.now()}`;

  try {
    // B owns a community that A is also in, so A's card for B can chip it.
    const created = await fetch(`${API}/api/servers`, {
      method: "POST",
      headers: headersFor("dep-f"),
      body: JSON.stringify({ name }),
    });
    const { server } = (await created.json()) as { server: { id: string } };
    const listed = await fetch(`${API}/api/servers/${server.id}/community`, {
      method: "PATCH",
      headers: headersFor("dep-f"),
      body: JSON.stringify({ isCommunity: true, category: "geral" }),
    });
    expect(listed.ok).toBe(true);

    const channelPath = `/app/server/${shared.serverId}/channel/${shared.channelId}`;
    await openAs(page, channelPath, "dep-e");
    await expect(page.getByPlaceholder(/^Message /)).toBeVisible({
      timeout: 20_000,
    });

    const card = await openCardForB(page, shared);
    const chips = card.locator("[data-profile-communities]");
    await expect(chips).toBeVisible();
    await expect(chips.getByText(name)).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: "/tmp/depo-community-chip.png" });

    // --- B opts that one membership out, from its own context menu -------
    // Waits on the rail icon rather than on a composer: the switch lives on the
    // server's own context menu, and `/app` opens with no channel selected.
    await openAs(second.page, "/app", "dep-f");
    const icon = second.page.getByTitle(name, { exact: true });
    await expect(icon).toBeVisible({ timeout: 20_000 });
    await icon.click({ button: "right" });
    const hide = second.page.getByRole("menuitem", {
      name: "Hide from my profile",
    });
    await expect(hide).toBeVisible();
    await second.page.waitForTimeout(500);
    await second.page.screenshot({ path: "/tmp/depo-optout-menu.png" });
    await hide.click();

    // --- and A's card stops chipping it ---------------------------------
    const reopened = await reopenCardForB(page, shared, channelPath);
    await expect(reopened.locator("[data-profile-communities]")).toHaveCount(0);
    await page.waitForTimeout(500);
    await page.screenshot({ path: "/tmp/depo-community-hidden.png" });
  } finally {
    await second.context.close();
  }
});
