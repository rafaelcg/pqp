// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@pqp/shared";
import type { CustomStatusControls } from "./use-custom-status";

const updateMeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
  updateMe: (...args: unknown[]) => updateMeMock(...args),
}));

const { useCustomStatus } = await import("./use-custom-status");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function account(customStatus: string | null): User {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    clerkId: "clerk_ana",
    displayName: "Ana",
    username: "ana",
    discriminator: "0001",
    tag: "ana#0001",
    avatarUrl: null,
    dmPrivacy: "server_members",
    handle: null,
    handleChangedAt: null,
    bannerUrl: null,
    customStatus,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let controls: CustomStatusControls | null = null;

function Probe({
  stored,
  onUserUpdated,
}: {
  stored: string | null;
  onUserUpdated: (user: User) => void;
}) {
  controls = useCustomStatus({ stored, onUserUpdated });
  return (
    <div
      data-value={controls.value}
      data-saving={controls.saving ? "1" : "0"}
      data-error={controls.error ?? ""}
    />
  );
}

async function mount(
  stored: string | null,
  onUserUpdated: (user: User) => void = () => {},
) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Probe stored={stored} onUserUpdated={onUserUpdated} />);
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
  controls = null;
});

beforeEach(() => {
  updateMeMock.mockReset();
});

describe("useCustomStatus overlapping saves", () => {
  it("does not fire a second PATCH for Enter then blur of the same string", async () => {
    const first = deferred<User>();
    updateMeMock.mockReturnValueOnce(first.promise);
    await mount("");

    await act(async () => {
      controls!.save("no gym");
      controls!.save("no gym");
    });

    expect(updateMeMock).toHaveBeenCalledTimes(1);
    expect(updateMeMock).toHaveBeenCalledWith({ customStatus: "no gym" });

    await act(async () => {
      first.resolve(account("no gym"));
      await first.promise;
    });
    await settle();
    expect(controls!.value).toBe("no gym");
    expect(controls!.saving).toBe(false);
  });

  it("queues a newer value and does not apply the older PATCH over it", async () => {
    const first = deferred<User>();
    const second = deferred<User>();
    updateMeMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const onUserUpdated = vi.fn();
    await mount("no gym", onUserUpdated);

    await act(async () => {
      controls!.save("brb");
    });
    await act(async () => {
      controls!.save("so na call");
    });

    expect(updateMeMock).toHaveBeenCalledTimes(1);
    expect(updateMeMock).toHaveBeenCalledWith({ customStatus: "brb" });
    expect(controls!.value).toBe("so na call");
    expect(controls!.saving).toBe(true);

    await act(async () => {
      first.resolve(account("brb"));
      await first.promise;
    });
    await settle();

    expect(updateMeMock).toHaveBeenCalledTimes(2);
    expect(updateMeMock).toHaveBeenLastCalledWith({
      customStatus: "so na call",
    });
    expect(controls!.value).toBe("so na call");
    expect(controls!.saving).toBe(true);

    await act(async () => {
      second.resolve(account("so na call"));
      await second.promise;
    });
    await settle();

    expect(controls!.value).toBe("so na call");
    expect(controls!.saving).toBe(false);
    expect(onUserUpdated).toHaveBeenLastCalledWith(account("so na call"));
  });

  it("replaces the queued write so only the latest intended value is sent next", async () => {
    const first = deferred<User>();
    const second = deferred<User>();
    updateMeMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await mount("");

    await act(async () => {
      controls!.save("one");
      controls!.save("two");
      controls!.save("three");
    });

    expect(updateMeMock).toHaveBeenCalledTimes(1);
    expect(updateMeMock).toHaveBeenCalledWith({ customStatus: "one" });

    await act(async () => {
      first.resolve(account("one"));
      await first.promise;
    });
    await settle();

    expect(updateMeMock).toHaveBeenCalledTimes(2);
    expect(updateMeMock).toHaveBeenLastCalledWith({ customStatus: "three" });

    await act(async () => {
      second.resolve(account("three"));
      await second.promise;
    });
    await settle();
    expect(controls!.value).toBe("three");
  });

  it("queues a clear while a save is in flight", async () => {
    const first = deferred<User>();
    const second = deferred<User>();
    updateMeMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await mount("no gym");

    await act(async () => {
      controls!.save("brb");
      controls!.save("");
    });

    expect(updateMeMock).toHaveBeenCalledTimes(1);
    expect(controls!.value).toBe("");

    await act(async () => {
      first.resolve(account("brb"));
      await first.promise;
    });
    await settle();

    expect(updateMeMock).toHaveBeenLastCalledWith({ customStatus: null });

    await act(async () => {
      second.resolve(account(null));
      await second.promise;
    });
    await settle();
    expect(controls!.value).toBe("");
    expect(controls!.saving).toBe(false);
  });

  it("rolls back to the last persisted recado when the last write fails", async () => {
    const first = deferred<User>();
    updateMeMock.mockReturnValueOnce(first.promise);
    await mount("no gym");

    await act(async () => {
      controls!.save("brb");
    });
    expect(controls!.value).toBe("brb");

    await act(async () => {
      first.reject(new Error("down"));
      await first.promise.catch(() => {});
    });
    await settle();

    expect(controls!.value).toBe("no gym");
    expect(controls!.error).toBeTruthy();
    expect(controls!.saving).toBe(false);
  });
});
