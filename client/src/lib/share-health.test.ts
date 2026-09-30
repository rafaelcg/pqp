import { afterEach, describe, expect, it, vi } from "vitest";
import { h264ProfileOf } from "./share-high-motion-guard";
import {
  classifyEncoder,
  collectShareHealth,
  formatShareHealth,
  installShareHealth,
  setShareHealthSource,
  type ShareHealthSource,
} from "./share-health";

function outbound(frames: number, encodeSeconds: number, bytes: number) {
  return new Map<string, unknown>([
    [
      "out",
      {
        id: "out",
        type: "outbound-rtp",
        kind: "video",
        frameWidth: 1920,
        frameHeight: 1080,
        framesPerSecond: 58,
        framesEncoded: frames,
        totalEncodeTime: encodeSeconds,
        bytesSent: bytes,
        targetBitrate: 4_000_000,
        qualityLimitationReason: "cpu",
        encoderImplementation: "OpenH264",
        mediaSourceId: "src",
        codecId: "cdc",
      },
    ],
    ["src", { id: "src", type: "media-source", kind: "video", framesPerSecond: 31 }],
    ["cdc", { id: "cdc", type: "codec", mimeType: "video/H264" }],
  ]);
}

function source(over: Partial<ShareHealthSource> = {}): ShareHealthSource {
  let call = 0;
  return {
    transport: "sfu",
    guardEnabled: false,
    track: () =>
      ({ getSettings: () => ({ frameRate: 60, width: 1920, height: 1080 }) }) as MediaStreamTrack,
    readReports: async () => {
      call += 1;
      return [call === 1 ? outbound(1000, 10, 1_000_000) : outbound(1060, 10.9, 1_500_000)];
    },
    guard: () => null,
    captureCheck: () => ({ requested: 60, reported: 144, enforced: true, after: 60 }),
    ...over,
  };
}

afterEach(() => {
  setShareHealthSource(null);
  vi.unstubAllGlobals();
});

describe("classifyEncoder", () => {
  it("trusts the browser's own power-efficient flag first", () => {
    expect(classifyEncoder("OpenH264", true)).toBe(true);
    expect(classifyEncoder("MediaFoundationVideoEncodeAccelerator", false)).toBe(false);
  });

  it("reads a software encoder off its name, and says nothing when it has none", () => {
    expect(classifyEncoder("OpenH264", null)).toBe(false);
    expect(classifyEncoder("libvpx", null)).toBe(false);
    expect(classifyEncoder("ExternalEncoder (MediaFoundationVideoEncodeAccelerator)", null)).toBe(true);
    expect(classifyEncoder(null, null)).toBeNull();
  });
});

