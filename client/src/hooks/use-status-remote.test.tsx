// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManualStatus } from "@pqp/shared";
import type { StatusControls } from "./use-status";

const updatePreferencesMock = vi.hoisted(() => vi.fn());
const fetchMeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
  updatePreferences: (...args: unknown[]) => updatePreferencesMock(...args),
  fetchMe: (...args: unknown[]) => fetchMeMock(...args),
}));
vi.mock("@/lib/i18n", () => ({
  translateMessage: (key: string) => key,
}));

const { useUserStatus } = await import("./use-status");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const saved = (status: ManualStatus) => ({ preferences: { status } });
const me = (status: ManualStatus) => ({ preferences: { status } });

let root: Root | null = null;
let host: HTMLElement | null = null;
let controls: StatusControls | null = null;

function Probe({ stored }: { stored: ManualStatus | null }) {
  controls = useUserStatus({ stored, sendIdle: () => {}, connected: true });
  return null;
}

async function mount(stored: ManualStatus) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Probe stored={stored} />);
  });
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
  });
}

beforeEach(() => {
  updatePreferencesMock.mockReset();
  fetchMeMock.mockReset();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
  controls = null;
});

describe("useUserStatus own-status from other devices", () => {
  it("adopts a remote choice when nothing is in flight", async () => {
    await mount("online");
    await act(async () => controls!.adoptRemote("away"));
    expect(controls!.manual).toBe("away");
    expect(fetchMeMock).not.toHaveBeenCalled();
  });

  it("holds the echo of its own write and makes no extra request", async () => {
    const write = deferred<ReturnType<typeof saved>>();
    updatePreferencesMock.mockReturnValueOnce(write.promise);
    await mount("online");

    await act(async () => controls!.setManual("dnd"));
    await act(async () => controls!.adoptRemote("dnd"));
    await act(async () => write.resolve(saved("dnd")));
    await flush();

    expect(controls!.manual).toBe("dnd");
    expect(fetchMeMock).not.toHaveBeenCalled();
  });

  it("reads the stored value back when another device wrote during the save", async () => {
    const write = deferred<ReturnType<typeof saved>>();
    updatePreferencesMock.mockReturnValueOnce(write.promise);
    // The other device's write committed after this tab's, so it is what
    // Postgres holds.
    fetchMeMock.mockResolvedValueOnce(me("invisible"));
    await mount("online");

    await act(async () => controls!.setManual("dnd"));
    await act(async () => controls!.adoptRemote("invisible"));
    // Held, not applied mid-save.
    expect(controls!.manual).toBe("dnd");

    await act(async () => write.resolve(saved("dnd")));
    await flush();

    expect(fetchMeMock).toHaveBeenCalledTimes(1);
    expect(controls!.manual).toBe("invisible");
  });

  it("does not roll back over another device's choice when its own write fails", async () => {
    const write = deferred<ReturnType<typeof saved>>();
    updatePreferencesMock.mockReturnValueOnce(write.promise);
    fetchMeMock.mockResolvedValueOnce(me("away"));
    await mount("online");

    await act(async () => controls!.setManual("dnd"));
    await act(async () => controls!.adoptRemote("away"));
    await act(async () => write.reject(new Error("offline")));
    await flush();

    expect(controls!.error).toBe("status.saveFailed");
    expect(controls!.manual).toBe("away");
  });

  it("falls back to the newest held frame when the read-back fails", async () => {
    const write = deferred<ReturnType<typeof saved>>();
    updatePreferencesMock.mockReturnValueOnce(write.promise);
    fetchMeMock.mockRejectedValueOnce(new Error("offline"));
    await mount("online");

    await act(async () => controls!.setManual("dnd"));
    await act(async () => controls!.adoptRemote("away"));
    await act(async () => write.reject(new Error("offline")));
    await flush();

    expect(controls!.manual).toBe("away");
  });

  it("lets a frame that lands during the read-back win over it", async () => {
    const write = deferred<ReturnType<typeof saved>>();
    const readBack = deferred<ReturnType<typeof me>>();
    updatePreferencesMock.mockReturnValueOnce(write.promise);
    fetchMeMock.mockReturnValueOnce(readBack.promise);
    await mount("online");

    await act(async () => controls!.setManual("dnd"));
    await act(async () => controls!.adoptRemote("away"));
    await act(async () => write.resolve(saved("dnd")));
    await flush();
    expect(fetchMeMock).toHaveBeenCalledTimes(1);

    // Newer than anything the read-back, issued before it, can say.
    await act(async () => controls!.adoptRemote("invisible"));
    await act(async () => readBack.resolve(me("away")));
    await flush();

    expect(controls!.manual).toBe("invisible");
  });

  it("lets a newer save of its own that settles during the read-back win over it", async () => {
    const firstWrite = deferred<ReturnType<typeof saved>>();
    const readBack = deferred<ReturnType<typeof me>>();
    updatePreferencesMock
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValueOnce(saved("online"));
    fetchMeMock.mockReturnValueOnce(readBack.promise);
    await mount("online");

    await act(async () => controls!.setManual("dnd"));
    await act(async () => controls!.adoptRemote("away"));
    await act(async () => firstWrite.resolve(saved("dnd")));
    await flush();
    expect(fetchMeMock).toHaveBeenCalledTimes(1);

    // Picked, saved and settled while the read-back is still on the wire. No
    // frame arrives in between, so only the save itself can mark it stale.
    await act(async () => controls!.setManual("online"));
    await flush();
    expect(controls!.saving).toBe(false);

    await act(async () => readBack.resolve(me("away")));
    await flush();

    expect(controls!.manual).toBe("online");
    expect(fetchMeMock).toHaveBeenCalledTimes(1);
  });

  it("does not let a failed read-back's fallback overwrite a newer save", async () => {
    const firstWrite = deferred<ReturnType<typeof saved>>();
    const readBack = deferred<ReturnType<typeof me>>();
    updatePreferencesMock
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValueOnce(saved("online"));
    fetchMeMock.mockReturnValueOnce(readBack.promise);
    await mount("online");

    await act(async () => controls!.setManual("dnd"));
    await act(async () => controls!.adoptRemote("away"));
    await act(async () => firstWrite.resolve(saved("dnd")));
    await flush();

    await act(async () => controls!.setManual("online"));
    await flush();

    await act(async () => readBack.reject(new Error("offline")));
    await flush();

    expect(controls!.manual).toBe("online");
  });
});
