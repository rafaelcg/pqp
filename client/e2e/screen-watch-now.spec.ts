import { expect, test, type Browser, type Page } from "@playwright/test";
import { leaveVoiceIfConnected, waitUntilVoiceConnected } from "./fixtures";

/**
 * "Watch now": somebody shares a screen in a voice channel, and everybody else
 * in the server sees it where they already are and gets in with one tap.
 *
 * EVIDENCE. 2026-10-04, Filminho (86 members, 78 of them accounts made that
 * night): the owner shared a film into a plain voice channel, 40 people were
 * in the call and the rest sat in `#general` asking "cadê o filme?" and
 * "como que assiste?". `docs/plans/WATCH_NOW.md`.
 *
 * Three real accounts (`pqp:dev-user-suffix`), the real server, the real flag
 * (`watch_now_banner`, flipped for ONE server through the machine token the
 * way the dashboard does) and a fake screen capture. Nothing is stubbed:
 *
 *   1. alice shares in #filminho, bob in #general sees who/where, taps Assistir
 *      and ends up in the room with his microphone never opened;
 *   2. the strip is a labelled region with a polite status, never an alert;
 *   3. a share that ends takes the strip with it;
 *   4. "Agora não" hides that stream, across a reload, until it ends;
 *   5. a share in a channel bob cannot see is not on his screen at all;
 *   6. two streams: the bigger is the headline, the other is behind "+1";
 *   7. flag off for a server: no strip;
 *   8. a phone width.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
/** `ADMIN_METRICS_TOKEN` of the suite's server, see `playwright.config.ts`. */
const ADMIN_TOKEN = "e2e-admin-token-0123456789abcdef";

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      // getDisplayMedia otherwise blocks on a picker no headless run can answer.
      "--auto-select-desktop-capture-source=Entire screen",
      "--auto-accept-this-tab-capture",
    ],
  },
  permissions: ["microphone", "camera"],
  viewport: { width: 1440, height: 900 },
});

test.setTimeout(180_000);

const run = Date.now().toString(36);

/**
 * Three accounts per test, never reused: an account keeps every server it ever
 * joined, and "the first server in bob's rail" must be this test's, not the
 * previous one's.
 */
interface Who {
  alice: string;
  bob: string;
  carol: string;
}
function people(tag: string): Who {
  return {
    alice: `wn-a${tag}-${run}`,
    bob: `wn-b${tag}-${run}`,
    carol: `wn-c${tag}-${run}`,
  };
}

function headersFor(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

async function api<T>(
  suffix: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: headersFor(suffix),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function materialise(suffix: string): Promise<void> {
  const me = await api<{ ageGate?: string }>(suffix, "/api/me");
  if (me.ageGate && me.ageGate !== "passed") {
    await api(suffix, "/api/me/age-check", {
      method: "POST",
      body: { dateOfBirth: "1990-01-01" },
    });
  }
  await api(suffix, "/api/me/preferences", {
    method: "PATCH",
    body: {
      onboardedAt: new Date().toISOString(),
      firstRunDismissedAt: new Date().toISOString(),
    },
  });
}

interface Seed {
  serverId: string;
  generalId: string;
  filminhoId: string;
  papoId: string;
  secretId: string;
  inviteCode: string;
}

/** alice's server: #general, two voice rooms, one private voice room; bob and carol are members. */
async function seed(name: string, who: Who): Promise<Seed> {
  for (const suffix of [who.alice, who.bob, who.carol]) {
    await materialise(suffix);
  }
  const { server } = await api<{ server: { id: string } }>(who.alice, "/api/servers", {
    method: "POST",
    body: { name },
  });
  const mk = async (channel: string, type: "text" | "voice", isPrivate = false) => {
    const { channel: created } = await api<{ channel: { id: string } }>(
      who.alice,
      `/api/servers/${server.id}/channels`,
      { method: "POST", body: { name: channel, type, isPrivate } },
    );
    return created.id;
  };
  const filminhoId = await mk("filminho", "voice");
  const papoId = await mk("papo", "voice");
  const secretId = await mk("secreto", "voice", true);
  const { channels } = await api<{ channels: { id: string; name: string; type: string }[] }>(
    who.alice,
    `/api/servers/${server.id}/channels`,
  );
  const general = channels.find((c) => c.type === "text");
  if (!general) {
    throw new Error("the new server has no text channel");
  }
  const { invite } = await api<{ invite: { code: string } }>(
    who.alice,
    `/api/servers/${server.id}/invites`,
    { method: "POST", body: {} },
  );
  for (const suffix of [who.bob, who.carol]) {
    await api(suffix, `/api/invites/${invite.code}/join`, { method: "POST" });
  }
  return {
    serverId: server.id,
    generalId: general.id,
    filminhoId,
    papoId,
    secretId,
    inviteCode: invite.code,
  };
}

async function setFlag(serverId: string, key: string, enabled: boolean | null) {
  const res = await fetch(`${API}/api/admin/flag-overrides`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify({ key, serverId, enabled }),
  });
  expect(res.status).toBe(200);
}

async function openAs(page: Page, suffix: string, route = "/app?lang=en"): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(route);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 20_000 });
}

