import { expect, test, type Browser, type Page } from "@playwright/test";
import { waitUntilVoiceConnected, leaveVoiceIfConnected } from "./fixtures";

/**
 * "levantar a mão e aí forma a fila de quem levantou primeiro"
 * (docs/RAISED_HANDS.md).
 *
 * Two real dev-bypass accounts in one mesh voice call, because the order is
 * server-stamped (`voice_raised_hands` / `roomRaisedHands`) and a single
 * browser talking to itself cannot prove two screens read the same queue.
 * Covers the happy path only: raise, lower, order, visibility on the roster
 * and the sidebar, a hand lowering on its own when the person leaves, and a
 * moderator lowering somebody else's from the sidebar row. The ordering
 * rule itself, ties, resume/refresh survival, and the cluster (two
 * instances) path are unit- and integration-tested already
 * (`packages/shared/src/raised-hands.test.ts`,
 * `server/src/ws/voice-raised-hands.test.ts`,
 * `server/src/ws/voice-cluster.test.ts`); this spec is the one place that
 * exercises a real socket round trip end to end.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

test.setTimeout(120_000);
test.use({
  viewport: { width: 1440, height: 900 },
  colorScheme: "dark",
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
  permissions: ["microphone"],
  trace: "off",
});

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
  generalChannelId: string;
  voiceChannelName: string;
  ownerId: string;
  guestId: string;
}

/** A server the owner runs, a voice channel on it, and a guest who joined. */
async function seedVoiceServer(
  ownerSuffix: string,
  guestSuffix: string,
): Promise<Shared> {
  const ownerId = await materialiseAccount(ownerSuffix);
  const guestId = await materialiseAccount(guestSuffix);

  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(ownerSuffix),
    body: JSON.stringify({ name: `Hands ${Date.now()}` }),
  });
  const { server } = (await created.json()) as { server: { id: string } };

  const voiceChannelName = `hand-room-${Date.now()}`;
  await fetch(`${API}/api/servers/${server.id}/channels`, {
    method: "POST",
    headers: headersFor(ownerSuffix),
    body: JSON.stringify({ name: voiceChannelName, type: "voice" }),
  });

  const channelsRes = await fetch(`${API}/api/servers/${server.id}/channels`, {
    headers: headersFor(ownerSuffix),
  });
  const { channels } = (await channelsRes.json()) as {
    channels: { id: string; type: string; name: string }[];
  };
  const general = channels.find((c) => c.type === "text")!;

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
    generalChannelId: general.id,
    voiceChannelName,
    ownerId,
    guestId,
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
}

async function secondClient(browser: Browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    permissions: ["microphone"],
  });
  const page = await context.newPage();
  return { context, page };
}

async function joinVoice(page: Page, channelName: string): Promise<void> {
  await page
    .getByRole("button", { name: new RegExp(channelName, "i") })
    .first()
    .dblclick();
  await waitUntilVoiceConnected(page);
  // `--use-fake-device-for-media-stream` feeds a synthetic tone into the mic,
  // which is loud enough to cross the voice-activity threshold on its own.
  // `lowerHandOnTransmit` (use-voice.ts) then does exactly what the doc says
  // it must: "speaking lowers your own hand", the instant `isTransmitting`
  // goes true. That rule is correct and this spec is not testing it, so mute
  // before ever raising a hand here — a real listen-only or muted person is
  // the ordinary case this feature is for anyway.
  const mute = page.getByRole("button", { name: "Mute microphone" });
  await expect(mute).toBeVisible({ timeout: 10_000 });
  if ((await mute.getAttribute("aria-pressed")) !== "true") {
    await mute.click();
    await expect(mute).toHaveAttribute("aria-pressed", "true");
  }
}

