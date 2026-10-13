import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Stories, end to end, with two real accounts and the `stories` flag on for
 * one server only (the per-server override the dashboard flips).
 *
 * A posts a text story through the composer. B sees the ring arrive with no
 * reload (the `stories-update` frame), opens it, reacts, and replies. The
 * reply is a real DM quoting the story, so A's conversation shows it with
 * the quote card; and A's own viewers sheet lists B with the reaction.
 *
 * And the other half, which matters as much: a server WITHOUT the flag draws
 * no strip and offers no "Post a story" (the strip answers `enabled: false`).
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
/** `ADMIN_METRICS_TOKEN` of the suite's server, see `playwright.config.ts`. */
const ADMIN_TOKEN = "e2e-admin-token-0123456789abcdef";

test.setTimeout(120_000);

function headersFor(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

function suffixFor(name: string): string {
  return `${name}-${Date.now().toString(36)}`.toLowerCase().slice(0, 32);
}

async function account(suffix: string, displayName: string): Promise<string> {
  const headers = headersFor(suffix);
  const me = await fetch(`${API}/api/me`, { headers });
  const body = (await me.json()) as { id: string; ageGate?: string };
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
  await fetch(`${API}/api/me`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ displayName }),
  });
  return body.id;
}

async function serverWithGuest(
  owner: string,
  guest: string,
  name: string,
): Promise<{ serverId: string; channelId: string }> {
  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(owner),
    body: JSON.stringify({ name }),
  });
  const { server } = (await created.json()) as { server: { id: string } };
  const channelsRes = await fetch(`${API}/api/servers/${server.id}/channels`, {
    headers: headersFor(owner),
  });
  const { channels } = (await channelsRes.json()) as {
    channels: { id: string; type: string }[];
  };
  const inviteRes = await fetch(`${API}/api/servers/${server.id}/invites`, {
    method: "POST",
    headers: headersFor(owner),
    body: JSON.stringify({}),
  });
  const { invite } = (await inviteRes.json()) as { invite: { code: string } };
  const joined = await fetch(`${API}/api/invites/${invite.code}/join`, {
    method: "POST",
    headers: headersFor(guest),
  });
  expect(joined.ok, `guest joins: ${joined.status}`).toBe(true);
  return {
    serverId: server.id,
    channelId: channels.find((channel) => channel.type === "text")!.id,
  };
}

async function setStoriesFlag(serverId: string, enabled: boolean | null) {
  const res = await fetch(`${API}/api/admin/flag-overrides`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify({ key: "stories", serverId, enabled }),
  });
  expect(res.status).toBe(200);
}

async function openAs(page: Page, path: string, suffix: string): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(`${path}?lang=en`);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
}

async function newClient(browser: Browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  });
  return { context, page: await context.newPage() };
}

