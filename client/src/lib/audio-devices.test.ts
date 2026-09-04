import { afterEach, describe, expect, it, vi } from "vitest";
import { listAudioDevices } from "./audio-devices";

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
