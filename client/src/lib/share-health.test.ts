import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("collectShareHealth", () => {
  it("says there is nothing to read when no share is live", async () => {
    expect(await collectShareHealth(0)).toBeNull();
    expect(formatShareHealth(null)).toContain("no screen share is live");
  });

  it("reads two samples and reports what the capture and the encoder did between them", async () => {
    setShareHealthSource(source());
    const report = await collectShareHealth(0);
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