test("A posts a text story; B sees the ring, opens it, reacts and replies; A sees who watched", async ({
  page,
  browser,
}) => {
  const alice = suffixFor("st-alice");
  const bob = suffixFor("st-bob");
  await account(alice, "Alice Story");
  await account(bob, "Bob Story");
  const { serverId, channelId } = await serverWithGuest(alice, bob, `Stories ${Date.now()}`);
  await setStoriesFlag(serverId, true);
  const here = `/app/server/${serverId}/channel/${channelId}`;

  // B is already in the server when A posts, so the ring has to arrive live.
  const second = await newClient(browser);
  try {
    await openAs(second.page, here, bob);
    // Nobody has posted: B gets the one-off first-run row, not an empty strip.
    await expect(second.page.locator("[data-story-first-run]")).toBeVisible({ timeout: 20_000 });

    // ---- A posts a text story from the server menu.
    await openAs(page, here, alice);
    await page.locator("[data-server-menu-trigger]").first().click();
    await page.getByRole("menuitem", { name: "Post a story" }).click();
    const composer = page.getByRole("dialog", { name: "New story" });
    await expect(composer).toBeVisible();
    await composer.getByRole("radio", { name: "Text" }).click();
    await composer.locator("[data-story-text]").fill("bora de cs hoje?");
    await composer.locator("[data-story-bg='grape']").click();
    // Pre-ticked where A was: this server (the chip says so, the sheet ticks it).
    await expect(composer.locator("[data-story-audience]")).toContainText("Stories ");
    await composer.locator("[data-story-audience]").click();
    await expect(
      composer.getByRole("checkbox", { name: /^Stories / }),
    ).toHaveAttribute("aria-checked", "true");
    await composer.getByRole("button", { name: "Done" }).click();
    await composer.locator("[data-story-post]").click();
    await expect(composer).toBeHidden();
    // A's own ring.
    await expect(page.getByRole("button", { name: "Your story, view" })).toBeVisible({
      timeout: 20_000,
    });

    // ---- B: the ring arrives with no reload.
    const ring = second.page.getByRole("button", { name: "Alice Story's story, new" });
    await expect(ring).toBeVisible({ timeout: 20_000 });
    await ring.click();
    const viewer = second.page.locator("[data-story-viewer]");
    await expect(viewer).toBeVisible();
    await expect(viewer.getByText("bora de cs hoje?")).toBeVisible();
    // Past the one second that counts as a view.
    await second.page.waitForTimeout(1_400);

    // React: focusing the reply raises the reaction row.
    const reply = viewer.getByRole("textbox", { name: "Reply to Alice Story…" });
    await reply.click();
    await viewer.locator("[data-story-react='fire']").click();
    await expect(viewer.locator("[data-story-react='fire']")).toHaveAttribute("aria-pressed", "true");

    // Reply: lands as a DM.
    await reply.fill("que isso");
    await viewer.getByRole("button", { name: "Send" }).click();
    await expect(viewer.getByRole("status").filter({ hasText: "Sent" })).toBeVisible();

    // Closing turns B's ring grey (seen), in place.
    await second.page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    await expect(
      second.page.getByRole("button", { name: "Alice Story's story, seen" }),
    ).toBeVisible({ timeout: 10_000 });

    // ---- A: the reply is a conversation message quoting the story.
    const conversations = await fetch(`${API}/api/dms`, { headers: headersFor(alice) });
    const { conversations: list } = (await conversations.json()) as {
      conversations: { channelId: string; participants: { displayName: string }[] }[];
    };
    const withBob = list.find((one) =>
      one.participants.some((person) => person.displayName === "Bob Story"),
    );
    expect(withBob, "a conversation with B exists").toBeTruthy();
    await page.goto(`/app/dm/${withBob!.channelId}?lang=en`);
    // In the transcript, not the list's preview line.
    await expect(page.getByRole("log").getByText("que isso")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-story-quote='live']")).toBeVisible();
    await expect(page.getByText("Replied to your story")).toBeVisible();

    // ---- A: own story, viewers sheet lists B with the reaction.
    await page.goto(`${here}?lang=en`);
    await page.getByRole("button", { name: "Your story, view" }).click();
    const own = page.locator("[data-story-viewer]");
    await expect(own).toBeVisible();
    await own.locator("[data-story-views]").click();
    const sheet = own.locator("[data-story-viewers]");
    await expect(sheet.getByText("Seen by 1")).toBeVisible({ timeout: 10_000 });
    const row = sheet.locator("[data-story-viewer-row='Bob Story']");
    await expect(row).toBeVisible();
    await expect(row.getByText("🔥")).toBeVisible();
    await expect(row.getByText(/replied/)).toBeVisible();
  } finally {
    await second.context.close();
    await setStoriesFlag(serverId, null);
  }
});

test("with the flag off for a server, nothing about stories is drawn there", async ({ page }) => {
  const owner = suffixFor("st-off");
  const guest = suffixFor("st-offg");
  await account(owner, "Off Owner");
  await account(guest, "Off Guest");
  const { serverId, channelId } = await serverWithGuest(owner, guest, `NoStories ${Date.now()}`);
  const strip = await fetch(`${API}/api/servers/${serverId}/stories`, {
    headers: headersFor(owner),
  });
  expect(((await strip.json()) as { enabled: boolean }).enabled).toBe(false);

  await openAs(page, `/app/server/${serverId}/channel/${channelId}`, owner);
  await expect(page.getByPlaceholder(/^Message /)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-story-strip], [data-story-first-run]")).toHaveCount(0);
  await page.locator("[data-server-menu-trigger]").first().click();
  await expect(page.getByRole("menuitem", { name: "Invite people" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Post a story" })).toHaveCount(0);
});