describe("an SFU share as LiveKit negotiates it", () => {
  function layered(frames: number, encodeSeconds: number) {
    const layer = (rid: string, width: number, height: number): [string, unknown] => [
      `out-${rid}`,
      {
        id: `out-${rid}`,
        type: "outbound-rtp",
        kind: "video",
        rid,
        frameWidth: width,
        frameHeight: height,
        framesPerSecond: 60,
        framesEncoded: frames,
        totalEncodeTime: encodeSeconds,
        bytesSent: frames * 1000,
        targetBitrate: 2_000_000,
        qualityLimitationReason: "none",
        encoderImplementation: "SimulcastEncoderAdapter (OpenH264, OpenH264, OpenH264)",
        codecId: "cdc",
      },
    ];
    return new Map<string, unknown>([
      layer("q", 640, 360),
      layer("h", 1280, 720),
      layer("f", 1920, 1080),
      ["cdc", { id: "cdc", type: "codec", mimeType: "video/H264", sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f" }],
    ]);
  }

  it("says it is three software encodes on constrained baseline, from the stats and not an assumption", async () => {
    let call = 0;
    setShareHealthSource(
      source({
        readReports: async () => {
          call += 1;
          return [call === 1 ? layered(1000, 10) : layered(1060, 10.6)];
        },
      }),
    );
    const report = await collectShareHealth(5);
    expect(report).toMatchObject({
      encodes: 3,
      h264Profile: "42e01f (constrained baseline)",
      hardwareEncode: false,
    });
    const text = formatShareHealth(report);
    expect(text).toContain("profile 42e01f (constrained baseline), 3 encodes running");
    expect(text).toContain("software");
  });

  it("names the profiles it knows and stays quiet about one it does not", () => {
    expect(h264ProfileOf("profile-level-id=64001f")).toBe("64001f (high)");
    expect(h264ProfileOf("profile-level-id=4d001f")).toBe("4d001f (main)");
    expect(h264ProfileOf("packetization-mode=1")).toBeNull();
    expect(h264ProfileOf(null)).toBeNull();
  });
});

describe("collectShareHealth", () => {
  it("says there is nothing to read when no share is live", async () => {
    expect(await collectShareHealth(0)).toBeNull();
    expect(formatShareHealth(null)).toContain("no screen share is live");
  });

  it("reads two samples and reports what the capture and the encoder did between them", async () => {
    setShareHealthSource(source());
    const report = await collectShareHealth(5);
    expect(report).toMatchObject({
      transport: "sfu",
      codec: "video/H264",
      encoder: "OpenH264",
      hardwareEncode: false,
      captureFps: 31,
      requestedFps: 60,
      limitedBy: "cpu",
      width: 1920,
      height: 1080,
      targetKbps: 4000,
      guard: { enabled: false },
    });
    // 60 frames in 0.9 s of encoding: 15 ms a frame.
    expect(report?.encodeMs).toBeCloseTo(15, 5);
    expect(report?.captureCheck).toMatchObject({ enforced: true, reported: 144, after: 60 });
  });

  it("reports the rate that was asked for, not the capture's current setting", async () => {
    setShareHealthSource(
      source({
        track: () =>
          ({ getSettings: () => ({ frameRate: 30, width: 1280, height: 720 }) }) as MediaStreamTrack,
        captureCheck: () => ({ requested: 60, reported: 60, enforced: false, after: 60 }),
      }),
    );
    const report = await collectShareHealth(0);
    expect(report?.requestedFps).toBe(60);
    expect(report?.trackSettings.frameRate).toBe(30);
  });

  it("returns a partial report when the stats cannot be read", async () => {
    setShareHealthSource(
      source({
        readReports: async () => {
          throw new Error("transport closed");
        },
      }),
    );
    const report = await collectShareHealth(0);
    expect(report).toMatchObject({ transport: "sfu", encoder: null, sentFps: null });
  });

  it("includes the shell's half when the desktop bridge answers", async () => {
    vi.stubGlobal("window", {
      pqpDesktop: {
        isElectron: true,
        platform: "win32",
        shareHealth: async () => ({
          platform: "win32",
          versions: { electron: "44.0.0", chrome: "146.0.0.0" },
          gpu: {
            videoEncode: "enabled",
            videoDecode: "enabled",
            gpuCompositing: "enabled",
            hardwareVideoEncode: true,
            status: null,
          },
          priority: { live: true, boost: "raised", processes: 3 },
        }),
      },
    });
    setShareHealthSource(source());
    const report = await collectShareHealth(0);
    const text = formatShareHealth(report);
    expect(text).toContain("video_encode enabled");
    expect(text).toContain("raised, 3 processes");
    expect(text).toContain("re-applied -> 60.0");
    expect(text).toContain("OpenH264");
    expect(text).toContain("software");
  });

  it("does not fail when the shell cannot answer", async () => {
    vi.stubGlobal("window", {
      pqpDesktop: {
        isElectron: true,
        shareHealth: async () => {
          throw new Error("ipc closed");
        },
      },
    });
    setShareHealthSource(source());
    expect((await collectShareHealth(0))?.shell).toBeNull();
  });
});

describe("installShareHealth", () => {
  it("installs the console helper once and never over another one", () => {
    const fake = { existing: true };
    const target: Record<string, unknown> = {};
    vi.stubGlobal("window", target);
    installShareHealth();
    expect(typeof target.pqpShareHealth).toBe("function");
    const first = target.pqpShareHealth;
    installShareHealth();
    expect(target.pqpShareHealth).toBe(first);
    target.pqpShareHealth = fake;
    installShareHealth();
    expect(target.pqpShareHealth).toBe(fake);
  });

  it("force reports plainly when the guard is not running", async () => {
    const target: Record<string, unknown> = {};
    vi.stubGlobal("window", target);
    installShareHealth();
    const api = target.pqpShareHealth as { force: (n: number | null) => Promise<string> };
    expect(await api.force(2)).toContain("not running");
  });
});
