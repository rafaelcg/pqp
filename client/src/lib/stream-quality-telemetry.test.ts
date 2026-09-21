import { afterEach, describe, expect, it, vi } from "vitest";
import {
  presenterSamplesFromSnapshot,
  sendStreamQualityTelemetry,
  viewerSamplesFromSnapshot,
} from "./stream-quality-telemetry";
import type { VideoReceiverSample, VideoSenderSample } from "./voice-stats-probe";

vi.mock("./utils", () => ({ getApiBaseUrl: () => "https://api.test" }));

const baseSender: VideoSenderSample = {
  peerId: "peer-1",
  role: "screen",
  width: 1280,
  height: 720,
  fps: 6,
  kbps: 350,
  targetKbps: 400,
  limitedBy: "bandwidth",
  ceilingKbps: 2_500,
  limitDurations: null,
  encoder: "libvpx",
  framesEncoded: 100,
  framesSent: 100,
  keyFramesEncoded: 2,
  pliCount: 0,
  nackCount: 0,
};

const baseReceiver: VideoReceiverSample = {
  peerId: "peer-2",
  displayName: "Someone",
  role: "screen",
  width: 1280,
  height: 720,
  fps: 8,
  kbps: 400,
  framesDecoded: 200,
  decoder: "libvpx",
  freezeCount: 0,
  packetsLost: 0,
};

describe("presenterSamplesFromSnapshot", () => {
  it("turns an encoding screen sender into a presenter sample, deltas and all", () => {
    const samples = presenterSamplesFromSnapshot([baseSender], "mesh");
    expect(samples).toHaveLength(1);
    expect(samples[0]).toEqual({
      role: "presenter",
      transport: "mesh",
      fps: 6,
      kbps: 350,
      width: 1280,
      height: 720,
      qualityLimitationReason: "bandwidth",
    });
  });

  it("ignores a camera row -- only screen rows are this feature's business", () => {
    const camera: VideoSenderSample = { ...baseSender, role: "camera" };
    expect(presenterSamplesFromSnapshot([camera], "mesh")).toEqual([]);
  });

  it("ignores a paused simulcast layer (qualityLimitationReason set, but 0 fps and 0 kbps)", () => {
    const paused: VideoSenderSample = { ...baseSender, fps: 0, kbps: 0 };
    expect(presenterSamplesFromSnapshot([paused], "livekit")).toEqual([]);
  });

  it("omits fields the browser did not report rather than inventing them", () => {
    const sparse: VideoSenderSample = {
      ...baseSender,
      width: null,
      height: null,
      limitedBy: null,
    };
    const [sample] = presenterSamplesFromSnapshot([sparse], "mesh");
    expect(sample).toEqual({
      role: "presenter",
      transport: "mesh",
      fps: 6,
      kbps: 350,
    });
    expect(sample).not.toHaveProperty("width");
    expect(sample).not.toHaveProperty("qualityLimitationReason");
  });

  it("drops an unrecognised limitation reason rather than passing it through unfiltered", () => {
    const weird: VideoSenderSample = { ...baseSender, limitedBy: "some-future-value" };
    const [sample] = presenterSamplesFromSnapshot([weird], "mesh");
    expect(sample).not.toHaveProperty("qualityLimitationReason");
  });

  it("reports every currently-encoding screen sender, e.g. two simultaneous shares", () => {
    const second: VideoSenderSample = { ...baseSender, peerId: "peer-3", fps: 30, kbps: 3_000 };
    const samples = presenterSamplesFromSnapshot([baseSender, second], "mesh");
    expect(samples).toHaveLength(2);
    expect(samples.map((s) => s.fps)).toEqual([6, 30]);
  });
});

describe("viewerSamplesFromSnapshot", () => {
  it("turns an inbound screen row into a viewer sample, with no limitation reason field at all", () => {
    const samples = viewerSamplesFromSnapshot([baseReceiver], "livekit");
    expect(samples).toEqual([
      {
        role: "viewer",
        transport: "livekit",
        fps: 8,
        kbps: 400,
        width: 1280,
        height: 720,
      },
    ]);
  });

  it("ignores a camera receiver row", () => {
    const camera: VideoReceiverSample = { ...baseReceiver, role: "camera" };
    expect(viewerSamplesFromSnapshot([camera], "mesh")).toEqual([]);
  });

  it("still reports a row with 0 fps -- that is exactly the choppy-share signal this exists to catch", () => {
    const frozen: VideoReceiverSample = { ...baseReceiver, fps: 0 };
    const [sample] = viewerSamplesFromSnapshot([frozen], "mesh");
    expect(sample!.fps).toBe(0);
  });
});

describe("sendStreamQualityTelemetry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to the telemetry route with a Bearer token when one is given", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    sendStreamQualityTelemetry(
      { samples: [{ role: "presenter", transport: "mesh", fps: 6 }] },
      "tok_123",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.test/api/stream-quality/telemetry");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok_123");
    expect(JSON.parse(init.body)).toEqual({
      samples: [{ role: "presenter", transport: "mesh", fps: 6 }],
    });
  });

  it("sends no Authorization header when there is no token yet", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    sendStreamQualityTelemetry(
      { samples: [{ role: "viewer", transport: "livekit" }] },
      null,
    );

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("never issues a request for an empty batch", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    sendStreamQualityTelemetry({ samples: [] }, "tok_123");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is fire-and-forget: a rejected fetch never throws out of this function", () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    expect(() =>
      sendStreamQualityTelemetry(
        { samples: [{ role: "presenter", transport: "mesh" }] },
        null,
      ),
    ).not.toThrow();
  });
});
