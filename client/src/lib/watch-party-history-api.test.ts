import { afterEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("./api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import {
  fetchWatchPartyHistoryDownloads,
  fetchWatchPartyHistoryReplay,
} from "./watch-party-history-api";

afterEach(() => {
  apiFetch.mockReset();
});

describe("fetchWatchPartyHistoryReplay", () => {
  it("resolves the API-relative replay path against the API origin, so hls.js never asks the SPA host for it", async () => {
    apiFetch.mockResolvedValueOnce({
      hlsUrl: "/api/voice/hls-replay/c1/1789327315453?t=tok",
    });
    const res = await fetchWatchPartyHistoryReplay("c1", "1789327315453");
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/channels/c1/watch-party/history/1789327315453/replay",
    );
    expect(res.hlsUrl).toBe(
      `${import.meta.env.VITE_API_URL ?? ""}/api/voice/hls-replay/c1/1789327315453?t=tok`,
    );
    // The point of the test: the src must not start with the bare path.
    expect(res.hlsUrl.startsWith("/api/")).toBe(
      (import.meta.env.VITE_API_URL ?? "") === "",
    );
  });

  it("leaves an already absolute URL alone", async () => {
    apiFetch.mockResolvedValueOnce({
      hlsUrl: "https://api.test/api/voice/hls-replay/c1/1?t=tok",
    });
    const res = await fetchWatchPartyHistoryReplay("c1", "1");
    expect(res.hlsUrl).toBe("https://api.test/api/voice/hls-replay/c1/1?t=tok");
  });
});

describe("fetchWatchPartyHistoryDownloads", () => {
  it("passes on the kinds being prepared, and only ones with no file yet", async () => {
    apiFetch.mockResolvedValueOnce({
      downloads: {
        film: null,
        camera: { bytes: 10, url: "/api/channels/c1/watch-party/history/1/download/camera?t=x" },
        voice: null,
      },
      preparing: ["film", "camera", "nonsense"],
    });
    const res = await fetchWatchPartyHistoryDownloads("c1", "1");
    expect(res.preparing).toEqual(["film"]);
    expect(res.downloads.camera?.bytes).toBe(10);
  });

  it("reads an older server's answer, which has no preparing field", async () => {
    apiFetch.mockResolvedValueOnce({ downloads: { film: null, camera: null, voice: null } });
    const res = await fetchWatchPartyHistoryDownloads("c1", "1");
    expect(res.preparing).toEqual([]);
  });
});
