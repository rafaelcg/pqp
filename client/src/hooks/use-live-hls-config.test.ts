import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchLiveHlsConfigMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
  fetchLiveHlsConfig: (...args: unknown[]) => fetchLiveHlsConfigMock(...args),
}));

const { loadLiveHlsConfig, resetLiveHlsConfigCache } = await import(
  "./use-live-hls-config"
);

describe("loadLiveHlsConfig", () => {
  beforeEach(() => {
    resetLiveHlsConfigCache();
    fetchLiveHlsConfigMock.mockReset();
  });

  it("asks once per server and passes the server id along", async () => {
    fetchLiveHlsConfigMock.mockResolvedValue({ enabled: true, delaySeconds: 10 });
    await loadLiveHlsConfig("s1");
    await loadLiveHlsConfig("s1");
    await loadLiveHlsConfig("s2");
    expect(fetchLiveHlsConfigMock.mock.calls).toEqual([["s1"], ["s2"]]);
  });

  it("does not cache a failure", async () => {
    fetchLiveHlsConfigMock.mockRejectedValueOnce(new Error("down"));
    await expect(loadLiveHlsConfig("s1")).rejects.toThrow("down");
    fetchLiveHlsConfigMock.mockResolvedValue({ enabled: false, delaySeconds: 10 });
    await expect(loadLiveHlsConfig("s1")).resolves.toEqual({
      enabled: false,
      delaySeconds: 10,
    });
  });
});
