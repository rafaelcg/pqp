import { expect, test, type WebSocketRoute } from "@playwright/test";
import { ensureServer, openApp } from "./fixtures";

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const headers = {
  "Content-Type": "application/json",
  Authorization: "Bearer dev-local-token",
};

/**
 * A listener's seat survives a dropped `/ws`, with the real client and server.
 *
 * Production, 2026-10-24: about 74 people watching a screen share in one
 * LiveKit room, 210 joins, every one cold, six seats ever resumed. A seat with
 * no microphone pipeline (an audience seat, or a microphone that would not
 * open) reconnected through `join()`, whose guard sent it to
 * `retakeSeatWithMicrophone`: a `leave-voice-room` carrying the resume pair,
 * which retired the seat the server was holding, then a cold join.
 *
 * This browser has no microphone and no permission to ask for one, so it
 * seats itself listen-only, the same pipeline-less seat. Every `/ws` goes
 * through a proxy that records what each side sent and can close the socket
 * the way a network change does. What is asserted is the wire: the next
 * `join-voice-room` names the same peer, no `leave-voice-room` is sent, and
 * the server answers `resumed: true`. LiveKit is not involved (no SFU runs in
 * this suite), so the room is a mesh one; the client path under test is
 * transport-independent and the server's mesh hold needs the `mesh-resume`
 * capability this client declares.
 */

test.use({ permissions: [] });

async function ensureVoiceChannel(): Promise<void> {
  await ensureServer();
  const res = await fetch(`${API}/api/servers`, { headers });
  const { servers } = (await res.json()) as { servers: { id: string }[] };
  const serverId = servers[0]!.id;
  const list = await fetch(`${API}/api/servers/${serverId}/channels`, {
    headers,
  });
  const { channels } = (await list.json()) as {
    channels: { name: string; type: string }[];
  };
  if (channels.some((c) => c.type === "voice" && c.name === "lobby")) {
    return;
  }
  await fetch(`${API}/api/servers/${serverId}/channels`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "lobby", type: "voice" }),
  });
}

interface Wire {
  /** Parsed frames the page sent, in order, across every socket. */
  sent: { type: string; [key: string]: unknown }[];
  /** Parsed frames the server sent, in order, across every socket. */
  received: { type: string; [key: string]: unknown }[];
  /** Close the live socket from the server side, as a network change would. */
  dropSocket(): void;
}

function parse(message: string | Buffer) {
  if (typeof message !== "string") {
    return null;
  }
  try {
    return JSON.parse(message) as { type: string; [key: string]: unknown };
  } catch {
    return null;
  }
}

test.describe("voice: a listener's seat resumes", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async () => {
    await ensureVoiceChannel();
  });

  test("a listen-only seat resumes on a reconnect, without a leave", async ({
    page,
  }) => {
    const wire: Wire = {
      sent: [],
      received: [],
      dropSocket: () => {},
    };
    await page.routeWebSocket(/\/ws$/, (ws: WebSocketRoute) => {
      const server = ws.connectToServer();
      wire.dropSocket = () => {
        void ws.close({ code: 4000, reason: "network change" });
        void server.close();
      };
      ws.onMessage((message) => {
        const frame = parse(message);
        if (frame) {
          wire.sent.push(frame);
        }
        server.send(message);
      });
      server.onMessage((message) => {
        const frame = parse(message);
        if (frame) {
          wire.received.push(frame);
        }
        ws.send(message);
      });
      ws.onClose(() => void server.close());
      server.onClose(() => void ws.close());
    });

    await openApp(page);
    await page.getByRole("button", { name: /lobby/ }).first().dblclick();
    await expect(page.getByTestId("call-stage-collapsed")).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(() => wire.received.find((f) => f.type === "welcome"), {
        timeout: 20_000,
      })
      .toBeDefined();
    const welcome = wire.received.find((f) => f.type === "welcome")!;
    const peerId = welcome.peerId as string;
    const joinsBefore = wire.sent.filter(
      (f) => f.type === "join-voice-room",
    ).length;
    wire.dropSocket();

    await expect
      .poll(
        () =>
          wire.sent.filter((f) => f.type === "join-voice-room").length >
          joinsBefore,
        { timeout: 30_000 },
      )
      .toBe(true);
    const rejoin = wire.sent.filter((f) => f.type === "join-voice-room").at(-1)!;
    expect(rejoin).toMatchObject({ resume: true, resumePeerId: peerId });
    expect(rejoin.resumeToken).toBeTruthy();

    // The server held the seat and gives it back: same id, resumed.
    await expect
      .poll(
        () =>
          wire.received.filter(
            (f) => f.type === "welcome" && f.resumed === true,
          ).length,
        { timeout: 30_000 },
      )
      .toBe(1);
    expect(
      wire.received.filter((f) => f.type === "welcome").at(-1)?.peerId,
    ).toBe(peerId);

    // And the client never hung up on its own seat to get there.
    expect(wire.sent.filter((f) => f.type === "leave-voice-room")).toEqual([]);
    await expect(page.getByTestId("call-stage-collapsed")).toBeVisible();
  });
});
