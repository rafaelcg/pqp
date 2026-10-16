// @vitest-environment jsdom
import { act, lazy, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setInCall, setWatchingParty } from "@/lib/in-call-state";
import { setStaleChunkBannerVisible } from "@/lib/stale-chunk-state";
import { ContainedChunkBoundary, ErrorBoundary } from "./error-boundary";

/**
 * Bug report 120 (2026-10-13): "para do nada as telas, e fica so a voz". A page in a
 * call that opened a lazy panel after a deploy hit a 404 chunk, the update
 * recovery (rightly) refused to reload, and the ROOT boundary's fallback
 * replaced the whole app while the call's audio kept playing. A lazy panel now
 * costs the panel only.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;
let reloaded = 0;

const staleChunk = () =>
  lazy(() =>
    Promise.reject(
      new TypeError("Failed to fetch dynamically imported module: /assets/emoji-1a2b3c.js"),
    ),
  );

async function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
  // The rejected import settles on a later tick.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  reloaded = 0;
  window.sessionStorage.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(window, "location", "get").mockReturnValue({
    ...window.location,
    reload: () => {
      reloaded += 1;
    },
  } as Location);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  setInCall(false);
  setWatchingParty(false);
  setStaleChunkBannerVisible(false);
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("a stale chunk in a lazy panel, in a call", () => {
  it("leaves the rest of the app standing and says only that the panel could not open", async () => {
    setInCall(true);
    const Panel = staleChunk();
    await mount(
      <ErrorBoundary>
        <main data-testid="stage">the call stage and its screens</main>
        <ContainedChunkBoundary>
          <Suspense fallback={null}>
            <Panel />
          </Suspense>
        </ContainedChunkBoundary>
      </ErrorBoundary>,
    );

    // The stage is still there: this is the whole point.
    expect(document.querySelector('[data-testid="stage"]')?.textContent).toContain(
      "the call stage",
    );
    expect(document.body.textContent).not.toContain("pqp updated");
    expect(document.querySelector("[data-contained-chunk-error]")?.textContent).toContain(
      "Could not open this right now",
    );
    // And nothing reloaded under the call.
    expect(reloaded).toBe(0);
  });

  it("does the same for somebody watching a watch party", async () => {
    setWatchingParty(true);
    const Panel = staleChunk();
    await mount(
      <ErrorBoundary>
        <main data-testid="stage">the film</main>
        <ContainedChunkBoundary>
          <Suspense fallback={null}>
            <Panel />
          </Suspense>
        </ContainedChunkBoundary>
      </ErrorBoundary>,
    );
    expect(document.querySelector('[data-testid="stage"]')).not.toBeNull();
    expect(document.querySelector("[data-contained-chunk-error]")).not.toBeNull();
    expect(reloaded).toBe(0);
  });
});

describe("without a boundary of its own (what used to happen)", () => {
  it("the root boundary takes the whole app, which is why the panels have one", async () => {
    setInCall(true);
    const Panel = staleChunk();
    await mount(
      <ErrorBoundary>
        <main data-testid="stage">the call stage</main>
        <Suspense fallback={null}>
          <Panel />
        </Suspense>
      </ErrorBoundary>,
    );
    expect(document.querySelector('[data-testid="stage"]')).toBeNull();
    expect(document.body.textContent).toContain("pqp updated");
  });
});
