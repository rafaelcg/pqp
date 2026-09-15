import { expect, test, type Browser, type Page } from "@playwright/test";
import { waitUntilVoiceConnected, leaveVoiceIfConnected } from "./fixtures";

/**
 * Reported 2026-09-14 in "caça bugs": "só de mover um amigo meu para uma
 * outra call e voltar a anterior, o círculo que simboliza saindo a voz do
 * usuário não sai, a voz sai normal" — move a member to another voice
 * channel and back, and their speaking ring never lights again, though their
 * audio is heard fine. The reporter clarified it is a visual bug on the
 * MOVER's own screen, not the moved friend's.
 *
 * Root cause: the sidebar occupant list (`state.occupancy` in `use-voice.ts`)
 * is painted optimistically the instant a moderator drags someone
 * (`moveOccupantSeat` in `voice-occupant-dnd.ts`), carrying their CURRENT
 * peer id into the destination channel — it has no way to know the fresh id
 * their reconnect will mint (every rejoin is a cold join with a new peer id;
 * see `verifyVoiceResumeToken` on the server, which binds a resume token to
 * one channel). That optimistic entry can survive a real roster delta for
 * the same person under their NEW peer id (the merge in the
 * `voice-roster-delta` case of `use-voice.ts` used to key by peer id alone,
 * so the stale and the fresh entry both stood, the delta's size check never
 * matched the server's count, and the whole delta was thrown away rather
 * than converge) — and a second move reads that same stale id back out via
 * `moveOccupantSeat`'s own lookup, carrying it forward again. The sidebar
 * ring reads `person.peerId` off that occupancy entry; `speakingPeerIds`
 * only ever names the CURRENT live peer. Once the two disagree they never
 * converge on their own, which is the "never" in the report.
 *
 * `use-voice.test.ts` ("voice roster deltas") pins the mechanism directly, at
 * the delta layer, including the exact move-away-and-back choreography. This
 * is the one place that drives it through the real drag UI and a real mesh
 * call between two dev-bypass accounts, so a regression that only shows up
 * in the DOM (wrong selector reused, `isSpeaking` wired to the wrong prop, a
 * transport change that keys the roster differently) would still be caught.
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
  channelAName: string;
  channelAId: string;
  channelBId: string;
  guestId: string;
}

/** Owner's server with two voice channels, and a guest already a member. */
async function seedServer(
  ownerSuffix: string,
  guestSuffix: string,
): Promise<Shared> {
  await materialiseAccount(ownerSuffix);
  const guestId = await materialiseAccount(guestSuffix);

  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(ownerSuffix),
    body: JSON.stringify({ name: `Ring ${Date.now()}` }),
  });
  const { server } = (await created.json()) as { server: { id: string } };

  const channelAName = `ring-a-${Date.now()}`;
  const channelBName = `ring-b-${Date.now()}`;
  await fetch(`${API}/api/servers/${server.id}/channels`, {
    method: "POST",
    headers: headersFor(ownerSuffix),
    body: JSON.stringify({ name: channelAName, type: "voice" }),
  });
  await fetch(`${API}/api/servers/${server.id}/channels`, {
    method: "POST",
    headers: headersFor(ownerSuffix),
    body: JSON.stringify({ name: channelBName, type: "voice" }),
  });

  const channelsRes = await fetch(`${API}/api/servers/${server.id}/channels`, {
    headers: headersFor(ownerSuffix),
  });
  const { channels } = (await channelsRes.json()) as {
    channels: { id: string; type: string; name: string }[];
  };
  const general = channels.find((c) => c.type === "text")!;
  const channelA = channels.find((c) => c.name === channelAName)!;
  const channelB = channels.find((c) => c.name === channelBName)!;

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
    channelAName,
    channelAId: channelA.id,
    channelBId: channelB.id,
    guestId,
  };
}

async function openAs(
  page: Page,
  path: string,
  suffix: string,
): Promise<void> {
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
}

/**
 * The sidebar's speaking ring: `VoiceAvatar` puts `ring-accent` on its own
 * wrapper only while `isSpeaking` is true (`voice-avatar.tsx`).
 * `--use-fake-device-for-media-stream` feeds a synthetic tone into the mic
 * that is loud enough to cross the voice-activity threshold on its own (see
 * the same note in `raised-hands.spec.ts`), so this reads the real analyser
 * pipeline, not a stub.
 */
function speakingRing(page: Page, userId: string) {
  return page.locator(
    `[data-voice-occupant="${userId}"]:not([aria-hidden="true"]) .ring-accent`,
  );
}

test("a member's sidebar speaking ring lights again after a moderator moves them away and back", async ({
  page,
  browser,
}) => {
  const shared = await seedServer("ring-mod", "ring-bob");
  const here = `/app/server/${shared.serverId}/channel/${shared.generalChannelId}`;

  // The mover: the server owner, who has MOVE_MEMBERS.
  await openAs(page, here, "ring-mod");
  await joinVoice(page, shared.channelAName);

  const bob = await secondClient(browser);
  try {
    await openAs(bob.page, here, "ring-bob");
    await joinVoice(bob.page, shared.channelAName);

    const row = page.locator(
      `[data-voice-occupant="${shared.guestId}"]:not([aria-hidden="true"])`,
    );
    await expect(row).toBeVisible({ timeout: 20_000 });

    // Bob's mic is live from the moment he joined (nobody here ever mutes),
    // so before touching anything the ring on the MODERATOR's own screen
    // must already light — this is the control, proving the analyser
    // pipeline and the selector both work before the move is ever tried.
    await expect(speakingRing(page, shared.guestId)).toBeVisible({
      timeout: 15_000,
    });

    // Move Bob away, then straight back — the reported shape. Each drag
    // targets the destination channel row; the drop handler reads React
    // state set on drag-start, not the DataTransfer payload, so a Playwright
    // `dragTo` (a real mouse down/move/up sequence Chromium turns into
    // native HTML5 drag events) drives the same code path a real drag does.
    await row.dragTo(
      page.locator(`[data-channel-id="${shared.channelBId}"]`).first(),
    );
    const rowInB = page.locator(
      `[data-voice-occupant-channel="${shared.channelBId}"][data-voice-occupant="${shared.guestId}"]:not([aria-hidden="true"])`,
    );
    await expect(rowInB).toBeVisible({ timeout: 20_000 });

    await rowInB.dragTo(
      page.locator(`[data-channel-id="${shared.channelAId}"]`).first(),
    );
    const rowBackInA = page.locator(
      `[data-voice-occupant-channel="${shared.channelAId}"][data-voice-occupant="${shared.guestId}"]:not([aria-hidden="true"])`,
    );
    await expect(rowBackInA).toBeVisible({ timeout: 20_000 });

    // Bob never left the call and his mic never stopped — the fix under
    // test. Without it this stays dark: the sidebar keeps reading his
    // abandoned pre-move peer id forever, never the one his voice is
    // actually arriving on.
    await expect(speakingRing(page, shared.guestId)).toBeVisible({
      timeout: 15_000,
    });

    await leaveVoiceIfConnected(page);
    await leaveVoiceIfConnected(bob.page);
  } finally {
    await bob.context.close();
  }
});
