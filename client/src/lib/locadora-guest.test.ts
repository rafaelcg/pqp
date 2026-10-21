import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCADORA_GUEST_EVENTS,
  UPSELL_DISMISS_MS,
  UPSELL_EJECT_AFTER_MS,
  UPSELL_IDLE_MS,
  UPSELL_PAUSE_AFTER_MS,
  UPSELL_SHOW_EVERY_MS,
  UpsellMoments,
  guestRuntimeOf,
  hasCartridge,
  holdCartridge,
  takeCartridge,
  rememberUpsellDismissed,
  rememberUpsellShown,
  trackLocadoraGuest,
  upsellAllowed,
} from "./locadora-guest";

function memory() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

const MIN = 60_000;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the cartridge from the door", () => {
  it("is held in memory for one taking, and nothing is written anywhere", () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem, getItem: () => null, removeItem: () => {} });
    vi.stubGlobal("sessionStorage", { setItem, getItem: () => null, removeItem: () => {} });
    expect(hasCartridge()).toBe(false);
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    holdCartridge({ bytes, ext: ".sfc" });
    expect(hasCartridge()).toBe(true);
    expect(takeCartridge()).toEqual({ bytes, ext: ".sfc" });
    expect(takeCartridge()).toBeNull();
    expect(hasCartridge()).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
  });
});

describe("the sign-up card's moments", () => {
  it("never shows while a game runs, and a pause shows it only after five minutes of play", () => {
    const m = new UpsellMoments(0);
    expect(m.activity("playing", 0)).toBe("hide");
    expect(m.activity("paused", 4 * MIN)).toBeNull();
    expect(m.activity("playing", 4 * MIN + 1)).toBe("hide");
    expect(m.activity("paused", UPSELL_PAUSE_AFTER_MS + 10)).toBe("show");
    // once per visit
    expect(m.activity("playing", UPSELL_PAUSE_AFTER_MS + 20)).toBe("hide");
    expect(m.activity("paused", 20 * MIN)).toBeNull();
  });

  it("an eject after real play shows it; a quick look does not", () => {
    const quick = new UpsellMoments(0);
    quick.activity("playing", 0);
    expect(quick.activity("browsing", UPSELL_EJECT_AFTER_MS - 1)).toBeNull();
    const real = new UpsellMoments(0);
    real.activity("playing", 0);
    expect(real.activity("browsing", UPSELL_EJECT_AFTER_MS + 1)).toBe("show");
  });

  it("an idle frame after play shows it; an idle frame that never played does not", () => {
    const never = new UpsellMoments(0);
    expect(never.tick(10 * MIN)).toBeNull();
    const m = new UpsellMoments(0);
    m.activity("playing", 0);
    m.activity("paused", 1000);
    expect(m.tick(1000 + UPSELL_IDLE_MS - 1)).toBeNull();
    expect(m.tick(1000 + UPSELL_IDLE_MS)).toBe("show");
    expect(m.tick(1000 + 2 * UPSELL_IDLE_MS)).toBeNull();
  });

  it("the idle clock never counts a running game", () => {
    const m = new UpsellMoments(0);
    m.activity("playing", 0);
    expect(m.tick(30 * MIN)).toBeNull();
  });
});

describe("once a day per device, and Agora não is remembered", () => {
  it("allows, then waits a day after showing", () => {
    const local = memory();
    expect(upsellAllowed(local, 0)).toBe(true);
    rememberUpsellShown(local, 10);
    expect(upsellAllowed(local, 10 + UPSELL_SHOW_EVERY_MS - 1)).toBe(false);
    expect(upsellAllowed(local, 10 + UPSELL_SHOW_EVERY_MS)).toBe(true);
  });

  it("Agora não keeps it away for a week", () => {
    const local = memory();
    rememberUpsellShown(local, 0);
    rememberUpsellDismissed(local, 0);
    expect(upsellAllowed(local, UPSELL_SHOW_EVERY_MS + 1)).toBe(false);
    expect(upsellAllowed(local, UPSELL_DISMISS_MS)).toBe(true);
  });

  it("a corrupt memory is no memory", () => {
    const local = memory();
    local.setItem("pqp:locadora-guest-upsell", "{nope");
    expect(upsellAllowed(local, 0)).toBe(true);
  });
});

describe("measurement", () => {
  it("is three closed names with no properties", () => {
    const calls: unknown[][] = [];
    vi.stubGlobal("window", { umami: { track: (...args: unknown[]) => calls.push(args) } });
    for (const event of Object.values(LOCADORA_GUEST_EVENTS)) trackLocadoraGuest(event);
    expect(calls).toEqual([
      ["locadora_guest_start", undefined],
      ["locadora_guest_upsell_shown", undefined],
      ["locadora_guest_signup_click", undefined],
    ]);
  });
});

describe("the runtime the frame host gets", () => {
  it("never shares, carries the manifest's caps, and copies the assets", () => {
    const app = {
      id: "pqp-locadora",
      version: "1.0.1",
      entry: { url: "https://apps.example/pqp-locadora/1.0.1/index.html" },
      capabilities: {
        identity: "display" as const,
        share: "pane" as const,
        localFiles: { allowed: true, accept: [".nes"], maxBytes: 9 },
        deviceStore: { allowed: true, maxBytes: 99 },
        peer: "none" as const,
      },
      state: { maxBytes: 0, maxWritesPerSecond: 1, writers: "participants" as const },
      events: { maxPerSecond: 0, maxBytes: 0 },
      assets: [{ name: "core", url: "https://apps.example/x", sha256: "a".repeat(64), bytes: 3 }],
    };
    const runtime = guestRuntimeOf(app);
    expect(runtime.shareAllowed).toBe(false);
    expect(runtime.capabilities).toEqual({ share: "pane", localFiles: app.capabilities.localFiles, deviceStore: app.capabilities.deviceStore });
    expect(runtime.state).toEqual(app.state);
    expect(runtime.assets).toEqual(app.assets);
    expect(runtime.assets![0]).not.toBe(app.assets[0]);
  });
});
