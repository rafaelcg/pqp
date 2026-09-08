import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { gateScreenShareStart } from "./screen-share-gate";

describe("gateScreenShareStart", () => {
  const request = { audio: true, intent: { preferBrowserTab: true } };

  it("starts straight away for a DM (no server)", async () => {
    const start = vi.fn();
    const ask = vi.fn();
    const checkNeedsAck = vi.fn();
    await expect(
      gateScreenShareStart({
        request,
        serverId: null,
        hlsEnabled: null,
        checkNeedsAck,
        start,
        ask,
      }),
    ).resolves.toBe("started");
    expect(start).toHaveBeenCalledWith(request);
    expect(checkNeedsAck).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it("starts without asking when the server cannot go out as HLS", async () => {
    const start = vi.fn();
    const checkNeedsAck = vi.fn();
    await gateScreenShareStart({
      request,
      serverId: "srv",
      hlsEnabled: false,
      checkNeedsAck,
      start,
      ask: vi.fn(),
    });
    expect(start).toHaveBeenCalledWith(request);
    expect(checkNeedsAck).not.toHaveBeenCalled();
  });

  it("asks first, carrying the same intent, when the host has not acknowledged", async () => {
    const start = vi.fn();
    const ask = vi.fn();
    await expect(
      gateScreenShareStart({
        request,
        serverId: "srv",
        hlsEnabled: true,
        checkNeedsAck: async () => true,
        start,
        ask,
      }),
    ).resolves.toBe("asked");
    expect(ask).toHaveBeenCalledWith("srv", request);
    expect(start).not.toHaveBeenCalled();
  });

  it("treats an unanswered config as 'ask', never as 'skip'", async () => {
    const ask = vi.fn();
    await gateScreenShareStart({
      request,
      serverId: "srv",
      hlsEnabled: null,
      checkNeedsAck: async () => true,
      start: vi.fn(),
      ask,
    });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("starts once acknowledged", async () => {
    const start = vi.fn();
    await gateScreenShareStart({
      request,
      serverId: "srv",
      hlsEnabled: true,
      checkNeedsAck: async () => false,
      start,
      ask: vi.fn(),
    });
    expect(start).toHaveBeenCalledWith(request);
  });
});

/**
 * The regression itself: `App.tsx` must not start a share behind the gate's
 * back. Every `voice.startScreenShare(` in the file has to live inside the
 * gate's own `start` callback. A source scan is crude, but it is exactly
 * the check a reviewer did by hand when the bypass was found, and it fails
 * the moment someone adds a fifth direct call.
 */
describe("App.tsx routes every share start through the gate", () => {
  it("has exactly one direct voice.startScreenShare call, inside startScreenShareGated", () => {
    const source = readFileSync(
      new URL("../App.tsx", import.meta.url),
      "utf8",
    );
    const direct = source.match(/voice\.startScreenShare\(/g) ?? [];
    expect(direct).toHaveLength(1);
    const gateStart = source.indexOf("const startScreenShareGated");
    const gateEnd = source.indexOf("const perms = usePermissions", gateStart);
    const call = source.indexOf("voice.startScreenShare(");
    expect(call).toBeGreaterThan(gateStart);
    expect(call).toBeLessThan(gateEnd);
  });
});
