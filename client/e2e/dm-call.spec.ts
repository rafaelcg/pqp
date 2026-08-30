import { expect, test } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * A 1:1 conversation call, end to end: the browser is the caller, and the
 * callee is a second dev-bypass account driven over a raw WebSocket from the
 * test itself. That keeps the test honest about the protocol — the callee
 * receives the actual `call-incoming` frame, answers with the actual
 * `call-decline` frame — without needing a second browser identity, which the
 * dev bypass cannot mint inside a page (the client always sends the primary
 * token).
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const WS_URL = API.replace(/^http/, "ws") + "/ws";
const DEV_TOKEN = "dev-local-token";
const CALLEE_TOKEN = `${DEV_TOKEN}:callee`;

const callerHeaders = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${DEV_TOKEN}`,
};
const calleeHeaders = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${CALLEE_TOKEN}`,
};

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

interface Frame {
  type: string;
  [key: string]: unknown;
}

/** The callee's realtime connection, as a plain protocol client. */
class CalleeSocket {
  private socket!: WebSocket;
  private frames: Frame[] = [];
  private waiters: {
    match: (frame: Frame) => boolean;
    resolve: (frame: Frame) => void;
  }[] = [];

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
    this.send({ type: "auth", token: CALLEE_TOKEN });
    await this.waitFor((f) => f.type === "ready");
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

async function seedConversation(): Promise<string> {
  // Both accounts must be past the age gate — on a fresh database neither is,
  // and the caller cannot lean on `openApp` because seeding runs first.
  for (const headers of [callerHeaders, calleeHeaders]) {
    const who = await fetch(`${API}/api/me`, { headers });
    const body = (await who.json()) as { ageGate?: string };
    if (body.ageGate && body.ageGate !== "passed") {
      await fetch(`${API}/api/me/age-check`, {
        method: "POST",
        headers,
        body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
      });
    }
  }
  const me = await fetch(`${API}/api/me`, { headers: calleeHeaders });
  const callee = (await me.json()) as { id: string };
  // The two accounts share no server, and the default privacy refuses
  // strangers — open the door for this pair.
  await fetch(`${API}/api/me`, {
    method: "PATCH",
    headers: calleeHeaders,
    body: JSON.stringify({ dmPrivacy: "everyone" }),
  });
  // …then open (or re-open) the 1:1 as the caller.
  const opened = await fetch(`${API}/api/dms`, {
    method: "POST",
    headers: callerHeaders,
    body: JSON.stringify({ userIds: [callee.id] }),
  });
  const { conversation } = (await opened.json()) as {
    conversation: { channelId: string };
  };
  return conversation.channelId;
}

test("calling a DM rings the other account, and their decline reaches the caller", async ({
  page,
}) => {
  const conversationId = await seedConversation();
  const callee = new CalleeSocket();
  await callee.connect();

  try {
    await openApp(page);
    await page.getByRole("button", { name: "Direct messages" }).click();

    // The sidebar row's phone button is revealed on hover.
    const row = page.getByRole("button", { name: /Start voice call/ }).first();
    await row.click({ force: true });

    // The call panel appears in the conversation and reports the outgoing ring.
    await expect(page.getByText("Calling…")).toBeVisible({ timeout: 20_000 });

    // The callee's socket receives the real invitation frame.
    const incoming = await callee.waitFor(
      (f) => f.type === "call-incoming" && f.conversationId === conversationId,
    );
    expect((incoming.caller as { displayName: string }).displayName).toContain(
      "Dev User",
    );
    expect(incoming.kind).toBe("dm");

    // Decline — the caller's UI says so.
    callee.send({ type: "call-decline", conversationId });
    await expect(page.getByText(/declined/)).toBeVisible({ timeout: 10_000 });

    // Hang up; the panel's controls go with the call.
    await page.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(page.getByText("Calling…")).not.toBeVisible();
  } finally {
    callee.close();
  }
});

test("the callee's join resolves the ring and appears as a tile", async ({
  page,
}) => {
  const conversationId = await seedConversation();
  const callee = new CalleeSocket();
  await callee.connect();

  try {
    await openApp(page);
    await page.getByRole("button", { name: "Direct messages" }).click();
    await page
      .getByRole("button", { name: /Start voice call/ })
      .first()
      .click({ force: true });
    await expect(page.getByText("Calling…")).toBeVisible({ timeout: 20_000 });
    await callee.waitFor(
      (f) => f.type === "call-incoming" && f.conversationId === conversationId,
    );

    // Accepting IS joining the room — no separate accept frame exists.
    callee.send({ type: "join-voice-room", voiceChannelId: conversationId });
    await callee.waitFor((f) => f.type === "welcome");

    // Voice-only after pickup is the slim bar, not a tile on the stage.
    await expect(page.getByText("Calling…")).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("call-stage-collapsed")).toBeVisible();

    await page.getByRole("button", { name: "Leave", exact: true }).click();
  } finally {
    callee.close();
  }
});
