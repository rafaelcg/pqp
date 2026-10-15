// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordImportArrivals } from "@pqp/shared";

const getImportArrivals = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { ApiError, getImportArrivals };
});

import { ApiError } from "@/lib/api";
import {
  MEMBER_COUNT_DEBOUNCE_MS,
  isTransientArrivalsError,
  useBringCrew,
} from "./use-bring-crew";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const fresh: DiscordImportArrivals = {
  enabled: true,
  importedAt: "2026-10-14T10:00:00.000Z",
  phase: "fresh",
  arrived: 2,
  viaLink: 1,
  inviteCode: "AbC123",
};

type Props = { serverId: string | null; canManage: boolean; count: number };

let root: Root | null = null;
let host: HTMLElement | null = null;
let seen: ReturnType<typeof useBringCrew> | null = null;

function Probe(props: Props) {
  seen = useBringCrew(props.serverId, props.canManage, props.count);
  return null;
}

function mount(props: Props) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Probe {...props} />));
}

function update(props: Props) {
  act(() => root!.render(<Probe {...props} />));
}

/** Let a resolved or rejected request settle into state. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  getImportArrivals.mockReset();
  seen = null;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe("isTransientArrivalsError", () => {
  it("retries a network failure, a timeout, a rate limit and a server error", () => {
    expect(isTransientArrivalsError(new TypeError("fetch failed"))).toBe(true);
    for (const status of [0, 408, 429, 500, 502, 503]) {
      expect(isTransientArrivalsError(new ApiError(status, "x")), String(status)).toBe(
        true,
      );
    }
  });

  it("treats a refusal as final", () => {
    for (const status of [400, 401, 403, 404, 410]) {
      expect(isTransientArrivalsError(new ApiError(status, "x")), String(status)).toBe(
        false,
      );
    }
  });
});

describe("useBringCrew", () => {
  it("draws nothing for somebody who may not manage, and never asks", async () => {
    getImportArrivals.mockResolvedValue(fresh);
    mount({ serverId: "s1", canManage: false, count: 5 });
    await settle();
    expect(getImportArrivals).not.toHaveBeenCalled();
    expect(seen!.arrivals).toBeNull();
  });

  it("takes the counter down as soon as Manage Server is lost", async () => {
    getImportArrivals.mockResolvedValue(fresh);
    mount({ serverId: "s1", canManage: true, count: 5 });
    await settle();
    expect(seen!.arrivals?.inviteCode).toBe("AbC123");

    update({ serverId: "s1", canManage: false, count: 5 });
    // Not even on the render where the permission turned false.
    expect(seen!.arrivals).toBeNull();
    await settle();
    expect(seen!.arrivals).toBeNull();

    // Dismissing does nothing for a reader who no longer sees the strip.
    act(() => seen!.dismiss());
    expect(seen!.dismissed).toBeNull();

    // The permission coming back asks again rather than reviving the old answer.
    update({ serverId: "s1", canManage: true, count: 5 });
    await settle();
    expect(getImportArrivals).toHaveBeenCalledTimes(2);
    expect(seen!.arrivals?.arrived).toBe(2);
  });

  it("ignores an answer that lands after the permission was lost", async () => {
    let resolve!: (value: DiscordImportArrivals) => void;
    getImportArrivals.mockReturnValue(
      new Promise<DiscordImportArrivals>((r) => {
        resolve = r;
      }),
    );
    mount({ serverId: "s1", canManage: true, count: 5 });
    update({ serverId: "s1", canManage: false, count: 5 });
    resolve(fresh);
    await settle();
    expect(seen!.arrivals).toBeNull();
  });

  it("keeps asking after a 408, as it does after any other blip", async () => {
    getImportArrivals
      .mockRejectedValueOnce(new ApiError(408, "timeout"))
      .mockResolvedValue(fresh);
    mount({ serverId: "s1", canManage: true, count: 5 });
    await settle();
    expect(seen!.arrivals).toBeNull();
    await advance(30_000);
    expect(getImportArrivals).toHaveBeenCalledTimes(2);
    expect(seen!.arrivals?.arrived).toBe(2);
  });

  it("stops after a 403 and does not poll", async () => {
    getImportArrivals.mockRejectedValue(new ApiError(403, "forbidden"));
    mount({ serverId: "s1", canManage: true, count: 5 });
    await settle();
    await advance(120_000);
    expect(getImportArrivals).toHaveBeenCalledTimes(1);
  });

  it("turns a burst of joins into one request", async () => {
    getImportArrivals.mockResolvedValue(fresh);
    mount({ serverId: "s1", canManage: true, count: 5 });
    await settle();
    expect(getImportArrivals).toHaveBeenCalledTimes(1);

    for (const count of [6, 7, 8, 9]) {
      update({ serverId: "s1", canManage: true, count });
      await advance(500);
    }
    // Nothing yet: the count has not held still for the debounce.
    expect(getImportArrivals).toHaveBeenCalledTimes(1);
    await advance(MEMBER_COUNT_DEBOUNCE_MS);
    expect(getImportArrivals).toHaveBeenCalledTimes(2);
  });

  it("does not ask a second time when the member list first loads", async () => {
    getImportArrivals.mockResolvedValue(fresh);
    mount({ serverId: "s1", canManage: true, count: 0 });
    await settle();
    update({ serverId: "s1", canManage: true, count: 12 });
    await advance(MEMBER_COUNT_DEBOUNCE_MS * 2);
    expect(getImportArrivals).toHaveBeenCalledTimes(1);
  });
});
