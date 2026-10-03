// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INLINE_SAVED_MS,
  useInlineSave,
  type InlineSaveState,
} from "@/components/settings/kit/use-inline-save";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;
let current: ReturnType<typeof useInlineSave> | null = null;

function Probe() {
  current = useInlineSave();
  return null;
}

function state(): InlineSaveState {
  return current!.state;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Probe />));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  current = null;
  vi.useRealTimers();
});

describe("useInlineSave", () => {
  it("goes saving, then saved, then quiet again", async () => {
    const write = deferred();
    let pending!: Promise<void>;
    act(() => {
      pending = current!.run(() => write.promise, "Falhou");
    });
    expect(state()).toEqual({ kind: "saving" });

    await act(async () => {
      write.resolve();
      await pending;
    });
    expect(state()).toEqual({ kind: "saved" });

    act(() => vi.advanceTimersByTime(INLINE_SAVED_MS - 1));
    expect(state()).toEqual({ kind: "saved" });
    act(() => vi.advanceTimersByTime(1));
    expect(state()).toEqual({ kind: "idle" });
  });

  it("shows the error's own message, or the fallback", async () => {
    await act(async () => {
      await current!.run(() => Promise.reject(new Error("Nome em uso")), "Falhou");
    });
    expect(state()).toEqual({ kind: "error", message: "Nome em uso" });

    await act(async () => {
      await current!.run(() => Promise.reject("nope"), "Falhou");
    });
    expect(state()).toEqual({ kind: "error", message: "Falhou" });
  });

  it("lets only the latest run report", async () => {
    const first = deferred();
    const second = deferred();
    let a!: Promise<void>;
    let b!: Promise<void>;
    act(() => {
      a = current!.run(() => first.promise, "Falhou");
    });
    act(() => {
      b = current!.run(() => second.promise, "Falhou");
    });

    await act(async () => {
      first.resolve();
      await a;
    });
    // The first write landed, but the second is still in flight.
    expect(state()).toEqual({ kind: "saving" });

    await act(async () => {
      second.reject(new Error("Sem rede"));
      await b;
    });
    expect(state()).toEqual({ kind: "error", message: "Sem rede" });
  });

  it("does not clear a newer saving state with an older saved timer", async () => {
    await act(async () => {
      await current!.run(() => Promise.resolve(), "Falhou");
    });
    expect(state()).toEqual({ kind: "saved" });

    const slow = deferred();
    act(() => {
      void current!.run(() => slow.promise, "Falhou");
    });
    act(() => vi.advanceTimersByTime(INLINE_SAVED_MS * 2));
    expect(state()).toEqual({ kind: "saving" });
  });
});
