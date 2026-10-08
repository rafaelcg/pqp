// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchStreamAlertSetting = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchStreamAlertSetting: (serverId: string) => fetchStreamAlertSetting(serverId),
}));

import { useStreamAlertSettings } from "./use-stream-alert-settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const SERVER = "11111111-1111-4111-8111-111111111111";

let host: HTMLDivElement;
let root: Root;
let latest: ReturnType<typeof useStreamAlertSettings>;

function Probe() {
  latest = useStreamAlertSettings();
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  fetchStreamAlertSetting.mockReset();
  host = document.createElement("div");
  root = createRoot(host);
  act(() => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
});

describe("useStreamAlertSettings", () => {
  it("remembers an answer and does not ask again inside its window", async () => {
    fetchStreamAlertSetting.mockResolvedValue({
      flag: true,
      enabled: true,
      default: true,
      memberCount: 40,
    });
    act(() => latest.ensure(SERVER));
    await flush();
    expect(latest.byServer[SERVER]).toEqual({ flag: true, default: true });
    act(() => latest.ensure(SERVER));
    await flush();
    expect(fetchStreamAlertSetting).toHaveBeenCalledTimes(1);
  });

  it("concludes nothing from a failed ask: the next menu open asks again instead of hiding the switch for ten minutes", async () => {
    fetchStreamAlertSetting.mockRejectedValueOnce(new Error("network"));
    act(() => latest.ensure(SERVER));
    await flush();
    // Not "flag off": not known.
    expect(latest.byServer[SERVER]).toBeUndefined();

    fetchStreamAlertSetting.mockResolvedValueOnce({
      flag: true,
      enabled: false,
      default: false,
      memberCount: 4000,
    });
    act(() => latest.ensure(SERVER));
    await flush();
    expect(fetchStreamAlertSetting).toHaveBeenCalledTimes(2);
    expect(latest.byServer[SERVER]).toEqual({ flag: true, default: false });
  });
});
