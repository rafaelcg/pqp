import { describe, expect, it, vi } from "vitest";
import {
  EARLY_END_WINDOW_MS,
  ELAPSED_BUCKETS,
  SHARE_AUDIO_STATES,
  SHARE_END_REASONS,
  SHARE_ENDED_EARLY_MIN_INTERVAL_MS,
  SHARE_PLATFORMS,
  SHARE_SURFACES,
  SHARE_TRANSPORTS,
  buildShareEndedEarly,
  createShareEndedEarlyReporter,
  elapsedBucket,
  reasonFromCaptureError,
  shareSurface,
  shareTransport,
  type ShareEndedEarlyPayload,
} from "./share-ended-early";

function named(name: string, message = ""): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

const GOOD: ShareEndedEarlyPayload = {
  reason: "track-ended",
  surface: "window",
  audio: "with",
  platform: "desktop",
  transport: "sfu",
  elapsedBucket: "2to5s",
};

describe("the ten second window", () => {
  it("buckets a share by how long it lived", () => {
    expect(elapsedBucket(0)).toBe("lt2s");
    expect(elapsedBucket(1_999)).toBe("lt2s");
    expect(elapsedBucket(2_000)).toBe("2to5s");
    expect(elapsedBucket(4_999)).toBe("2to5s");
    expect(elapsedBucket(5_000)).toBe("5to10s");
    expect(elapsedBucket(EARLY_END_WINDOW_MS - 1)).toBe("5to10s");
  });

  it("sends nothing for a share that lived ten seconds or more", () => {
    expect(elapsedBucket(EARLY_END_WINDOW_MS)).toBeNull();
    expect(elapsedBucket(60_000)).toBeNull();
    expect(elapsedBucket(Number.NaN)).toBeNull();
    expect(
      buildShareEndedEarly({
        startedAt: 1_000,
        endedAt: 1_000 + EARLY_END_WINDOW_MS,
        reason: "user-stopped",
      }),
    ).toBeNull();
    expect(
      buildShareEndedEarly({
        startedAt: 1_000,
        endedAt: 1_000 + EARLY_END_WINDOW_MS - 1,
        reason: "user-stopped",
      })?.elapsedBucket,
    ).toBe("5to10s");
  });

  it("treats a clock that ran backwards as the first bucket, not as a crash", () => {
    expect(
      buildShareEndedEarly({ startedAt: 5_000, endedAt: 4_000, reason: "unknown" })
        ?.elapsedBucket,
    ).toBe("lt2s");
  });
});

describe("the reason mapping", () => {
  it("passes every closed reason through and nothing else", () => {
    for (const reason of SHARE_END_REASONS) {
      expect(
        buildShareEndedEarly({ startedAt: 0, endedAt: 100, reason })?.reason,
      ).toBe(reason);
    }
    expect(
      buildShareEndedEarly({ startedAt: 0, endedAt: 100, reason: "Error: boom at C:\\Users\\x" })
        ?.reason,
    ).toBe("unknown");
  });

  it("maps the operating system refusing the capture", () => {
    expect(
      reasonFromCaptureError(named("NotAllowedError", "Permission denied by system")),
    ).toBe("permission-denied");
  });

  it("reports nothing for a person closing the picker", () => {
    expect(reasonFromCaptureError(named("NotAllowedError", "Permission denied"))).toBeNull();
    expect(reasonFromCaptureError(named("NotAllowedError"))).toBeNull();
  });

  it("maps every other capture failure to capture-failed", () => {
    expect(reasonFromCaptureError(named("NotReadableError", "Could not start video source"))).toBe(
      "capture-failed",
    );
    expect(reasonFromCaptureError(named("AbortError"))).toBe("capture-failed");
    expect(reasonFromCaptureError(new TypeError("x"))).toBe("capture-failed");
    expect(reasonFromCaptureError("a string, not an Error")).toBe("capture-failed");
    expect(reasonFromCaptureError(undefined)).toBe("capture-failed");
  });
});