test("raising, lowering and the order of two raised hands is the same queue everyone reads", async ({
  page,
  browser,
}) => {
  const shared = await seedVoiceServer("hands-a", "hands-b");
  const here = `/app/server/${shared.serverId}/channel/${shared.generalChannelId}`;

  await openAs(page, here, "hands-a");
  await joinVoice(page, shared.voiceChannelName);

  const second = await secondClient(browser);
  await openAs(second.page, here, "hands-b");
  await joinVoice(second.page, shared.voiceChannelName);

  const raiseA = page.locator("[data-raise-hand]");
  const raiseB = second.page.locator("[data-raise-hand]");
  await expect(raiseA).toBeVisible({ timeout: 20_000 });
  await expect(raiseB).toBeVisible({ timeout: 20_000 });

  // A raises first. Nobody else has a hand up, so the compact strip (this is
  // an audio-only call: no camera on either side, so it never expands) shows
  // A's name and A's own line reads "next" rather than a position.
  await raiseA.click();
  await expect(raiseA).toHaveAttribute("aria-pressed", "true");
  await expect(raiseA).toHaveAttribute("aria-label", "Lower your hand");

  const queueOnA = page.locator('[data-hand-queue="compact"]');
  const queueOnB = second.page.locator('[data-hand-queue="compact"]');
  await expect(queueOnA).toBeVisible({ timeout: 10_000 });
  await expect(queueOnB).toBeVisible({ timeout: 10_000 });
  await expect(
    queueOnA.locator(`[data-hand-queue-entry="${shared.ownerId}"]`),
  ).toBeVisible();
  await expect(
    queueOnB.locator(`[data-hand-queue-entry="${shared.ownerId}"]`),
  ).toBeVisible();
  await expect(queueOnA.locator("[data-hand-position]")).toHaveAttribute(
    "data-hand-position",
    "1",
  );

  // B raises second. The order is the server's, not either client's: both
  // screens must still show A first, and B's own line must say "2nd", never
  // "1st" — that is the whole point of a server-stamped queue.
  await raiseB.click();
  await expect(raiseB).toHaveAttribute("aria-pressed", "true");
  await expect(queueOnB.locator("[data-hand-position]")).toHaveAttribute(
    "data-hand-position",
    "2",
  );
  // The compact line always names the OLDEST raise, whoever is looking.
  await expect(
    queueOnA.locator(`[data-hand-queue-entry="${shared.ownerId}"]`),
  ).toBeVisible();
  await expect(
    queueOnB.locator(`[data-hand-queue-entry="${shared.ownerId}"]`),
  ).toBeVisible();

  // The sidebar occupant row carries the same fact for people outside the
  // call, not only inside it: the raised-hand glyph on A's row.
  await expect(
    page
      .locator(`[data-voice-occupant="${shared.ownerId}"]`)
      .getByLabel("Hand raised"),
  ).toBeVisible();

  // A lowers their own hand. B is now the only one left, so the compact
  // line on B's screen names B and carries no "2nd" line (queue length 1).
  await raiseA.click();
  await expect(raiseA).toHaveAttribute("aria-pressed", "false");
  await expect(
    queueOnB.locator(`[data-hand-queue-entry="${shared.guestId}"]`),
  ).toBeVisible();
  // B is now the only hand up, so B's own line reads "next" (position 1),
  // not a "2nd" line — `data-hand-position` still prints (it is 1-based and
  // covers "next" too), just with a different number than before.
  await expect(queueOnB.locator("[data-hand-position]")).toHaveAttribute(
    "data-hand-position",
    "1",
  );

  await leaveVoiceIfConnected(page);
  await leaveVoiceIfConnected(second.page);
  await second.context.close();
});

