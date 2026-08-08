import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * "A sends B a friend request. B is looking at the app. What does B see?"
 *
 * The answer used to be NOTHING. There was no friend frame on the socket, so a
 * request reached B only when B next fetched — and the only thing that fetched
 * was the friends view's own 15s poll, which runs only while that view is on
 * screen. The pending count existed exclusively on the Pending *tab inside*
 * that view: a badge you have to already be looking at the thing to see.
 *
 * So this drives the real shape of the complaint with two real clients: B sits in
 * a CHANNEL, which is where people sit, and never reloads, never navigates, and
 * never opens the friends view. The badge on the app's front door has to appear
 * on its own.
 *
 * Two dev-bypass accounts via the `pqp:dev-user-suffix` localStorage hook in
 * `lib/dev-auth.ts` — the same mechanism `profile-popover-friends.spec.ts` uses.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

// Two full app boots plus a socket round trip.
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

interface Shared {
  serverId: string;
  channelId: string;
  a: Account;
  b: Account;
}

/**
 * A server both accounts are in, so B has somewhere to be sitting that is not
 * the friends view.
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
    body: JSON.stringify({ name: `Nudge ${Date.now()}` }),
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

test("a friend request badges B's front door while B sits in a channel, with no reload", async ({
  browser,
}) => {
  const shared = await seedSharedServer("nudge-a", "nudge-b");
  const channelPath = `/app/server/${shared.serverId}/channel/${shared.channelId}`;
  const second = await secondClient(browser);

  try {
    // --- B is in a channel, and stays there for the whole test -----------
    await openAs(second.page, channelPath, "nudge-b");
    await expect(second.page.getByPlaceholder(/^Message /)).toBeVisible({
      timeout: 20_000,
    });

    // The badge is not there yet, which is what makes its arrival meaningful.
    const badge = second.page.locator("[data-friend-requests]");
    await expect(badge).toHaveCount(0);

    // --- A asks, from their own client ----------------------------------
    // Over HTTP rather than through A's UI: the popover path is already proved
    // end to end in `profile-popover-friends.spec.ts`, and what is under test
    // here is entirely on B's side.
    const sent = await fetch(`${API}/api/friends`, {
      method: "POST",
      headers: headersFor("nudge-a"),
      body: JSON.stringify({ userId: shared.b.id }),
    });
    expect(sent.status).toBe(201);

    // --- B's front door lights up, on its own ---------------------------
    // No reload, no navigation, no friends view. If the badge only ever moved
    // on a fetch, this is the assertion that would fail.
    await expect(badge.first()).toHaveAttribute("data-friend-requests", "1", {
      timeout: 20_000,
    });

    // Still in the channel — the nudge must not have navigated anybody.
    await expect(second.page.getByPlaceholder(/^Message /)).toBeVisible();

    // --- and it clears itself when B answers ----------------------------
    // Same client, same session: B walks to the friends view, accepts, and the
    // badge goes away without a reload either.
    await second.page.getByRole("button", { name: "Direct messages" }).click();
    await second.page.getByRole("tab", { name: "Pending" }).click();
    await expect(
      second.page.getByText(shared.a.displayName, { exact: true }).first(),
    ).toBeVisible({ timeout: 20_000 });
    await second.page.getByRole("button", { name: "Accept" }).first().click();
    await expect(second.page.locator("[data-friend-requests]")).toHaveCount(0, {
      timeout: 20_000,
    });
  } finally {
    await second.context.close();
  }
});

test("A hears that B accepted, live, without reopening anything", async ({
  page,
  browser,
}) => {
  const shared = await seedSharedServer("nudge-c", "nudge-d");
  const channelPath = `/app/server/${shared.serverId}/channel/${shared.channelId}`;
  const second = await secondClient(browser);

  try {
    // A asks first, then sits on the friends view waiting — the one screen
    // where an answer is worth saying out loud.
    await fetch(`${API}/api/friends`, {
      method: "POST",
      headers: headersFor("nudge-c"),
      body: JSON.stringify({ userId: shared.b.id }),
    });

    await openAs(page, "/app/dm", "nudge-c");
    await expect(page.getByRole("tab", { name: "Pending" })).toBeVisible({
      timeout: 20_000,
    });

    // B accepts from a channel, over HTTP — B's UI is not what is under test.
    await openAs(second.page, channelPath, "nudge-d");
    await expect(second.page.getByPlaceholder(/^Message /)).toBeVisible({
      timeout: 20_000,
    });
    const accepted = await fetch(
      `${API}/api/friends/${shared.a.id}/accept`,
      { method: "POST", headers: headersFor("nudge-d") },
    );
    expect(accepted.ok).toBe(true);

    // A's screen says so. Deliberately does not name B: the frame carries no
    // name, and the row that just appeared already does.
    await expect(
      page.getByText("Your friend request was accepted."),
    ).toBeVisible({ timeout: 20_000 });
  } finally {
    await second.context.close();
  }
});

/**
 * The negative that keeps the nudge honest.
 *
 * Re-sending a request that is already pending is a no-op that must not fire a
 * frame — `sendFriendRequest` deliberately leaves `created_at` alone for the
 * same reason, so that an ignored request cannot be re-surfaced by resending. If
 * resending rang a bell, resending would be a way to keep ringing one.
 */
test("resending an already-pending request does not re-nudge", async ({
  browser,
}) => {
  const shared = await seedSharedServer("nudge-e", "nudge-f");
  const channelPath = `/app/server/${shared.serverId}/channel/${shared.channelId}`;
  const second = await secondClient(browser);

  try {
    await openAs(second.page, channelPath, "nudge-f");
    await expect(second.page.getByPlaceholder(/^Message /)).toBeVisible({
      timeout: 20_000,
    });

    const send = () =>
      fetch(`${API}/api/friends`, {
        method: "POST",
        headers: headersFor("nudge-e"),
        body: JSON.stringify({ userId: shared.b.id }),
      });

    expect((await send()).status).toBe(201);
    const badge = second.page.locator("[data-friend-requests]").first();
    await expect(badge).toHaveAttribute("data-friend-requests", "1", {
      timeout: 20_000,
    });

    // The resend answers 200 (nothing changed) and the badge stays at one — it
    // could only have gone to two by counting the same request twice, but the
    // property being pinned is that the second POST is silent on the wire.
    expect((await send()).status).toBe(200);
    await expect(badge).toHaveAttribute("data-friend-requests", "1");
  } finally {
    await second.context.close();
  }
});
