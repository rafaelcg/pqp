import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchCommunityHomeConfig = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchCommunityHomeConfig: (serverId?: string) =>
    fetchCommunityHomeConfig(serverId),
}));

const { loadCommunityHomeVipEnabled } = await import("./config");

describe("loadCommunityHomeVipEnabled", () => {
  beforeEach(() => {
    fetchCommunityHomeConfig.mockReset();
  });

  it("asks with the server and answers its own VIP switch", async () => {
    fetchCommunityHomeConfig.mockResolvedValue({
      enabled: true,
      vipEnabled: true,
      mediaEnabled: false,
    });
    expect(await loadCommunityHomeVipEnabled("srv-1")).toBe(true);
    expect(fetchCommunityHomeConfig).toHaveBeenCalledWith("srv-1");
  });

  it("is off when the Baú is off, even if the VIP switch says on", async () => {
    fetchCommunityHomeConfig.mockResolvedValue({
      enabled: false,
      vipEnabled: true,
      mediaEnabled: false,
    });
    expect(await loadCommunityHomeVipEnabled("srv-1")).toBe(false);
  });

  it("is off on any failure", async () => {
    fetchCommunityHomeConfig.mockImplementation(() =>
      Promise.reject(new Error("offline")),
    );
    expect(await loadCommunityHomeVipEnabled("srv-1")).toBe(false);
  });
});
