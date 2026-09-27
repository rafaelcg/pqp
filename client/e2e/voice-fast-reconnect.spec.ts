import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { ensureServer, openApp } from "./fixtures";

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const headers = {
  "Content-Type": "application/json",
  Authorization: "Bearer dev-local-token",
};

/**
 * A few seconds of network loss in a call must cost a few seconds.
 *
 * 2026-09-27: a caller rated a three-person call one star, "travando e perda
 * de conexão constante". His `/ws` dropped four times and each time he was out
 * of the call's signalling for 70 to 80 seconds while nobody else dropped.
 * The client needed 40 to 60 s just to notice a silent dead link (two missed
 * pings 20 s apart), then retried on a schedule sized for a deploy.
 *
 * The drop is simulated at the socket, not the browser, because the case that
 * hurts is the SILENT one: a Wi-Fi roam or a NAT rebinding leaves the old TCP
 * connection half-open, no `close` ever arrives, and no `offline` event fires.
 * Every `/ws` goes through a Playwright proxy that can:
 *
 * - turn the socket that was open when the network went into a black hole,
 *   forever (a new address: the old connection is never coming back), while
 *   the server end stays open as the zombie it would be in production;
 * - hold frames on any socket opened during the outage until the network
 *   returns (a SYN retransmitted into a network that is not there yet).
 *
 * What is measured is the time from the network returning to the server
 * answering the client's `join-voice-room` resume with `welcome`: the seat
 * resumed, same peer id, media never torn down.
 */

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
  permissions: ["microphone"],
});

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

interface FlakyNetwork {
  down: boolean;
  /** Set once the resume `join-voice-room` goes out after an outage. */
  resumeSentAt: number | null;
  /** Set when the server's `welcome` answers it. */
  resumedAt: number | null;
  /** Called with nothing: the network went away. */
  drop(): void;
  /** The network is back: queued frames go out. */
  restore(): void;
}

async function routeThroughFlakyNetwork(page: Page): Promise<FlakyNetwork> {
  const blackholes: Array<() => void> = [];
  const releases: Array<() => void> = [];
  const net: FlakyNetwork = {
    down: false,
    resumeSentAt: null,
    resumedAt: null,
    drop() {
      net.down = true;
      for (const kill of blackholes.splice(0)) {
        kill();
      }
    },
    restore() {
      net.down = false;
      for (const release of releases.splice(0)) {
        release();
      }
    },
  };

  await page.routeWebSocket(/\/ws$/, (ws: WebSocketRoute) => {
    const server = ws.connectToServer();
    let dead = false;
    const held: Array<() => void> = [];
    blackholes.push(() => {
      dead = true;
    });
    releases.push(() => {
      for (const deliver of held.splice(0)) {
        deliver();
      }
    });

    const toServer = (message: string | Buffer) => {
      if (
        typeof message === "string" &&
        message.includes('"join-voice-room"') &&
        message.includes('"resumePeerId"')
      ) {
        net.resumeSentAt ??= Date.now();
      }
      server.send(message);
    };
    const toPage = (message: string | Buffer) => {
      if (
        net.resumeSentAt !== null &&
        net.resumedAt === null &&
        typeof message === "string" &&
        message.includes('"type":"welcome"')
      ) {
        net.resumedAt = Date.now();
      }
      ws.send(message);
    };

    ws.onMessage((message) => {
      if (dead) {
        return;
      }
      if (net.down) {
        held.push(() => toServer(message));
        return;
      }
      toServer(message);
    });
    server.onMessage((message) => {
      if (dead) {
        return;
      }
      if (net.down) {
        held.push(() => toPage(message));
        return;
      }
      toPage(message);
    });
    // A black-holed socket's close never reaches the other side: the server
    // keeps the zombie until its own heartbeat, as it would in production.
    ws.onClose(() => {
      if (!dead) {
        void server.close();
      }
    });
    server.onClose(() => {
      if (!dead) {
        void ws.close();
      }
    });
  });
  return net;
}

test.describe("voice: a network blip costs seconds, not a minute", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async () => {
    await ensureVoiceChannel();
  });

  test("a silent 3s drop with a change of address resumes the seat quickly", async ({
    page,
  }) => {
    const net = await routeThroughFlakyNetwork(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page);
    await page.getByRole("button", { name: /lobby/ }).first().dblclick();
    await expect(page.getByTestId("call-stage-collapsed")).toBeVisible({
      timeout: 20_000,
    });
    // Let the welcome and first roster settle, so the outage starts on a
    // quiet, healthy socket like the one in the report.
    await page.waitForTimeout(1_500);

    const droppedAt = Date.now();
    net.drop();
    await page.waitForTimeout(3_000);
    const restoredAt = Date.now();
    net.restore();

    await expect
      .poll(() => net.resumedAt, { timeout: 90_000, intervals: [100] })
      .not.toBeNull();
    const back = net.resumedAt! - restoredAt;
    const total = net.resumedAt! - droppedAt;
    test.info().annotations.push({
      type: "reconnect",
      description: `seat resumed ${back} ms after the network returned (${total} ms after it dropped)`,
    });
    // eslint-disable-next-line no-console -- the measurement is the point
    console.log(
      `[fast-reconnect] silent drop: back ${back} ms after restore, ${total} ms total`,
    );

    // Detection is the keepalive's (about ten seconds on the call profile),
    // then an immediate retry and a resume. The old client took 40 to 60 s.
    expect(total).toBeLessThan(15_000);
    // Still in the call, never hung up.
    await expect(page.getByTestId("call-stage-collapsed")).toBeVisible();
  });

  test("a drop the browser reports (offline, then online) resumes within seconds of the network returning", async ({
    page,
    context,
  }) => {
    const net = await routeThroughFlakyNetwork(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page);
    await page.getByRole("button", { name: /lobby/ }).first().dblclick();
    await expect(page.getByTestId("call-stage-collapsed")).toBeVisible({
      timeout: 20_000,
    });
    await page.waitForTimeout(1_500);

    const droppedAt = Date.now();
    net.drop();
    await context.setOffline(true);
    await page.waitForTimeout(3_000);
    const restoredAt = Date.now();
    await context.setOffline(false);
    net.restore();

    await expect
      .poll(() => net.resumedAt, { timeout: 90_000, intervals: [100] })
      .not.toBeNull();
    const back = net.resumedAt! - restoredAt;
    const total = net.resumedAt! - droppedAt;
    test.info().annotations.push({
      type: "reconnect",
      description: `seat resumed ${back} ms after the network returned (${total} ms after it dropped)`,
    });
    // eslint-disable-next-line no-console -- the measurement is the point
    console.log(
      `[fast-reconnect] offline/online drop: back ${back} ms after restore, ${total} ms total`,
    );

    // The `online` event probes the old socket with a short deadline instead
    // of waiting out the keepalive.
    expect(back).toBeLessThan(5_000);
    await expect(page.getByTestId("call-stage-collapsed")).toBeVisible();
  });
});
