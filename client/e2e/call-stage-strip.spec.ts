import { expect, test, type Page } from "@playwright/test";
import { ensureServer, leaveVoiceIfConnected, openApp } from "./fixtures";

/**
 * The stage strip in a room too big to draw one face per person.
 *
 * WHAT THIS IS FOR. On 5 Sep 2026 a watch party filled up and a viewer could
 * not find the streamer's camera: it was a 96px tile in a scrolling column of
 * everybody else's tiles. The layout now says publishers are large and
 * everyone else is a chip, and the chips stop at a limit with a "+N" past it.
 * That limit is the part a small test cannot see: with two people in the room
 * nothing overflows, every assertion passes, and the bug ships again. So this
 * spec builds a room that genuinely overflows.
 *
 * HOW THE ROOM IS BUILT. The browser is the one real client and the one
 * publisher (it shares a screen). The listeners are extra dev-bypass accounts
 * driven straight over the WebSocket protocol, the way `dm-call.spec.ts`
 * drives its callee: they join the voice room for real, so they arrive in the
 * roster, in `remotePeers` and therefore in the strip, without paying for six
 * more browsers. The mesh ceiling is 8 seats, so the room is 1 + 6.
 *
 * The window is under `lg`, where the strip holds four chips: six listeners is
 * then four faces and a "+2", which is the shape a phone at a watch party is
 * in and the smallest room that can prove it.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const WS_URL = API.replace(/^http/, "ws") + "/ws";
const DEV_TOKEN = "dev-local-token";

/** Six listeners plus the browser: one seat under the mesh ceiling. */
const LISTENER_SUFFIXES = [
  "strip1",
  "strip2",
  "strip3",
  "strip4",
  "strip5",
  "strip6",
];

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--auto-select-desktop-capture-source=Entire screen",
      "--auto-accept-this-tab-capture",
    ],
  },
  permissions: ["microphone"],
  viewport: { width: 900, height: 820 },
  trace: "off",
});

test.setTimeout(120_000);

