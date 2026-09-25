import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

/**
 * The wiring half of the server-majority region signal: a socket that
 * authenticates hands its account and its upgrade's `CF-IPCountry` to
 * `recordUserCountry`. The recording itself (throttle, dark without regions,
 * country only) is `voice/region-audience.test.ts`, on a real Postgres.
 */

const recorded = vi.hoisted(() => [] as Array<[string, string | null]>);

vi.mock("../voice/region-audience.js", () => ({
  recordUserCountry: async (userId: string, country: string | null) => {
    recorded.push([userId, country]);
    return true;
  },
}));

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  resolveAuthUser: async () => ({
    user: { id: "00000000-0000-4000-8000-0000000000aa", clerk_id: "clerk_aa" },
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
const { noteSocketCountry } = await import("../voice/regions.js");

describe("ws auth records the account's country", () => {
  it("passes the upgrade's CF-IPCountry for the authenticated account", async () => {
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
    noteSocketCountry(socket, { "cf-ipcountry": "gb" });
    handleWsConnection(socket, "test-region-country");
    handlers.get("message")?.(JSON.stringify({ type: "auth", token: "any" }) as never);
    await vi.waitFor(() => {
      expect(sent.some((raw) => raw.includes('"ready"'))).toBe(true);
    });
    expect(recorded).toEqual([["00000000-0000-4000-8000-0000000000aa", "GB"]]);
  });
});