test("a hand lowers on its own when that person leaves the room", async ({
  page,
  browser,
}) => {
  const shared = await seedVoiceServer("hands-c", "hands-d");
  const here = `/app/server/${shared.serverId}/channel/${shared.generalChannelId}`;

  await openAs(page, here, "hands-c");
  await joinVoice(page, shared.voiceChannelName);

  const second = await secondClient(browser);
  await openAs(second.page, here, "hands-d");
  await joinVoice(second.page, shared.voiceChannelName);

  // The guest (B) raises a hand; the owner (A) watches it appear.
  const raiseB = second.page.locator("[data-raise-hand]");
  await raiseB.click();
  await expect(
    page
      .locator('[data-hand-queue="compact"]')
      .locator(`[data-hand-queue-entry="${shared.guestId}"]`),
  ).toBeVisible({ timeout: 10_000 });

  // The guest leaves the call outright (not a refresh, not a resume): the
  // hand is a request, not a sanction, so it must not survive that.
  await leaveVoiceIfConnected(second.page);

  await expect(page.locator('[data-hand-queue="compact"]')).toHaveCount(0, {
    timeout: 10_000,
  });

  await leaveVoiceIfConnected(page);
  await second.context.close();
});

test("a moderator can lower somebody else's hand from the sidebar", async ({
  page,
  browser,
}) => {
  const shared = await seedVoiceServer("hands-e", "hands-f");
  const here = `/app/server/${shared.serverId}/channel/${shared.generalChannelId}`;

  // The owner (A) stays out of the call: the doc calls this out explicitly
  // as the reachable surface for a room with no picture, and it is also true
  // for someone running the room from outside the call entirely.
  await openAs(page, here, "hands-e");

  const second = await secondClient(browser);
  await openAs(second.page, here, "hands-f");
  await joinVoice(second.page, shared.voiceChannelName);

  const raiseB = second.page.locator("[data-raise-hand]");
  await raiseB.click();
  await expect(raiseB).toHaveAttribute("aria-pressed", "true");

  const row = page.locator(`[data-voice-occupant="${shared.guestId}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click({ button: "right" });
  const menu = page.getByRole("menu");
  await menu.getByRole("menuitem", { name: "Lower their hand" }).click();

  await expect(raiseB).toHaveAttribute("aria-pressed", "false", {
    timeout: 10_000,
  });
  await expect(raiseB).toHaveAttribute("aria-label", "Raise your hand");

  await leaveVoiceIfConnected(second.page);
  await second.context.close();
});

test("phone: the hand button is reachable and the queue is readable at 390px", async ({
  page,
}) => {
  const shared = await seedVoiceServer("hands-g", "hands-h");
  const here = `/app/server/${shared.serverId}/channel/${shared.generalChannelId}`;

  await page.setViewportSize({ width: 390, height: 844 });
  await openAs(page, here, "hands-g");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("button", { name: new RegExp(shared.voiceChannelName, "i") })
    .first()
    .dblclick();
  await waitUntilVoiceConnected(page);
  // Picking a channel closes the drawer on its own, same as a text channel
  // would, and the content pane's own call bar is `collapsed` (audio-only,
  // no camera): mute/unmute is `!collapsed`-gated in call-stage.tsx and has
  // no other home in that bar, so on a phone the ONLY reachable mute toggle
  // is back inside the channel list sidebar (`voice-status-bar.tsx`). Reopen
  // it to mute — this is a real, if narrow, phone gap worth flagging on its
  // own (see the QA report), not something to route around silently — then
  // close it again for the assertions this test actually cares about.
  await page.getByRole("button", { name: "Open navigation" }).click();
  const mute = page.getByRole("button", { name: "Mute microphone" });
  await expect(mute).toBeVisible({ timeout: 10_000 });
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Close channel list" }).click();

  const raise = page.locator("[data-raise-hand]");
  await expect(raise).toBeVisible({ timeout: 20_000 });
  await expect(raise).toBeInViewport();
  await raise.click();
  await expect(raise).toHaveAttribute("aria-pressed", "true");

  const queue = page.locator('[data-hand-queue="compact"]');
  await expect(queue).toBeVisible({ timeout: 10_000 });
  await expect(queue).toBeInViewport();

  await leaveVoiceIfConnected(page);
});