async function newMember(
  browser: Browser,
  suffix: string,
  viewport = { width: 1440, height: 900 },
): Promise<Page> {
  const context = await browser.newContext({
    permissions: ["microphone", "camera"],
    viewport,
    locale: "en-US",
    colorScheme: "dark",
  });
  return context.newPage();
}

/** Join a voice room from the sidebar (a double click, like a person) and start sharing. */
async function shareIn(page: Page, channelName: string): Promise<void> {
  await page.getByRole("button", { name: new RegExp(channelName, "i") }).first().dblclick();
  await waitUntilVoiceConnected(page);
  await page.getByRole("button", { name: "Share your screen" }).first().click();
  await expect(page.getByRole("button", { name: "Stop sharing your screen" }).first()).toBeVisible({
    timeout: 20_000,
  });
}

const banner = (page: Page) => page.locator("[data-watch-now-banner]");

test("bob in #general sees who is sharing where, taps Assistir and watches with the microphone never opened", async ({
  page,
  browser,
}) => {
  const who = people("1");
  const room = await seed(`Noite de cinema ${run}`, who);
  await setFlag(room.serverId, "watch_now_banner", true);

  // bob counts every microphone request his page makes.
  await page.addInitScript(() => {
    const calls: string[] = [];
    (window as unknown as { __gum: string[] }).__gum = calls;
    const devices = navigator.mediaDevices;
    const original = devices.getUserMedia.bind(devices);
    devices.getUserMedia = (constraints) => {
      calls.push(JSON.stringify(constraints ?? {}));
      return original(constraints);
    };
  });
  await openAs(page, who.bob);
  await expect(banner(page)).toHaveCount(0);

  const alice = await newMember(browser, who.alice);
  try {
    await openAs(alice, who.alice);
    await shareIn(alice, "filminho");

    // 1. Who and where, in a labelled region; the status is polite, never an alert.
    const strip = banner(page);
    await expect(strip).toBeVisible({ timeout: 20_000 });
    await expect(strip).toHaveAttribute("aria-label", "Live stream");
    await expect(strip).toContainText(/is sharing their screen in #filminho/i);
    await expect(strip.getByRole("button", { name: /^Watch/ })).toHaveCount(1);
    await expect(strip.locator('[role="alert"]')).toHaveCount(0);
    await expect(strip.locator('[role="status"]')).toHaveText(/started streaming in #filminho/i, {
      timeout: 5_000,
    });

    // 2. One tap: he is in the room, watching.
    await strip.getByRole("button", { name: /^Watch/ }).click();
    await waitUntilVoiceConnected(page);
    await expect(page.locator("video").first()).toBeVisible({ timeout: 30_000 });
    // The strip's work is done: the room is on screen.
    await expect(banner(page)).toHaveCount(0, { timeout: 10_000 });

    // 3. His microphone was never opened, and the call says it is off.
    const requested = await page.evaluate(
      () => (window as unknown as { __gum: string[] }).__gum,
    );
    expect(requested.filter((c) => c.includes('"audio"') && !c.includes('"audio":false'))).toEqual([]);
    await expect(page.getByRole("button", { name: "Unmute microphone" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Turn camera on" }).first()).toBeVisible();

    // 4. Back in #general while still in the call: the strip is a way back.
    await page.getByRole("button", { name: /general/i }).first().click();
    await expect(banner(page)).toContainText(/Back to the stream/i, { timeout: 10_000 });
    await leaveVoiceIfConnected(page);
  } finally {
    await leaveVoiceIfConnected(alice).catch(() => {});
    await alice.context().close();
  }
});

test("the strip goes when the share ends, and 'Not now' hides that stream across a reload until it ends", async ({
  page,
  browser,
}) => {
  const who = people("2");
  const room = await seed(`Noite de cinema B ${run}`, who);
  await setFlag(room.serverId, "watch_now_banner", true);
  await openAs(page, who.bob);

  const alice = await newMember(browser, who.alice);
  try {
    await openAs(alice, who.alice);
    await shareIn(alice, "filminho");
    await expect(banner(page)).toBeVisible({ timeout: 20_000 });

    // Not now: gone, and it stays gone through a reload while the share runs.
    await banner(page).getByRole("button", { name: "Not now" }).click();
    await expect(banner(page)).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(2_500);
    await expect(banner(page)).toHaveCount(0);

    // The share ends, and a NEW one is a new stream: it shows again.
    await alice.getByRole("button", { name: "Stop sharing your screen" }).first().click();
    await expect(
      alice.getByRole("button", { name: "Share your screen" }).first(),
    ).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1_500);
    await alice.getByRole("button", { name: "Share your screen" }).first().click();
    await expect(banner(page)).toBeVisible({ timeout: 30_000 });

    // And when it ends for good, the strip collapses out and unmounts.
    await alice.getByRole("button", { name: "Stop sharing your screen" }).first().click();
    await expect(banner(page)).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await leaveVoiceIfConnected(alice).catch(() => {});
    await alice.context().close();
  }
});

test("a share in a channel bob cannot see is nowhere on his screen", async ({ page, browser }) => {
  const who = people("3");
  const room = await seed(`Noite de cinema C ${run}`, who);
  await setFlag(room.serverId, "watch_now_banner", true);
  await openAs(page, who.bob);

  const alice = await newMember(browser, who.alice);
  try {
    await openAs(alice, who.alice);
    await shareIn(alice, "secreto");
    // Long enough for a roster frame and the strip's own render to have happened.
    await page.waitForTimeout(6_000);
    await expect(banner(page)).toHaveCount(0);
    expect(await page.getByText(/secreto/i).count()).toBe(0);

    // Moving the share to a room he can see brings the strip, for that room only.
    await leaveVoiceIfConnected(alice);
    await shareIn(alice, "filminho");
    await expect(banner(page)).toContainText(/#filminho/i, { timeout: 20_000 });
    await expect(banner(page)).not.toContainText(/secreto/i);
  } finally {
    await leaveVoiceIfConnected(alice).catch(() => {});
    await alice.context().close();
  }
});

test("two streams: the bigger room is the headline and the other is behind a +1", async ({
  page,
  browser,
}) => {
  const who = people("4");
  const room = await seed(`Noite de cinema D ${run}`, who);
  await setFlag(room.serverId, "watch_now_banner", true);
  await openAs(page, who.bob);

  const alice = await newMember(browser, who.alice);
  const carol = await newMember(browser, who.carol);
  try {
    await openAs(alice, who.alice);
    await openAs(carol, who.carol);
    await shareIn(alice, "filminho");
    await shareIn(carol, "papo");

    const strip = banner(page);
    await expect(strip).toBeVisible({ timeout: 20_000 });
    const more = strip.locator("[data-watch-now-more]");
    await expect(more).toHaveText(/\+1 stream/, { timeout: 20_000 });
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await expect(strip.locator("[data-watch-now-row]")).toHaveCount(1);
    // Together the two rows name both rooms.
    const text = (await strip.textContent()) ?? "";
    expect(text).toMatch(/#filminho/);
    expect(text).toMatch(/#papo/);
  } finally {
    await leaveVoiceIfConnected(alice).catch(() => {});
    await leaveVoiceIfConnected(carol).catch(() => {});
    await alice.context().close();
    await carol.context().close();
  }
});

test("a newcomer who arrives on an invite link while a stream is live sees the strip at once, and is joined to nothing", async ({
  page,
  browser,
}) => {
  const who = people("10");
  const room = await seed(`Noite de cinema I ${run}`, who);
  await setFlag(room.serverId, "watch_now_banner", true);
  const newcomer = `wn-n10-${run}`;
  await materialise(newcomer);

  const alice = await newMember(browser, who.alice);
  try {
    await openAs(alice, who.alice);
    await shareIn(alice, "filminho");

    // Never a member: the invite link is the whole of how they arrive.
    await openAs(page, newcomer, `/app/invite/${room.inviteCode}?lang=en`);
    const strip = banner(page);
    await expect(strip).toBeVisible({ timeout: 25_000 });
    await expect(strip).toContainText(/is sharing their screen in #filminho/i);
    // The welcome strip yields: one instruction on the screen, not two.
    await expect(page.locator("[data-arrival-banner]")).toHaveCount(0);
    // And nobody was put in a call without a tap.
    await expect(page.getByText("Voice connected")).toHaveCount(0);
  } finally {
    await leaveVoiceIfConnected(alice).catch(() => {});
    await alice.context().close();
  }
});

test("a live watch party is on the strip too, and Assistir opens it without taking a seat", async ({
  page,
}) => {
  const who = people("8");
  const room = await seed(`Noite de cinema H ${run}`, who);
  await setFlag(room.serverId, "watch_now_banner", true);
  const { party } = await api<{ party: { id: string; channelId: string } }>(
    who.alice,
    `/api/servers/${room.serverId}/watch-parties`,
    { method: "POST", body: { name: "Cinemoon" } },
  );
  // A draft is the host rehearsing: not a show, not on the strip.
  await openAs(page, who.bob);
  await page.waitForTimeout(1_500);
  await expect(banner(page)).toHaveCount(0);

  await api(who.alice, `/api/watch-parties/${party.id}/state`, {
    method: "POST",
    body: { state: "live" },
  });
  const strip = banner(page);
  await expect(strip).toBeVisible({ timeout: 20_000 });
  await expect(strip).toContainText(/is live in the watch party Cinemoon/i);

  // Watching a party is opening it: no seat, no microphone, no call.
  await strip.getByRole("button", { name: /^Watch/ }).click();
  await expect(banner(page)).toHaveCount(0, { timeout: 10_000 });
  await page.waitForTimeout(1_500);
  await expect(page.getByText("Voice connected")).toHaveCount(0);

  // It ends: nothing is left to point at.
  await api(who.alice, `/api/watch-parties/${party.id}/state`, {
    method: "POST",
    body: { state: "ended" },
  });
});

/**
 * A conversation has no server to hold an override, so it reads the
 * deployment-wide answer. Flipping that for a test is flipping it for the whole
 * database the suite shares: restored to "follow the variable" in `finally`.
 */
async function setGlobalFlag(key: string, enabled: boolean | null) {
  const res = await fetch(`${API}/api/admin/flags`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify({ key, enabled }),
  });
  expect(res.status).toBe(200);
}

test("in a DM call a share is on the conversation's strip, and Assistir joins the call muted", async ({
  page,
  browser,
}) => {
  const who = people("9");
  await materialise(who.alice);
  await materialise(who.bob);
  const bob = await api<{ id: string }>(who.bob, "/api/me");
  await api(who.bob, "/api/me", { method: "PATCH", body: { dmPrivacy: "everyone" } });
  const { conversation } = await api<{ conversation: { channelId: string } }>(
    who.alice,
    "/api/dms",
    { method: "POST", body: { userIds: [bob.id] } },
  );
  // Everything that can throw from here on is inside the try, so the shared
  // flag is put back whatever fails (a leaked global flip would turn the strip
  // on for every server of every later spec).
  let alice: Page | null = null;
  try {
    await setGlobalFlag("watch_now_banner", true);
    alice = await newMember(browser, who.alice);
    await openAs(page, who.bob, `/app/dm/${conversation.channelId}?lang=en`);
    await expect(banner(page)).toHaveCount(0);

    await openAs(alice, who.alice, `/app/dm/${conversation.channelId}?lang=en`);
    await alice.getByRole("button", { name: /Start voice call/ }).first().click();
    await waitUntilVoiceConnected(alice);
    await alice.getByRole("button", { name: "Share your screen" }).first().click();
    await expect(
      alice.getByRole("button", { name: "Stop sharing your screen" }).first(),
    ).toBeVisible({ timeout: 20_000 });

    // His phone is ringing; the strip is under the conversation's header all the same.
    const strip = banner(page);
    await expect(strip).toBeVisible({ timeout: 20_000 });
    await expect(strip).toContainText(/is sharing their screen in the call/i);
    await page.evaluate(() => {
      // The ringing card is not what this test is about.
      document.querySelectorAll("[data-incoming-call]").forEach((node) => node.remove());
    });
    await strip.getByRole("button", { name: /^Watch/ }).click();
    await waitUntilVoiceConnected(page);
    await expect(page.getByRole("button", { name: "Unmute microphone" }).first()).toBeVisible();
  } finally {
    try {
      if (alice) {
        await leaveVoiceIfConnected(alice).catch(() => {});
        await alice.context().close().catch(() => {});
      }
      await leaveVoiceIfConnected(page).catch(() => {});
    } finally {
      await setGlobalFlag("watch_now_banner", null);
    }
  }
});

test("flag off for the server: nothing is drawn", async ({ page, browser }) => {
  const who = people("5");
  const room = await seed(`Noite de cinema E ${run}`, who);
  await setFlag(room.serverId, "watch_now_banner", false);
  await openAs(page, who.bob);

  const alice = await newMember(browser, who.alice);
  try {
    await openAs(alice, who.alice);
    await shareIn(alice, "filminho");
    await page.waitForTimeout(5_000);
    await expect(banner(page)).toHaveCount(0);
  } finally {
    await leaveVoiceIfConnected(alice).catch(() => {});
    await alice.context().close();
  }
});

test("on a phone the strip stacks, the button is a full-width tap target, and nothing scrolls sideways", async ({
  browser,
}) => {
  const who = people("6");
  const room = await seed(`Noite de cinema F ${run}`, who);
  await setFlag(room.serverId, "watch_now_banner", true);
  const bob = await newMember(browser, who.bob, { width: 390, height: 844 });
  const alice = await newMember(browser, who.alice);
  try {
    await openAs(bob, who.bob);
    await openAs(alice, who.alice);
    await shareIn(alice, "filminho");
    const strip = banner(bob);
    await expect(strip).toBeVisible({ timeout: 20_000 });
    const watch = strip.getByRole("button", { name: /^Watch/ });
    const box = await watch.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    const overflow = await bob.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    const shots = process.env.WATCH_NOW_SHOTS;
    if (shots) {
      await bob.screenshot({ path: `${shots}/phone-banner.png` });
    }
  } finally {
    await leaveVoiceIfConnected(alice).catch(() => {});
    await alice.context().close();
    await bob.context().close();
  }
});

/**
 * The OTHER half: a notice that a stream started, from the real server.
 * `stream_start_notifications` on for this server, bob opted into OS banners
 * (the switch that already exists) and his window is not in front. The server
 * waits for the share to be stable for 20 s, tells him once, and never tells
 * the sharer; a second share inside the cooldown tells nobody.
 */
test("a stream start reaches the member who opted in after 20 s, once, and never the sharer", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const who = people("7");
  const room = await seed(`Noite de cinema G ${run}`, who);
  await setFlag(room.serverId, "stream_start_notifications", true);
  for (const suffix of [who.bob, who.alice]) {
    await api(suffix, "/api/me/preferences", {
      method: "PATCH",
      body: {
        notifications: { desktop: true, default: "all", servers: {}, channels: {} },
      },
    });
  }

  const recorder = () => {
    const shown: { title: string; body?: string; tag?: string }[] = [];
    (window as unknown as { __notices: typeof shown }).__notices = shown;
    class FakeNotification {
      static permission = "granted";
      static requestPermission = async () => "granted";
      onclick: (() => void) | null = null;
      constructor(title: string, options?: { body?: string; tag?: string }) {
        shown.push({ title, body: options?.body, tag: options?.tag });
      }
      close() {}
    }
    (window as unknown as { Notification: unknown }).Notification = FakeNotification;
    // A window that is not in front: the strip is not what he is looking at.
    document.hasFocus = () => false;
  };
  const notices = (target: Page) =>
    target.evaluate(
      () =>
        (window as unknown as { __notices: { title: string; body?: string; tag?: string }[] })
          .__notices,
    );

  await page.addInitScript(recorder);
  await openAs(page, who.bob);

  const alice = await newMember(browser, who.alice);
  try {
    await alice.addInitScript(recorder);
    await openAs(alice, who.alice);
    await shareIn(alice, "filminho");

    // Not before the share has been stable for 20 s.
    await page.waitForTimeout(8_000);
    expect(await notices(page)).toEqual([]);

    await expect.poll(async () => (await notices(page)).length, { timeout: 40_000 }).toBe(1);
    const [notice] = await notices(page);
    expect(notice!.title).toMatch(/started streaming in #filminho$/);
    expect(notice!.title).toContain(who.alice);
    expect(notice!.body).toBe(`Noite de cinema G ${run} · Watch`);
    expect(notice!.tag).toBe(`stream:${room.filminhoId}`);

    // A second share inside the cooldown tells nobody, and the sharer was never told.
    await alice.getByRole("button", { name: "Stop sharing your screen" }).first().click();
    await expect(
      alice.getByRole("button", { name: "Share your screen" }).first(),
    ).toBeVisible({ timeout: 15_000 });
    await alice.getByRole("button", { name: "Share your screen" }).first().click();
    await page.waitForTimeout(26_000);
    expect(await notices(page)).toHaveLength(1);
    expect(await notices(alice)).toEqual([]);
  } finally {
    await leaveVoiceIfConnected(alice).catch(() => {});
    await alice.context().close();
  }
});