function headersFor(suffix?: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${suffix ? `${DEV_TOKEN}:${suffix}` : DEV_TOKEN}`,
  };
}

interface Frame {
  type: string;
  [key: string]: unknown;
}

/** One listener: a real protocol client with no media and no browser. */
class ListenerSocket {
  private socket!: WebSocket;
  private frames: Frame[] = [];
  private waiters: {
    match: (frame: Frame) => boolean;
    resolve: (frame: Frame) => void;
  }[] = [];

  constructor(private readonly suffix: string) {}

  async connect(): Promise<void> {
    this.socket = new WebSocket(WS_URL);
    await new Promise<void>((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve());
      this.socket.addEventListener("error", () => reject(new Error("ws error")));
    });
    this.socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Frame;
      this.frames.push(frame);
      for (const waiter of this.waiters.splice(0)) {
        if (waiter.match(frame)) {
          waiter.resolve(frame);
        } else {
          this.waiters.push(waiter);
        }
      }
    });
    this.send({ type: "auth", token: `${DEV_TOKEN}:${this.suffix}` });
    await this.waitFor((f) => f.type === "ready");
  }

  async joinVoice(voiceChannelId: string): Promise<void> {
    this.send({ type: "join-voice-room", voiceChannelId });
    await this.waitFor((f) => f.type === "welcome");
  }

  send(frame: Frame): void {
    this.socket.send(JSON.stringify(frame));
  }

  waitFor(match: (frame: Frame) => boolean, timeoutMs = 15_000): Promise<Frame> {
    const existing = this.frames.find(match);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for frame")),
        timeoutMs,
      );
      this.waiters.push({
        match,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }

  close(): void {
    this.socket?.close();
  }
}

/** Age gate, onboarding and membership for one listener account. */
async function materialiseMember(
  suffix: string,
  inviteCode: string,
): Promise<string> {
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
    body: JSON.stringify({ onboardedAt: new Date().toISOString() }),
  });
  await fetch(`${API}/api/invites/${inviteCode}/join`, {
    method: "POST",
    headers,
  });
  return body.displayName;
}

/** The E2E server's lobby, its channel id, and an invite anyone can redeem. */
async function seedRoom(): Promise<{ channelId: string; inviteCode: string }> {
  await ensureServer();
  const headers = headersFor();
  const list = await fetch(`${API}/api/servers`, { headers });
  const { servers } = (await list.json()) as { servers: { id: string }[] };
  const serverId = servers[0]!.id;
  const channelsRes = await fetch(`${API}/api/servers/${serverId}/channels`, {
    headers,
  });
  const { channels } = (await channelsRes.json()) as {
    channels: { id: string; name: string; type: string }[];
  };
  let lobby = channels.find(
    (c) => c.type === "voice" && c.name.toLowerCase() === "lobby",
  );
  if (!lobby) {
    const made = await fetch(`${API}/api/servers/${serverId}/channels`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "lobby", type: "voice" }),
    });
    const { channel } = (await made.json()) as {
      channel: { id: string; name: string; type: string };
    };
    lobby = channel;
  }
  const invite = await fetch(`${API}/api/servers/${serverId}/invites`, {
    method: "POST",
    headers,
    // No cap and no expiry: six accounts redeem the same code.
    body: JSON.stringify({}),
  });
  const { invite: created } = (await invite.json()) as {
    invite: { code: string };
  };
  return { channelId: lobby!.id, inviteCode: created.code };
}

function strip(page: Page) {
  return page.getByTestId("listener-strip");
}

test("a room bigger than the strip: four faces, a +2, and everyone one tap away", async ({
  page,
}) => {
  const { channelId, inviteCode } = await seedRoom();
  const names: string[] = [];
  for (const suffix of LISTENER_SUFFIXES) {
    names.push(await materialiseMember(suffix, inviteCode));
  }

  const sockets: ListenerSocket[] = [];
  try {
    await openApp(page);
    await page.getByRole("button", { name: /lobby/i }).first().dblclick();
    await expect(page.getByTestId("call-stage-collapsed")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("Voice connected")).toBeVisible({
      timeout: 20_000,
    });

    // One publisher, so the stage has something on it and the browser's own
    // account is NOT a listener.
    await page.getByRole("button", { name: "Share your screen" }).click();
    await expect(page.getByTestId("call-stage")).toBeVisible({
      timeout: 20_000,
    });

    for (const suffix of LISTENER_SUFFIXES) {
      const socket = new ListenerSocket(suffix);
      sockets.push(socket);
      await socket.connect();
      await socket.joinVoice(channelId);
    }

    // Six listeners, four chips, and the rest counted rather than drawn.
    await expect(strip(page)).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(
        () => strip(page).locator("[data-call-listener]").count(),
        { timeout: 20_000 },
      )
      .toBe(4);
    const overflow = page.getByTestId("listener-overflow");
    await expect(overflow).toHaveText("+2");
    await expect(overflow).toHaveAccessibleName("2 more listening");

    // The strip is faces and names, never video: a listener must not cost a
    // decoder or a subscription (`lib/remote-video-delivery.ts`).
    await expect(strip(page).locator("video")).toHaveCount(0);

    // The publisher is on the stage, playing, and is not repeated in the strip.
    await expect(
      page.locator('[data-testid="call-stage"] video.object-contain'),
    ).toBeVisible();

    // The people behind the fold are real names, and they are one tap away.
    const drawn = await strip(page)
      .locator("[data-call-listener]")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-call-listener")),
      );
    const hidden = names.filter((name) => !drawn.includes(name));
    expect(hidden).toHaveLength(2);
    await overflow.click();
    await expect
      .poll(() => strip(page).locator("[data-call-listener]").count())
      .toBe(6);
    for (const name of names) {
      await expect(
        strip(page).locator(`[data-call-listener="${name}"]`),
      ).toHaveCount(1);
    }
    // Every one of them is genuinely on screen, not merely in the DOM.
    for (const name of names) {
      await expect(
        strip(page).locator(`[data-call-listener="${name}"]`),
      ).toBeVisible();
    }

    // …and it folds back.
    await page.getByTestId("listener-collapse").click();
    await expect
      .poll(() => strip(page).locator("[data-call-listener]").count())
      .toBe(4);

    // --- one person's sound, found by clicking that person ---------------
    // The knob shipped months ago and a moderator running a 510-member
    // community reported it as missing, because every copy of it was revealed
    // by HOVER: a phone has no hover, and nobody scanning a row of faces
    // thinks to rest a pointer on one. Pressing the chip is the gesture.
    const chipName = (await strip(page)
      .locator("[data-call-listener]")
      .first()
      .getAttribute("data-call-listener"))!;
    await strip(page).locator(`[data-call-listener="${chipName}"]`).click();
    const panel = page.getByTestId("peer-audio-menu");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAccessibleName(`${chipName}'s audio`);
    const slider = panel.getByLabel(`Volume for ${chipName}`);
    await expect(slider).toBeVisible();
    // It moves, and the panel says where it landed.
    await slider.fill("0.5");
    await expect(panel.getByText("50%")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);

    // The same panel from the sidebar seat, which is where the moderator
    // actually clicked: that row has advertised itself as a button since it
    // was written and did nothing when pressed.
    await page
      .getByRole("button", { name: `${chipName}, in voice` })
      .click();
    await expect(page.getByTestId("peer-audio-menu")).toBeVisible();
    // The level he just set is the level he finds here: one setting, one
    // person, whichever surface he opened it from.
    await expect(
      page.getByTestId("peer-audio-menu").getByText("50%"),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("peer-audio-menu")).toHaveCount(0);

    // Hiding the strip leaves the share the whole stage, and is remembered.
    await page.getByRole("button", { name: "Hide participants" }).click();
    await expect(strip(page)).toHaveAttribute("data-open", "false");
    await expect(strip(page).locator("[data-call-listener]")).toHaveCount(0);
    expect(
      await page.evaluate(() => localStorage.getItem("pqp:participant-rail")),
    ).toBe("false");
    await expect(
      page.locator('[data-testid="call-stage"] video.object-contain'),
    ).toBeVisible();
    // A new share does not force the row back open: somebody who tucked it
    // away to watch did not change their mind when the presenter restarted.
    await page
      .getByRole("button", { name: "Stop sharing your screen" })
      .click();
    await page.getByRole("button", { name: "Share your screen" }).click();
    await expect(
      page.locator('[data-testid="call-stage"] video.object-contain'),
    ).toBeVisible({ timeout: 20_000 });
    await expect(strip(page)).toHaveAttribute("data-open", "false");

    await page.getByRole("button", { name: "Show participants" }).click();
    await expect(strip(page)).toHaveAttribute("data-open", "true");
  } finally {
    for (const socket of sockets) {
      socket.close();
    }
    await leaveVoiceIfConnected(page).catch(() => {});
  }
});
