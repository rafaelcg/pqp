import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

/**
 * The wiring half of the support client record: a socket that authenticates
 * hands its account and the families parsed from its upgrade's `User-Agent`
 * to the recorder, with an optional `client` on the `auth` frame on top. The
 * recording itself (batching, retention, the read) is
 * `services/client-platforms.test.ts`, on a real Postgres.
 */

const noted = vi.hoisted(
  () => [] as Array<[string, Record<string, unknown>]>,
);

vi.mock("../services/client-platforms.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/client-platforms.js")>();
  return {
    ...actual,
    clientPlatforms: {
      note: (userId: string, facts: Record<string, unknown>) => noted.push([userId, facts]),
    },
  };
});

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  resolveAuthUser: async () => ({
    user: { id: "00000000-0000-4000-8000-0000000000bb", clerk_id: "clerk_bb" },
  }),
}));

vi.mock("./voice.js", () => ({
  handleVoiceMessage: async () => {},
  isSocketInVoice: () => false,
  removeVoicePeerBySocket: () => {},
  sendAllVoiceRosters: async () => {},
}));

vi.mock("./status.js", () => ({
  registerStatusSocket: async () => {},
  unregisterStatusSocket: () => {},
}));

vi.mock("./watch-party-events.js", () => ({
  catchUpWatchParties: async () => {},
  onHostSocketClosed: () => {},
  onHostSocketOpened: async () => {},
}));

const { handleWsConnection } = await import("./index.js");
const { noteSocketClient } = await import("../services/client-platforms.js");

async function connect(
  headers: Record<string, string>,
  authFrame: Record<string, unknown>,
  name: string,
) {
  const handlers = new Map<string, (...args: never[]) => void>();
  const sent: string[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => sent.push(payload),
    ping: () => {},
    terminate: () => {},
    close: () => {},
    on: (event: string, fn: (...args: never[]) => void) => {
      handlers.set(event, fn);
      return socket;
    },
  } as unknown as WebSocket;
  noteSocketClient(socket, headers);
  handleWsConnection(socket, name);
  handlers.get("message")?.(JSON.stringify({ type: "auth", token: "any", ...authFrame }) as never);
  await vi.waitFor(() => {
    expect(sent.some((raw) => raw.includes('"ready"'))).toBe(true);
  });
}

describe("ws auth records which app the account is on", () => {
  it("passes the families parsed from the upgrade's user agent, not the string", async () => {
    noted.length = 0;
    await connect(
      {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) pqp/0.2.7 Chrome/128.0.0.0 Electron/32.2.0 Safari/537.36",
      },
      {},
      "test-client-platform-desktop",
    );
    expect(noted).toEqual([
      [
        "00000000-0000-4000-8000-0000000000bb",
        { platform: "desktop", appVersion: "0.2.7", osFamily: "macos", browserFamily: "electron" },
      ],
    ]);
    expect(JSON.stringify(noted)).not.toContain("Mozilla");
  });

  it("lets the auth frame fill in a version the user agent cannot carry", async () => {
    noted.length = 0;
    await connect(
      { "user-agent": "okhttp/5.0.0" },
      { client: { platform: "android", version: "0.4.25" } },
      "test-client-platform-android",
    );
    expect(noted[0]![1]).toEqual({
      platform: "android",
      appVersion: "0.4.25",
      osFamily: "android",
      browserFamily: null,
    });
  });

  it("does not let a junk client field cost the socket its connection", async () => {
    noted.length = 0;
    await connect(
      { "user-agent": "okhttp/5.0.0" },
      { client: "not an object" },
      "test-client-platform-junk",
    );
    expect(noted[0]![1]).toMatchObject({ platform: "android", appVersion: null });
  });
});
