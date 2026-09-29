import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Block and Remove friend, confirmed from the profile card with a MOUSE.
 *
 * Both confirms are portalled to the body, outside the card. The card closed
 * itself on any mousedown outside it, so the press on the confirm's red button
 * closed the card, which unmounted the confirm before the click landed. The
 * dialog vanished and nothing was sent. Tab then Enter worked, because a key
 * press is not a mousedown, which is why nobody saw it from the keyboard.
 *
 * `locator.click()` is a real mousedown, mouseup and click at the button's
 * centre, so these tests fail on the old code the same way a person did.
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
    body: JSON.stringify({
      onboardedAt: new Date().toISOString(),
      firstRunDismissedAt: new Date().toISOString(),
    }),
  });
  return { id: body.id, displayName: body.displayName };
}

interface Pair {
  a: Account;
  b: Account;
  dmPath: string;
}

/** A and B are friends and share a DM. Fresh suffixes per test, so no state leaks. */
async function seedFriendsWithDm(aSuffix: string, bSuffix: string): Promise<Pair> {
  const a = await materialiseAccount(aSuffix);
  const b = await materialiseAccount(bSuffix);
  const sent = await fetch(`${API}/api/friends`, {
    method: "POST",
    headers: headersFor(aSuffix),
    body: JSON.stringify({ userId: b.id }),
  });
  if (!sent.ok) {
    throw new Error(`friend request failed: ${sent.status}`);
  }
  const accepted = await fetch(`${API}/api/friends/${a.id}/accept`, {
    method: "POST",
    headers: headersFor(bSuffix),
  });
  if (!accepted.ok) {
    throw new Error(`accept failed: ${accepted.status}`);
  }
  const dm = await fetch(`${API}/api/dms`, {
    method: "POST",
    headers: headersFor(bSuffix),
    body: JSON.stringify({ userIds: [a.id] }),
  });
  const { conversation } = (await dm.json()) as {
    conversation: { channelId: string };
  };
  return { a, b, dmPath: `/app/dm/${conversation.channelId}` };
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

/** B posts in the DM, then A opens it and clicks B's name to open the card. */
async function openCardOnB(
  page: Page,
  browser: Browser,
  pair: Pair,
  aSuffix: string,
  bSuffix: string,
) {
  const second = await secondClient(browser);
  try {
    await openAs(second.page, pair.dmPath, bSuffix);
    const composer = second.page.getByPlaceholder(/^Message /);
    await expect(composer).toBeVisible({ timeout: 20_000 });
    const body = `hello-${Date.now()}`;
    await composer.click();
    await composer.fill(body);
    await composer.press("Enter");
    await expect(second.page.getByText(body, { exact: true }).last()).toBeVisible();

    await openAs(page, pair.dmPath, aSuffix);
    await expect(page.getByText(body, { exact: true }).last()).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    await second.context.close();
  }
  const trigger = page.locator(`[data-author-trigger="${pair.b.id}"]`).last();
  await trigger.click();
  const card = page.locator("[data-profile-card]");
  await expect(card).toBeVisible();
  return card;
}

async function listBlocked(suffix: string): Promise<string[]> {
  const res = await fetch(`${API}/api/blocks`, { headers: headersFor(suffix) });
  const { blocked } = (await res.json()) as { blocked: { id: string }[] };
  return blocked.map((one) => one.id);
}

async function listFriends(suffix: string): Promise<string[]> {
  const res = await fetch(`${API}/api/friends`, { headers: headersFor(suffix) });
  const { friends } = (await res.json()) as { friends: { id: string }[] };
  return friends.map((one) => one.id);
}

test("Block from the card, confirmed with a mouse click, blocks", async ({
  page,
  browser,
}) => {
  const run = Date.now().toString(36);
  const aSuffix = `blk-a-${run}`;
  const bSuffix = `blk-b-${run}`;
  const pair = await seedFriendsWithDm(aSuffix, bSuffix);
  const card = await openCardOnB(page, browser, pair, aSuffix, bSuffix);

  await card.getByRole("button", { name: "More" }).click();
  await card.getByRole("menuitem", { name: "Block" }).click();

  const confirm = page.getByRole("dialog", { name: "Block" });
  await expect(confirm).toBeVisible();

  // Cancel with the mouse keeps the card: only the confirm goes away.
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  await expect(card).toBeVisible();

  await card.getByRole("button", { name: "More" }).click();
  await card.getByRole("menuitem", { name: "Block" }).click();
  await expect(confirm).toBeVisible();

  const posted = page.waitForRequest(
    (req) => req.method() === "POST" && req.url().endsWith("/api/blocks"),
  );
  await confirm.getByRole("button", { name: "Block", exact: true }).click();
  await posted;

  await expect.poll(() => listBlocked(aSuffix)).toContain(pair.b.id);
  await expect.poll(() => listFriends(aSuffix)).not.toContain(pair.b.id);
  await expect(card).toBeHidden();
});

test("Remove friend from the card, confirmed with a mouse click, removes", async ({
  page,
  browser,
}) => {
  const run = Date.now().toString(36);
  const aSuffix = `rmf-a-${run}`;
  const bSuffix = `rmf-b-${run}`;
  const pair = await seedFriendsWithDm(aSuffix, bSuffix);
  const card = await openCardOnB(page, browser, pair, aSuffix, bSuffix);

  await card.getByRole("button", { name: "More" }).click();
  await card.getByRole("menuitem", { name: "Remove friend" }).click();

  const confirm = page.getByRole("dialog", { name: "Remove friend" });
  await expect(confirm).toBeVisible();

  // Escape backs out of the confirm and leaves the card where it was.
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await expect(card).toBeVisible();

  await card.getByRole("button", { name: "More" }).click();
  await card.getByRole("menuitem", { name: "Remove friend" }).click();
  await confirm.getByRole("button", { name: "Remove friend" }).click();

  await expect.poll(() => listFriends(aSuffix)).not.toContain(pair.b.id);

  // With no confirm up, Escape closes the card itself again.
  await expect(confirm).toBeHidden();
  await expect(card).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
});
