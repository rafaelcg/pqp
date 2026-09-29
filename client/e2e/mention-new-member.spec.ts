import { expect, test, type Page } from "@playwright/test";

/**
 * `@` completes against the live member roster, not a copy of the first fetch.
 *
 * The bug: somebody who joined a server after the owner's page loaded appeared
 * in the member panel within seconds, but typing `@` in the composer still did
 * not offer them until the owner reloaded. The panel and the autocomplete read
 * two different lists, and only the panel's was ever refreshed.
 *
 * Two dev-bypass accounts via the `pqp:dev-user-suffix` hook, as in
 * `member-sidebar.spec.ts`. The guest opens a real client so the owner's
 * roster is nudged by a presence frame instead of waiting out the 15s poll.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

// Two full app boots.
test.setTimeout(120_000);

test.use({ viewport: { width: 1440, height: 900 } });

function headersFor(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

async function materialiseAccount(suffix: string): Promise<{
  displayName: string;
}> {
  const headers = headersFor(suffix);
  const me = await fetch(`${API}/api/me`, { headers });
  const body = (await me.json()) as { displayName: string; ageGate?: string };
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
  return { displayName: body.displayName };
}

async function openAs(page: Page, path: string, suffix: string): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(path);
  await expect(page.getByPlaceholder(/^Message /)).toBeVisible({
    timeout: 20_000,
  });
}

test("a member who joins after the page loaded can be mentioned without a reload", async ({
  page,
  browser,
}) => {
  const run = Date.now().toString(36);
  const ownerSuffix = `mention_owner_${run}`;
  const guestSuffix = `mention_guest_${run}`;
  await materialiseAccount(ownerSuffix);
  const guest = await materialiseAccount(guestSuffix);

  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(ownerSuffix),
    body: JSON.stringify({ name: `Mentions ${run}` }),
  });
  const { server } = (await created.json()) as { server: { id: string } };
  const channelsRes = await fetch(`${API}/api/servers/${server.id}/channels`, {
    headers: headersFor(ownerSuffix),
  });
  const { channels } = (await channelsRes.json()) as {
    channels: { id: string; type: string }[];
  };
  const channel = channels.find((one) => one.type === "text")!;
  const path = `/app/server/${server.id}/channel/${channel.id}`;

  // The owner's page loads while the server has nobody else in it.
  await openAs(page, path, ownerSuffix);
  const sidebar = page.locator("[data-member-sidebar]");
  await expect(sidebar).toBeVisible({ timeout: 20_000 });

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
  expect(joined.ok).toBe(true);

  const guestContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  try {
    await openAs(await guestContext.newPage(), path, guestSuffix);

    // The panel learns about the guest without a reload. That part always
    // worked; it is the precondition for the assertion that did not.
    await expect(sidebar).toContainText(guest.displayName, { timeout: 30_000 });

    const composer = page.getByPlaceholder(/^Message /);
    await composer.click();
    await composer.fill("@mention_guest");
    await expect(
      page
        .getByRole("listbox")
        .getByRole("option", { name: new RegExp(`@dev_user_${guestSuffix}`) }),
    ).toBeVisible();
  } finally {
    await guestContext.close();
  }
});
