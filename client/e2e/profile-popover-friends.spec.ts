import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * The profile card, and the errand it exists for: adding a friend from a
 * message.
 *
 * Before this, an author's avatar and name did nothing on left-click — the
 * only affordance was the row's context menu, and "add friend" lived solely in
 * the friends view's handle search, which needs a `name#0000` you would have to
 * already know. So this drives the whole loop with two REAL clients: A clicks
 * B's name in a channel they share, sends the request from the card, B accepts
 * it from their own side, and A's card then reports the friendship.
 *
 * Two dev-bypass accounts via the `pqp:dev-user-suffix` localStorage hook in
 * `lib/dev-auth.ts` — `dev-local-token:<suffix>` is a distinct account, the
 * same mechanism `dm-call-video-stage.spec.ts` uses.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

// Two full app boots plus a message round trip.
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

/** Age gate + onboarding for one dev-bypass account. */
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
  a: Account;
  b: Account;
}

/**
 * A server both accounts are in. A friend request between strangers is the
 * point of the card, but the two still have to be able to SEE each other —
 * which, outside a DM, means a shared server.
 */
async function seedSharedServer(
  aSuffix: string,
  bSuffix: string,
): Promise<Shared> {
  const a = await materialiseAccount(aSuffix);
  const b = await materialiseAccount(bSuffix);

  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(aSuffix),
    body: JSON.stringify({ name: `Profile ${Date.now()}` }),
  });
  const { server } = (await created.json()) as { server: { id: string } };

  const channelsRes = await fetch(
    `${API}/api/servers/${server.id}/channels`,
    { headers: headersFor(aSuffix) },
  );
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

  return { serverId: server.id, channelId: channel.id, a, b };
}

async function openAs(
  page: Page,
  path: string,
  suffix: string,
): Promise<void> {
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

test("A adds B as a friend from B's name in a channel, B accepts, and the card says Friends", async ({
  page,
  browser,
}) => {
  const shared = await seedSharedServer("profile-a", "profile-b");
  const channelPath = `/app/server/${shared.serverId}/channel/${shared.channelId}`;
  const second = await secondClient(browser);

  try {
    // --- B says something, so A has a name to click ---------------------
    await openAs(second.page, channelPath, "profile-b");
    const composer = second.page.getByPlaceholder(/^Message /);
    await expect(composer).toBeVisible({ timeout: 20_000 });
    const body = `hello-${Date.now()}`;
    await composer.click();
    await composer.fill(body);
    await composer.press("Enter");
    await expect(
      second.page.getByText(body, { exact: true }).last(),
    ).toBeVisible();

    // --- A opens B's profile with a LEFT click on the name ---------------
    await openAs(page, channelPath, "profile-a");
    await expect(page.getByText(body, { exact: true }).last()).toBeVisible({
      timeout: 20_000,
    });

    const nameTrigger = page
      .locator(`[data-author-trigger="${shared.b.id}"]`)
      .last();
    await expect(nameTrigger).toBeVisible();
    await nameTrigger.click();

    const card = page.locator("[data-profile-card]");
    await expect(card).toBeVisible();
    await expect(card.locator("[data-profile-name]")).toHaveText(
      shared.b.displayName,
    );
    // The card hangs off the name it was opened on, not off the window.
    const cardBox = (await card.boundingBox())!;
    const triggerBox = (await nameTrigger.boundingBox())!;
    expect(Math.abs(cardBox.y - triggerBox.y)).toBeLessThan(
      // Top-aligned unless the window forced it up.
      Math.max(200, cardBox.height),
    );

    // --- one click, from a message, to a friend request ------------------
    const add = card.locator('[data-profile-primary="addFriend"]');
    await expect(add).toBeVisible();
    await add.click();
    await expect(
      card.getByText(new RegExp(`Request sent to ${shared.b.displayName}`)),
    ).toBeVisible();

    // Reopening now reports the outgoing request rather than offering again.
    await page.keyboard.press("Escape");
    await nameTrigger.click();
    await expect(
      page.locator('[data-profile-card] [data-profile-primary="cancelRequest"]'),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    // --- B accepts from their own side ----------------------------------
    await second.page.goto("/app/dm");
    await second.page.getByRole("tab", { name: "Pending" }).click();
    await expect(
      second.page.getByText(shared.a.displayName, { exact: true }).first(),
    ).toBeVisible({ timeout: 20_000 });
    await second.page.getByRole("button", { name: "Accept" }).first().click();
    await expect(
      second.page.getByRole("button", { name: "Accept" }),
    ).toHaveCount(0);

    // --- A's card now states the friendship -----------------------------
    // Reopened rather than waited on: the card refetches on mount, which is
    // the same thing a person does when they want to know where they stand.
    await expect
      .poll(
        async () => {
          await nameTrigger.click();
          const primary = page.locator(
            "[data-profile-card] [data-profile-primary]",
          );
          const state = await primary.getAttribute("data-profile-primary");
          if (state !== "alreadyFriends") {
            await page.keyboard.press("Escape");
          }
          return state;
        },
        { timeout: 30_000, intervals: [1000] },
      )
      .toBe("alreadyFriends");

    const card2 = page.locator("[data-profile-card]");
    await expect(card2.getByText("Friends ✓")).toBeVisible();
    // Unfriending is real and silent, so it is behind the overflow rather
    // than under the click that just said "we are friends".
    await expect(card2.getByRole("button", { name: "More" })).toBeVisible();
    await card2.getByRole("button", { name: "More" }).click();
    await expect(
      card2.getByRole("menuitem", { name: "Remove friend" }),
    ).toBeVisible();
  } finally {
    await second.context.close();
  }
});

test("your own name offers nothing, and Escape closes the card", async ({
  page,
}) => {
  const shared = await seedSharedServer("profile-c", "profile-d");
  const channelPath = `/app/server/${shared.serverId}/channel/${shared.channelId}`;

  await openAs(page, channelPath, "profile-c");
  const composer = page.getByPlaceholder(/^Message /);
  await expect(composer).toBeVisible({ timeout: 20_000 });
  const body = `self-${Date.now()}`;
  await composer.click();
  await composer.fill(body);
  await composer.press("Enter");
  await expect(page.getByText(body, { exact: true }).last()).toBeVisible();

  await page.locator(`[data-author-trigger="${shared.a.id}"]`).last().click();
  const card = page.locator("[data-profile-card]");
  await expect(card).toBeVisible();
  await expect(card.getByText("This is you.")).toBeVisible();
  await expect(card.locator("[data-profile-primary]")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
});

test("the members panel opens the same card, so Add friend is there too", async ({
  page,
  browser,
}) => {
  const shared = await seedSharedServer("profile-e", "profile-f");
  const second = await secondClient(browser);

  try {
    // B has to have loaded once for the roster to be interesting; the join
    // already put them in it, so only A needs a browser here.
    await openAs(
      page,
      `/app/server/${shared.serverId}/channel/${shared.channelId}`,
      "profile-e",
    );
    await expect(page.getByPlaceholder(/^Message /)).toBeVisible({
      timeout: 20_000,
    });

    await page.getByRole("button", { name: "Members" }).first().click();
    const trigger = page.locator(`[data-member-trigger="${shared.b.id}"]`);
    await expect(trigger).toBeVisible({ timeout: 20_000 });
    await trigger.click();

    const card = page.locator("[data-profile-card]");
    await expect(card).toBeVisible();
    await expect(
      card.locator('[data-profile-primary="addFriend"]'),
    ).toBeVisible();
    await expect(card.getByRole("button", { name: "Message" })).toBeVisible();
  } finally {
    await second.context.close();
  }
});
