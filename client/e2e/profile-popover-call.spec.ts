import {
  expect,
  test,
  type Browser,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";

/**
 * The profile card's phone: ringing somebody from the card you opened on their
 * name, with two real clients.
 *
 * WHY IT IS THE SAME PATH AS EVERY OTHER CALL. The button creates (or reuses)
 * the 1:1 with `POST /api/dms` and hands it to the app, which does what the DM
 * list's own phone does — navigate, then join the live call or start ringing.
 * There is exactly one 1:1 per pair and one set of rules about who may open
 * one; a second path to a call would be a second place for those rules to
 * drift. So what this spec pins is that the card reaches the REAL ring: B's
 * browser draws the incoming-call surface with A's name on it.
 *
 * The second test is about the row rather than the ring. The card is 288px
 * wide and its action row is the most crowded state in the app: a flexible
 * primary, Decline while a request is pending, Message, the new phone and the
 * ellipsis. A button that pushes the row past the card's edge is a regression
 * nobody notices in a screenshot of the friendly state, so it is measured.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

test.setTimeout(120_000);

// A real join needs a microphone; the fake device makes it deterministic.
test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
  permissions: ["microphone"],
});

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
 * A server both accounts are in — which is also what makes them reachable to
 * each other at all: `dm_privacy` defaults to `server_members`, so the pair
 * sharing a room is the thing that lets the card's phone get past
 * `assertReachable` without anybody changing a setting.
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
    body: JSON.stringify({ name: `Call ${Date.now()}` }),
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

/** A picture of one element, kept on disk and on the report. */
async function shot(
  testInfo: TestInfo,
  target: Locator,
  name: string,
): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await target.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function secondClient(browser: Browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  });
  const page = await context.newPage();
  return { context, page };
}

async function say(page: Page, body: string) {
  const composer = page.getByPlaceholder(/^Message /);
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await composer.click();
  await composer.fill(body);
  await composer.press("Enter");
  await expect(page.getByText(body, { exact: true }).last()).toBeVisible();
}

test("the card's phone rings the other account, and their browser says so", async ({
  page,
  browser,
}, testInfo) => {
  const shared = await seedSharedServer("call-a", "call-b");
  const channelPath = `/app/server/${shared.serverId}/channel/${shared.channelId}`;
  const second = await secondClient(browser);

  try {
    // --- B says something, so A has a name to open a card on ------------
    await openAs(second.page, channelPath, "call-b");
    const body = `call-${Date.now()}`;
    await say(second.page, body);

    // --- A opens B's card and presses the phone -------------------------
    await openAs(page, channelPath, "call-a");
    await expect(page.getByText(body, { exact: true }).last()).toBeVisible({
      timeout: 20_000,
    });
    await page.locator(`[data-author-trigger="${shared.b.id}"]`).last().click();

    const card = page.locator("[data-profile-card]");
    await expect(card).toBeVisible();
    const phone = card.locator("[data-profile-call]");
    await expect(phone).toBeVisible();
    await shot(testInfo, card, "profile-card-with-phone");
    await phone.click();

    // A is taken to the conversation and is ringing out.
    await expect(page.getByText("Calling…")).toBeVisible({ timeout: 30_000 });

    // --- and B's browser is ringing, with A's name on it -----------------
    const ring = second.page.getByRole("dialog", {
      name: new RegExp(`${shared.a.displayName}: Incoming call`),
    });
    await expect(ring).toBeVisible({ timeout: 30_000 });
    await shot(testInfo, ring, "incoming-call-on-b");

    // Declining reaches the caller, which is the proof this is the ordinary
    // call path and not a second one that only looks like it.
    await ring.getByRole("button", { name: "Decline" }).click();
    await expect(page.getByText(/declined/)).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Leave", exact: true }).click();
  } finally {
    await second.context.close();
  }
});

test("the phone is absent on your own card, and the busiest row still fits", async ({
  page,
  browser,
}, testInfo) => {
  const shared = await seedSharedServer("call-c", "call-d");
  const channelPath = `/app/server/${shared.serverId}/channel/${shared.channelId}`;
  const second = await secondClient(browser);

  try {
    await openAs(second.page, channelPath, "call-d");
    const body = `row-${Date.now()}`;
    await say(second.page, body);

    // D asks C to be friends: that is the state whose row is widest — Accept,
    // Decline, Message, the phone and the ellipsis, all at 288px.
    const asked = await fetch(`${API}/api/friends`, {
      method: "POST",
      headers: headersFor("call-d"),
      body: JSON.stringify({ userId: shared.a.id }),
    });
    if (!asked.ok) {
      throw new Error(`D could not ask: ${asked.status}`);
    }

    await openAs(page, channelPath, "call-c");
    await expect(page.getByText(body, { exact: true }).last()).toBeVisible({
      timeout: 20_000,
    });

    // --- your own card offers no phone ----------------------------------
    await say(page, `self-${Date.now()}`);
    await page.locator(`[data-author-trigger="${shared.a.id}"]`).last().click();
    const ownCard = page.locator("[data-profile-card]");
    await expect(ownCard).toBeVisible();
    await expect(ownCard.getByText("This is you.")).toBeVisible();
    await expect(ownCard.locator("[data-profile-call]")).toHaveCount(0);
    await page.keyboard.press("Escape");

    // --- and the crowded row stays inside the card ----------------------
    await expect
      .poll(
        async () => {
          await page
            .locator(`[data-author-trigger="${shared.b.id}"]`)
            .last()
            .click();
          const primary = page.locator(
            "[data-profile-card] [data-profile-primary]",
          );
          const state = await primary.getAttribute("data-profile-primary");
          if (state !== "acceptRequest") {
            await page.keyboard.press("Escape");
          }
          return state;
        },
        { timeout: 30_000, intervals: [1000] },
      )
      .toBe("acceptRequest");

    const card = page.locator("[data-profile-card]");
    const cardBox = (await card.boundingBox())!;
    await expect(card.locator("[data-profile-call]")).toBeVisible();
    await expect(card.getByRole("button", { name: "Decline" })).toBeVisible();

    for (const name of ["Accept request", "Decline", "Message", "Call", "More"]) {
      const button = card.getByRole("button", { name, exact: true });
      const box = (await button.boundingBox())!;
      // Inside the card, both edges. A row that overflows would put a control
      // outside the surface it belongs to, or under the one beside it.
      expect(box.x).toBeGreaterThanOrEqual(cardBox.x - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(
        cardBox.x + cardBox.width + 1,
      );
      // Nothing is squeezed to nothing either: a 0-width "Accept request" is
      // the shape this measurement exists to catch.
      expect(box.width).toBeGreaterThan(16);
    }

    await shot(testInfo, card, "profile-card-busiest-row");
  } finally {
    await second.context.close();
  }
});
