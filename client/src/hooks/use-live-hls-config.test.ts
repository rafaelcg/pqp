import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchLiveHlsConfigMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
  fetchLiveHlsConfig: (...args: unknown[]) => fetchLiveHlsConfigMock(...args),
}));

const {
  loadLiveHlsConfig,
  resetLiveHlsConfigCache,
  settledLiveHlsConfig,
  useLiveHlsConfig,
} = await import("./use-live-hls-config");
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

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

  it("hands a surface that mounts after the answer arrived the config on its first render", async () => {
    // Production rehearsal C, 2026-09-25: the setup card's "Baixa latência
    // (beta)" row drew a frame after the rest of the card, because an answer
    // already in hand could only be read on a later tick.
    const config = { enabled: true, delaySeconds: 10, lowLatency: { available: true } };
    fetchLiveHlsConfigMock.mockResolvedValue(config);
    expect(settledLiveHlsConfig("s1")).toBeNull();
    await loadLiveHlsConfig("s1");
    expect(settledLiveHlsConfig("s1")).toEqual(config);

    let firstRender: unknown = "never rendered";
    function Probe() {
      const seen = useLiveHlsConfig("s1");
      if (firstRender === "never rendered") {
        firstRender = seen;
      }
      return null;
    }
    renderToStaticMarkup(createElement(Probe));
    expect(firstRender).toEqual(config);
    expect(settledLiveHlsConfig(null)).toBeNull();
  });
});
