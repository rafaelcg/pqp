import { describe, expect, it, vi } from "vitest";
import {
  isChunkLoadError,
  recoverFromChunkLoadError,
  reloadedRecently,
} from "./chunk-reload";

/** A minimal in-memory stand-in for `sessionStorage`, so tests never touch jsdom's real one. */
function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe("isChunkLoadError", () => {
  it("matches Chromium/Vite's wording", () => {
    expect(
      isChunkLoadError(
        new Error("Failed to fetch dynamically imported module: https://pqp.gg/assets/App-abc123.js"),
      ),
    ).toBe(true);
  });

  it("matches Safari/WebKit's wording", () => {
    expect(
      isChunkLoadError(
        new Error("Error loading dynamically imported module: https://pqp.gg/assets/App-abc123.js"),
      ),
    ).toBe(true);
  });

  it("matches Firefox's wording", () => {
    expect(
      isChunkLoadError(new TypeError("Importing a module script failed")),
    ).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(
      isChunkLoadError(new Error("FAILED TO FETCH DYNAMICALLY IMPORTED MODULE")),
    ).toBe(true);
  });

  it("matches a plain string message", () => {
    expect(
      isChunkLoadError("Failed to fetch dynamically imported module"),
    ).toBe(true);
  });

  it("matches an object with a message property (Vite's preload payload)", () => {
    expect(
      isChunkLoadError({
        message: "Failed to fetch dynamically imported module",
      }),
    ).toBe(true);
  });

  it("rejects an unrelated error", () => {
    expect(isChunkLoadError(new Error("channel is not accessible"))).toBe(
      false,
    );
  });

  it("rejects nullish and shapeless values without throwing", () => {
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError(42)).toBe(false);
    expect(isChunkLoadError({})).toBe(false);
  });
});

describe("reloadedRecently", () => {
  it("is false with nothing recorded", () => {
    expect(reloadedRecently(1_000, memoryStorage())).toBe(false);
  });

  it("is true just inside the 30s window", () => {
    const storage = memoryStorage({ "pqp:stale-chunk-reload-at": "1000" });
    expect(reloadedRecently(1000 + 29_999, storage)).toBe(true);
  });

  it("is false once the 30s window has fully elapsed", () => {
    const storage = memoryStorage({ "pqp:stale-chunk-reload-at": "1000" });
    expect(reloadedRecently(1000 + 30_000, storage)).toBe(false);
  });

  it("is false with no storage available (private mode, disabled storage)", () => {
    expect(reloadedRecently(1_000, null)).toBe(false);
  });

  it("ignores a corrupted stored value instead of throwing", () => {
    const storage = memoryStorage({ "pqp:stale-chunk-reload-at": "not-a-number" });
    expect(reloadedRecently(1_000, storage)).toBe(false);
  });

  it("tolerates a storage that throws on read", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(reloadedRecently(1_000, storage)).toBe(false);
  });
});

describe("recoverFromChunkLoadError", () => {
  it("does nothing for an error that is not a chunk-load failure", () => {
    const reload = vi.fn();
    const onDeferred = vi.fn();
    const action = recoverFromChunkLoadError(new Error("boom"), {
      now: () => 0,
      storage: memoryStorage(),
      isInCall: () => false,
      reload,
      onDeferred,
    });
    expect(action).toBe("ignored");
    expect(reload).not.toHaveBeenCalled();
    expect(onDeferred).not.toHaveBeenCalled();
  });

  it("reloads once, guarded, when not in a call", () => {
    const reload = vi.fn();
    const storage = memoryStorage();
    const action = recoverFromChunkLoadError(
      new Error("Failed to fetch dynamically imported module"),
      { now: () => 5_000, storage, isInCall: () => false, reload },
    );
    expect(action).toBe("reloaded");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem("pqp:stale-chunk-reload-at")).toBe("5000");
  });

  it("never reloads a second time inside the 30s window (no loop)", () => {
    const reload = vi.fn();
    const storage = memoryStorage();
    const error = new Error("Failed to fetch dynamically imported module");

    const first = recoverFromChunkLoadError(error, {
      now: () => 1_000,
      storage,
      isInCall: () => false,
      reload,
    });
    const second = recoverFromChunkLoadError(error, {
      now: () => 1_000 + 10_000,
      storage,
      isInCall: () => false,
      reload,
    });

    expect(first).toBe("reloaded");
    expect(second).toBe("ignored");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("tries again once the window has elapsed", () => {
    const reload = vi.fn();
    const storage = memoryStorage();
    const error = new Error("Failed to fetch dynamically imported module");

    recoverFromChunkLoadError(error, {
      now: () => 0,
      storage,
      isInCall: () => false,
      reload,
    });
    const third = recoverFromChunkLoadError(error, {
      now: () => 30_000,
      storage,
      isInCall: () => false,
      reload,
    });

    expect(third).toBe("reloaded");
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("defers to a toast instead of reloading while in a call", () => {
    const reload = vi.fn();
    const onDeferred = vi.fn();
    const storage = memoryStorage();
    const action = recoverFromChunkLoadError(
      new Error("Failed to fetch dynamically imported module"),
      {
        now: () => 1_000,
        storage,
        isInCall: () => true,
        reload,
        onDeferred,
      },
    );
    expect(action).toBe("deferred");
    expect(reload).not.toHaveBeenCalled();
    expect(onDeferred).toHaveBeenCalledTimes(1);
    // A deferred outcome never marks the guard: hanging up and hitting the
    // same failure again should still be free to reload right away.
    expect(storage.getItem("pqp:stale-chunk-reload-at")).toBeNull();
  });
});
