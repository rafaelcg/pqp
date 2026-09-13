import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAudioConstraints,
  defaultMicProcessing,
  sameMicProcessing,
  listAudioDevices,
} from "./audio-devices";

describe("listAudioDevices", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("includes cameras alongside mics and speakers", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: async () => [
          { kind: "audioinput", deviceId: "mic-1", label: "Built-in Mic" },
          { kind: "videoinput", deviceId: "cam-1", label: "FaceTime HD" },
          { kind: "videoinput", deviceId: "cam-2", label: "" },
          { kind: "videoinput", deviceId: "", label: "Hidden until permission" },
          { kind: "audiooutput", deviceId: "spk-1", label: "Speakers" },
        ],
      },
    });
    const listed = await listAudioDevices();
    expect(listed.inputs).toEqual([
      { deviceId: "mic-1", label: "Built-in Mic" },
    ]);
    expect(listed.cameras).toEqual([
      { deviceId: "cam-1", label: "FaceTime HD" },
      { deviceId: "cam-2", label: "Camera 1" },
    ]);
    expect(listed.outputs).toEqual([
      { deviceId: "spk-1", label: "Speakers" },
    ]);
  });
});

describe("buildAudioConstraints", () => {
  it("asks the browser to suppress in browser mode", () => {
    expect(
      buildAudioConstraints(undefined, {
        ...defaultMicProcessing,
        noiseSuppression: "browser",
      }),
    ).toMatchObject({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
  });

  it("asks for nothing in off mode", () => {
    expect(
      buildAudioConstraints(undefined, {
        ...defaultMicProcessing,
        noiseSuppression: "off",
      }),
    ).toMatchObject({ noiseSuppression: false });
  });

  it("asks for nothing in ADVANCED mode either, so the two never stack", () => {
    // RNNoise runs on the raw capture. Letting the browser suppress first
    // would hand the model a signal unlike anything it was trained on, and
    // the pair sounds worse than either suppressor alone.
    expect(
      buildAudioConstraints(undefined, {
        ...defaultMicProcessing,
        noiseSuppression: "advanced",
      }),
    ).toMatchObject({ noiseSuppression: false });
  });

  it("still names the device when one is chosen", () => {
    expect(
      buildAudioConstraints("mic-1", {
        ...defaultMicProcessing,
        noiseSuppression: "advanced",
      }),
    ).toMatchObject({ deviceId: { exact: "mic-1" } });
  });

  it("defaults to the browser suppressor, so the new mode ships off", () => {
    expect(defaultMicProcessing.noiseSuppression).toBe("browser");
    expect(buildAudioConstraints(undefined)).toMatchObject({
      noiseSuppression: true,
    });
  });
});

describe("sameMicProcessing", () => {
  it("tells the three modes apart, so switching re-opens the mic", () => {
    const base = { ...defaultMicProcessing, noiseSuppression: "browser" as const };
    expect(sameMicProcessing(base, { ...base })).toBe(true);
    expect(
      sameMicProcessing(base, { ...base, noiseSuppression: "advanced" }),
    ).toBe(false);
    expect(sameMicProcessing(base, { ...base, noiseSuppression: "off" })).toBe(
      false,
    );
  });
});
