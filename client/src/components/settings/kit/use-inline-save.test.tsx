// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsInlineStatus } from "@/components/settings/kit/inline-status";
import {
  INLINE_SAVED_MS,
  inlineErrorMessage,
  useInlineSave,
  type InlineSaveState,
  type UseInlineSaveOptions,
} from "@/components/settings/kit/use-inline-save";
import { ApiError } from "@/lib/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;
let current: ReturnType<typeof useInlineSave> | null = null;

let probeOptions: UseInlineSaveOptions | undefined;

function Probe() {
  current = useInlineSave(probeOptions);
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
  probeOptions = undefined;
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

describe("useInlineSave options", () => {
  it("relabels the saving line and skips the saved step", async () => {
    probeOptions = { savingLabel: "Preparando…", showSaved: false };
    act(() => root!.render(<Probe />));
    const write = deferred();
    let pending!: Promise<void>;
    act(() => {
      pending = current!.run(() => write.promise, "Falhou");
    });
    expect(state()).toEqual({ kind: "saving", label: "Preparando…" });

    await act(async () => {
      write.resolve();
      await pending;
    });
    expect(state()).toEqual({ kind: "idle" });
  });

  it("still reports an error in the no-saved mode", async () => {
    probeOptions = { showSaved: false };
    act(() => root!.render(<Probe />));
    await act(async () => {
      await current!.run(() => Promise.reject(new Error("Sem espaço")), "Falhou");
    });
    expect(state()).toEqual({ kind: "error", message: "Sem espaço" });
  });
});

describe("inlineErrorMessage", () => {
  it("never shows the server's English sentence", () => {
    expect(
      inlineErrorMessage(new ApiError(409, "That handle is already taken"), "Falhou"),
    ).toBe("Falhou");
    expect(inlineErrorMessage(new ApiError(400, "Invalid request"), "Falhou")).toBe(
      "Falhou",
    );
  });

  it("says a 429 is a rate limit when it has the words for it", () => {
    expect(
      inlineErrorMessage(new ApiError(429, "Slow down"), "Falhou", "Espera um pouco"),
    ).toBe("Espera um pouco");
    expect(inlineErrorMessage(new ApiError(429, "Slow down"), "Falhou")).toBe("Falhou");
  });

  it("uses the fallback for a 5xx, a network failure and a bare 4xx", () => {
    expect(inlineErrorMessage(new ApiError(503, "database_unavailable"), "Falhou")).toBe(
      "Falhou",
    );
    expect(
      inlineErrorMessage(new ApiError(0, "Network error reaching API."), "Falhou"),
    ).toBe("Falhou");
    expect(inlineErrorMessage(new ApiError(400, "Request failed"), "Falhou")).toBe(
      "Falhou",
    );
  });

  it("keeps a plain Error's message and falls back for anything else", () => {
    expect(inlineErrorMessage(new Error("Arquivo grande demais"), "Falhou")).toBe(
      "Arquivo grande demais",
    );
    expect(inlineErrorMessage("boom", "Falhou")).toBe("Falhou");
  });
});

describe("SettingsInlineStatus", () => {
  it("says the custom saving label, from the prop or the state", () => {
    expect(
      renderToStaticMarkup(
        <SettingsInlineStatus state={{ kind: "saving", label: "Enviando…" }} />,
      ),
    ).toContain("Enviando…");
    expect(
      renderToStaticMarkup(
        <SettingsInlineStatus
          state={{ kind: "saving", label: "Enviando…" }}
          savingLabel="Preparando…"
        />,
      ),
    ).toContain("Preparando…");
  });

  it("draws an icon beside an error, as an alert", () => {
    const html = renderToStaticMarkup(
      <SettingsInlineStatus state={{ kind: "error", message: "Não deu." }} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("lucide-circle-x");
    expect(html).toContain("Não deu.");
  });
});

describe("useInlineSave ordering", () => {
  it("sends writes one at a time and skips one a newer run overtook", async () => {
    const first = deferred();
    const calls: string[] = [];
    let p1!: Promise<void>, p2!: Promise<void>, p3!: Promise<void>;
    act(() => {
      p1 = current!.run(() => {
        calls.push("a");
        return first.promise;
      }, "falhou");
      p2 = current!.run(async () => {
        calls.push("b");
      }, "falhou");
      p3 = current!.run(async () => {
        calls.push("c");
      }, "falhou");
    });
    await act(async () => {
      await Promise.resolve();
    });
    // Only the first write is out; the next waits for it.
    expect(calls).toEqual(["a"]);
    await act(async () => {
      first.resolve();
      await Promise.all([p1, p2, p3]);
    });
    // "b" was overtaken by "c" while it waited, so it never went out.
    expect(calls).toEqual(["a", "c"]);
    expect(state().kind).toBe("saved");
  });
});
