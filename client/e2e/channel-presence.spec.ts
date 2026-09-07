import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * "N here" — the channel header's count of who is looking at this channel.
 *
 * The server may now describe that list incrementally (`presence-delta`)
 * instead of resending every viewer to every viewer, which is a real change to
 * how this number arrives: an arrival is a patch applied to a list the browser
 * already held, and a departure is a name removed from it. Every unit test for
 * that lives one layer down, where frames are handed to a controller by hand.
 *
 * THIS SPEC EXISTS BECAUSE THOSE CANNOT FAIL FOR THE REASON THAT MATTERS. The
 * delta rule is deliberately conservative — a client that cannot prove it is
 * still in sync stops applying patches and waits — so every plausible bug in
 * it produces a count that is silently, quietly WRONG rather than an error.
 * The only check that catches that is watching a real browser's header while a
 * real second person opens and closes the channel, with nothing mocked between
 * the two: the socket, the fan-out, the sequence rule and the subtitle all
 * have to hold hands for this to pass.
 *
 * Two dev-bypass accounts via the `pqp:dev-user-suffix` hook in
 * `lib/dev-auth.ts`. A second REAL client is the only way to make the count
 * move, because presence is built from live sockets and cannot be faked over
 * HTTP — and because presence dedupes by user id, two browsers signed in as
 * the same shared dev account would read as one person and the test would pass
 * against a server that had stopped sending anything at all.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

// Two full app boots plus a socket round trip each way.
test.setTimeout(120_000);

test.use({ viewport: { width: 1440, height: 900 } });

function headersFor(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

async function materialiseAccount(suffix: string): Promise<string> {
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
    body: JSON.stringify({ onboardedAt: new Date().toISOString() }),
  });
  return body.id;
}

interface Shared {
  serverId: string;
  channelId: string;
  secondChannelId: string;
}

/** A server the first account owns and the second one has joined. */
async function seedServer(
  ownerSuffix: string,
  guestSuffix: string,
): Promise<Shared> {
  await materialiseAccount(ownerSuffix);
  await materialiseAccount(guestSuffix);

  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(ownerSuffix),
    body: JSON.stringify({ name: `Presence ${Date.now()}` }),
  });
  const { server } = (await created.json()) as { server: { id: string } };

  // A second text channel, so "somebody left" can be exercised by SWITCHING
  // rather than by closing the tab. A close races the socket teardown against
  // the assertion; a switch is a `join-channel` for one channel and therefore
  // a departure from the other, on the same live socket, deterministically.
  await fetch(`${API}/api/servers/${server.id}/channels`, {
    method: "POST",
    headers: headersFor(ownerSuffix),
    body: JSON.stringify({ name: "elsewhere", type: "text" }),
  });

  const channelsRes = await fetch(`${API}/api/servers/${server.id}/channels`, {
    headers: headersFor(ownerSuffix),
  });
  const { channels } = (await channelsRes.json()) as {
    channels: { id: string; type: string; name: string }[];
  };
  const texts = channels.filter((one) => one.type === "text");
  const elsewhere = texts.find((one) => one.name === "elsewhere")!;
  const first = texts.find((one) => one.id !== elsewhere.id)!;

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

  return {
    serverId: server.id,
    channelId: first.id,
    secondChannelId: elsewhere.id,
  };
}

async function openAs(page: Page, path: string, suffix: string): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(`${path}?lang=en`);
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

test("the header count follows a second person in and out of the channel", async ({
  page,
  browser,
}) => {
  const shared = await seedServer("presence-a", "presence-b");
  const here = `/app/server/${shared.serverId}/channel/${shared.channelId}`;

  await openAs(page, here, "presence-a");
  // Alone. This is the baseline the whole test is measured against, and it is
  // asserted rather than assumed: a header stuck at some other number would
  // make every assertion below meaningless.
  await expect(page.getByText("1 here")).toBeVisible({ timeout: 20_000 });

  const second = await secondClient(browser);
  try {
    await openAs(second.page, here, "presence-b");

    // The arrival reaches the first browser as a patch, not as a new list.
    // If the sequence rule rejected it, or the server sent a delta the client
    // could not apply, this stays at "1 here" until the next keyframe — which
    // is exactly the silent wrongness this spec is here to catch.
    await expect(page.getByText("2 here")).toBeVisible({ timeout: 20_000 });
    // And symmetrically for the person who arrived.
    await expect(second.page.getByText("2 here")).toBeVisible({
      timeout: 20_000,
    });

    // The guest walks to another channel. The departure is a `left` entry
    // naming them, applied to a list the first browser is still holding.
    await second.page.goto(
      `/app/server/${shared.serverId}/channel/${shared.secondChannelId}?lang=en`,
    );
    await expect(page.getByText("1 here")).toBeVisible({ timeout: 20_000 });

    // Back again, so the count is proved to move in both directions rather
    // than merely to have been right once.
    await second.page.goto(`${here}?lang=en`);
    await expect(page.getByText("2 here")).toBeVisible({ timeout: 20_000 });
  } finally {
    await second.context.close();
  }
});