describe("the closed fields", () => {
  it("names the surface from displaySurface", () => {
    expect(shareSurface("monitor")).toBe("screen");
    expect(shareSurface("window")).toBe("window");
    expect(shareSurface("browser")).toBe("tab");
    expect(shareSurface(undefined)).toBe("unknown");
    expect(shareSurface("something-new")).toBe("unknown");
    expect(shareSurface(42)).toBe("unknown");
  });

  it("names the transport the way the event does", () => {
    expect(shareTransport("livekit")).toBe("sfu");
    expect(shareTransport("mesh")).toBe("mesh");
    expect(shareTransport(null)).toBe("mesh");
  });

  it("never lets a free string out, whatever field it is handed in", () => {
    const hostile = "Netflix - Secret Plan (rafael@example.com) user 0000-1111 #general";
    const payload = buildShareEndedEarly({
      startedAt: 0,
      endedAt: 1_000,
      reason: hostile,
      surface: hostile,
      audio: hostile,
      platform: hostile,
      transport: hostile,
    });
    expect(payload).toEqual({
      reason: "unknown",
      surface: "unknown",
      audio: "without",
      platform: "web",
      transport: "mesh",
      elapsedBucket: "lt2s",
    });
    expect(JSON.stringify(payload)).not.toContain("Netflix");
    expect(JSON.stringify(payload)).not.toContain("rafael");
    // Exactly six keys, every value one of the enums.
    expect(Object.keys(payload!).sort()).toEqual(
      ["audio", "elapsedBucket", "platform", "reason", "surface", "transport"].sort(),
    );
    expect(SHARE_AUDIO_STATES).toContain(payload!.audio);
    expect(SHARE_PLATFORMS).toContain(payload!.platform);
    expect(SHARE_SURFACES).toContain(payload!.surface);
    expect(SHARE_TRANSPORTS).toContain(payload!.transport);
    expect(ELAPSED_BUCKETS).toContain(payload!.elapsedBucket);
  });

  it("does not forward an extra property a caller smuggles in", () => {
    const payload = buildShareEndedEarly({
      startedAt: 0,
      endedAt: 1_000,
      reason: "capture-failed",
      label: "screen:0:0 - My Bank",
      userId: "abc",
    } as never);
    expect(JSON.stringify(payload)).not.toContain("My Bank");
    expect(JSON.stringify(payload)).not.toContain("abc");
  });
});

describe("the reporter", () => {
  it("warns on the console and sends one event with the same fields", () => {
    const send = vi.fn();
    const warn = vi.fn();
    const report = createShareEndedEarlyReporter({ now: () => 0, send, warn });
    expect(report(GOOD)).toBe(true);
    expect(warn).toHaveBeenCalledWith("[pqp] screen share ended early", GOOD);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("share.endedEarly", GOOD);
  });

  it("does nothing for a share that was not early", () => {
    const send = vi.fn();
    const warn = vi.fn();
    const report = createShareEndedEarlyReporter({ now: () => 0, send, warn });
    expect(report(null)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("sends at most one event a minute per page, and the minute does not slide", () => {
    let now = 1_000_000;
    const send = vi.fn();
    const warn = vi.fn();
    const report = createShareEndedEarlyReporter({ now: () => now, send, warn });
    expect(report(GOOD)).toBe(true);
    now += 1_000;
    expect(report(GOOD)).toBe(false);
    now += SHARE_ENDED_EARLY_MIN_INTERVAL_MS - 2_000;
    expect(report(GOOD)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    // The console line is local and is not limited.
    expect(warn).toHaveBeenCalledTimes(3);
    now += 2_000;
    expect(report(GOOD)).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a share that is not early does not use up the minute", () => {
    const send = vi.fn();
    const report = createShareEndedEarlyReporter({
      now: () => 0,
      send,
      warn: () => {},
    });
    report(null);
    expect(report(GOOD)).toBe(true);
  });

  it("survives telemetry or the console throwing", () => {
    const report = createShareEndedEarlyReporter({
      now: () => 0,
      send: () => {
        throw new Error("collector down");
      },
      warn: () => {
        throw new Error("no console");
      },
    });
    expect(() => report(GOOD)).not.toThrow();
  });
});

describe("a self-host with no Faro URL", () => {
  it("reaches the default sink and sends nothing anywhere", async () => {
    // The default `send` is `reportFaroEvent`, which is a no-op until
    // `initFaro` has been given a URL. With none (every self-host build) there
    // is no Faro instance to push to, so the event dies in the SDK seam.
    const { initFaro, resetFaroForTests } = await import("./faro");
    resetFaroForTests();
    const initialize = vi.fn();
    expect(initFaro({ env: {}, initialize: initialize as never })).toBeNull();
    const warn = vi.fn();
    const report = createShareEndedEarlyReporter({ now: () => 0, warn });
    expect(() => report(GOOD)).not.toThrow();
    expect(initialize).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("on the hosted build pushes the event to Faro with string attributes only", async () => {
    const { initFaro, resetFaroForTests } = await import("./faro");
    resetFaroForTests();
    const pushEvent = vi.fn();
    initFaro({
      env: { VITE_FARO_URL: "https://collector.example/x" },
      initialize: (() => ({ api: { pushEvent } })) as never,
    });
    const report = createShareEndedEarlyReporter({ now: () => 0, warn: () => {} });
    report(GOOD);
    expect(pushEvent).toHaveBeenCalledWith("share.endedEarly", GOOD);
    for (const value of Object.values(pushEvent.mock.calls[0]![1] as Record<string, unknown>)) {
      expect(typeof value).toBe("string");
    }
    resetFaroForTests();
  });
});
