// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchForumConfigMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
  fetchForumConfig: (...args: unknown[]) => fetchForumConfigMock(...args),
}));

const {
  FORUM_CONFIG_RETRY_MS,
  loadForumConfig,
  resetForumConfigForTests,
  settledForumConfig,
  useForumConfig,
} = await import("./use-forum-config");
const { requestConfigRefresh, resetConfigRefreshForTests } = await import(
  "@/lib/config-refresh"
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;
const seen: Array<{ enabled: boolean; loaded: boolean }> = [];

function Probe({ serverId }: { serverId: string | null }) {
  seen.push(useForumConfig(serverId));
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  resetForumConfigForTests();
  resetConfigRefreshForTests();
  fetchForumConfigMock.mockReset();
  seen.length = 0;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(serverId: string | null) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Probe serverId={serverId} />));
}

describe("useForumConfig", () => {
  it("is off and not loaded until the server answers, then follows the answer", async () => {
    fetchForumConfigMock.mockResolvedValue({ enabled: true });
    mount("s1");
    expect(seen[0]).toEqual({ enabled: false, loaded: false });
    await flush();
    expect(seen.at(-1)).toEqual({ enabled: true, loaded: true });
    expect(fetchForumConfigMock).toHaveBeenCalledWith("s1");
  });

  it("reads an API that predates the route (404) as a real answer: off", async () => {
    fetchForumConfigMock.mockRejectedValue(
      Object.assign(new Error("Not found"), { status: 404 }),
    );
    mount("s1");
    await flush();
    expect(seen.at(-1)).toEqual({ enabled: false, loaded: true });
  });

  it("keeps a network blip unknown rather than claiming the forum is paused", async () => {
    fetchForumConfigMock.mockRejectedValue(
      Object.assign(new Error("down"), { status: 0 }),
    );
    mount("s1");
    await flush();
    expect(seen.at(-1)).toEqual({ enabled: false, loaded: false });
  });

  it("follows an operator flip on the next config refresh, without a reload", async () => {
    fetchForumConfigMock.mockResolvedValueOnce({ enabled: false });
    mount("s1");
    await flush();
    expect(seen.at(-1)).toEqual({ enabled: false, loaded: true });

    fetchForumConfigMock.mockResolvedValueOnce({ enabled: true });
    act(() => {
      requestConfigRefresh({ force: true });
    });
    await flush();
    expect(fetchForumConfigMock).toHaveBeenCalledTimes(2);
    expect(seen.at(-1)).toEqual({ enabled: true, loaded: true });
  });

  it("asks once per server however many surfaces mount", async () => {
    fetchForumConfigMock.mockResolvedValue({ enabled: true });
    await Promise.all([loadForumConfig("s1"), loadForumConfig("s1")]);
    expect(fetchForumConfigMock).toHaveBeenCalledTimes(1);
    expect(settledForumConfig("s1")).toEqual({ enabled: true, loaded: true });
    expect(settledForumConfig(null)).toEqual({ enabled: false, loaded: false });
  });

  it("never reads the previous server's answer as the new one's", async () => {
    fetchForumConfigMock.mockResolvedValueOnce({ enabled: true });
    mount("s1");
    await flush();
    expect(seen.at(-1)).toEqual({ enabled: true, loaded: true });
    seen.length = 0;
    fetchForumConfigMock.mockReturnValueOnce(new Promise(() => {}));
    act(() => root!.render(<Probe serverId="s2" />));
    // Every render for s2, the very first included, says "not known yet".
    expect(seen.every((one) => one.loaded === false)).toBe(true);
  });

  it("asks once more after a blip instead of waiting for the refresh pass", async () => {
    vi.useFakeTimers();
    try {
      fetchForumConfigMock
        .mockRejectedValueOnce(Object.assign(new Error("down"), { status: 0 }))
        .mockResolvedValueOnce({ enabled: true });
      mount("s1");
      await flush();
      expect(seen.at(-1)).toEqual({ enabled: false, loaded: false });
      await act(async () => {
        vi.advanceTimersByTime(FORUM_CONFIG_RETRY_MS);
      });
      await flush();
      expect(fetchForumConfigMock).toHaveBeenCalledTimes(2);
      expect(seen.at(-1)).toEqual({ enabled: true, loaded: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("has nothing to say without a server", () => {
    mount(null);
    expect(seen.at(-1)).toEqual({ enabled: false, loaded: false });
    expect(fetchForumConfigMock).not.toHaveBeenCalled();
  });
});
