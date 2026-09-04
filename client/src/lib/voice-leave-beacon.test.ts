import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiBase = vi.hoisted(() => ({ value: "https://api.example.test" }));

vi.mock("./utils", () => ({
  getApiBaseUrl: () => apiBase.value,
}));

const { beaconVoiceLeave } = await import("./voice-leave-beacon");

describe("beaconVoiceLeave", () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

  beforeEach(() => {
    apiBase.value = "https://api.example.test";
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefers sendBeacon with a text/plain body", () => {
    const sendBeacon = vi.fn((_url: string, _data?: Blob) => true);
    vi.stubGlobal("navigator", { sendBeacon });

    beaconVoiceLeave({
      resumePeerId: "00000000-0000-4000-8000-000000000001",
      resumeToken: "tok",
    });

    expect(sendBeacon).toHaveBeenCalledWith(
      "https://api.example.test/api/voice/leave",
      expect.any(Blob),
    );
    const blob = sendBeacon.mock.calls[0][1];
    expect(blob?.type).toBe("text/plain");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to keepalive fetch when sendBeacon refuses", () => {
    vi.stubGlobal("navigator", { sendBeacon: () => false });

    beaconVoiceLeave({
      resumePeerId: "00000000-0000-4000-8000-000000000001",
      resumeToken: "tok",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/voice/leave",
      expect.objectContaining({
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "text/plain" },
      }),
    );
  });

  it("posts to a relative URL when the API is same-origin", () => {
    apiBase.value = "";
    const sendBeacon = vi.fn((_url: string, _data?: Blob) => true);
    vi.stubGlobal("navigator", { sendBeacon });

    beaconVoiceLeave({
      resumePeerId: "00000000-0000-4000-8000-000000000001",
      resumeToken: "tok",
    });

    expect(sendBeacon).toHaveBeenCalledWith(
      "/api/voice/leave",
      expect.any(Blob),
    );
  });
});
