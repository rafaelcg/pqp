// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAILURE_RETRY_MS } from "@/hooks/use-apps-landing";
import {
  ANSWER_TTL_MS,
  cachedAppsLanding,
  resetAppsLandingProbe,
} from "@/lib/apps-landing";
import { AppsLandingGate } from "./apps-landing-gate";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

async function open(path: string, answer: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(answer));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/apps"
            element={
              <AppsLandingGate>
                <p data-page="">the apps page</p>
              </AppsLandingGate>
            }
          />
          <Route
            path="/apps/locadora"
            element={
              <AppsLandingGate>
                <p data-page="">the locadora page</p>
              </AppsLandingGate>
            }
          />
          <Route
            path="/locadora"
            element={
              <AppsLandingGate>
                <p data-page="">the locadora short link</p>
              </AppsLandingGate>
            }
          />
          <Route path="/" element={<p data-home="">home</p>} />
        </Routes>
      </MemoryRouter>,
    );
  });
  // The probe's promise, then the state it sets.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Runs the hook's one retry timer, then lets its promise land. */
async function settleRetry() {
  await act(async () => {
    vi.advanceTimersByTime(FAILURE_RETRY_MS + 1);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  resetAppsLandingProbe();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

describe("the apps landing gate", () => {
  it.each(["/apps", "/apps/locadora", "/locadora"])(
    "flag off: %s redirects to the home page and draws nothing of its own",
    async (path) => {
      await open(path, async () => reply(200, { enabled: false }));
      expect(host!.querySelector("[data-page]")).toBeNull();
      expect(host!.querySelector("[data-home]")).not.toBeNull();
    },
  );

  it.each(["/apps", "/apps/locadora", "/locadora"])(
    "flag on: %s renders its page",
    async (path) => {
      await open(path, async () => reply(200, { enabled: true }));
      expect(host!.querySelector("[data-page]")).not.toBeNull();
      expect(host!.querySelector("[data-home]")).toBeNull();
    },
  );

  it.each([
    ["an older API with no such route (404)", () => reply(404, { error: "nope" })],
    ["an API error", () => reply(500, {})],
    ["a malformed body", () => reply(200, { enabled: "yes" })],
  ])("%s is the same as off, after one more try", async (_name, answer) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await open("/apps", async () => answer());
    // Not bounced on the first failure: the visitor waits for the one retry.
    expect(host!.querySelector("[data-home]")).toBeNull();
    await settleRetry();
    expect(host!.querySelector("[data-page]")).toBeNull();
    expect(host!.querySelector("[data-home]")).not.toBeNull();
    vi.useRealTimers();
  });

  it("a network error is the same as off, after one more try", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await open("/apps", async () => {
      throw new TypeError("offline");
    });
    await settleRetry();
    expect(host!.querySelector("[data-page]")).toBeNull();
    expect(host!.querySelector("[data-home]")).not.toBeNull();
    vi.useRealTimers();
  });

  it("a blip does not bounce a real page: the retry finds the flag on and the page renders", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let calls = 0;
    await open("/apps", async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("blip");
      return reply(200, { enabled: true });
    });
    await settleRetry();
    expect(calls).toBe(2);
    expect(host!.querySelector("[data-page]")).not.toBeNull();
    expect(host!.querySelector("[data-home]")).toBeNull();
    vi.useRealTimers();
  });

  it("an answer older than the endpoint's cache lifetime is asked again on the next visit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await open("/apps", async () => reply(200, { enabled: true }));
    expect(cachedAppsLanding()).toBe(true);
    vi.advanceTimersByTime(ANSWER_TTL_MS + 1);
    expect(cachedAppsLanding()).toBeNull();
    vi.useRealTimers();
  });

  it("never shows the page and then takes it back: while the answer is on its way, only an empty surface", async () => {
    let release: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    );
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={["/apps"]}>
          <Routes>
            <Route
              path="/apps"
              element={
                <AppsLandingGate>
                  <p data-page="">the apps page</p>
                </AppsLandingGate>
              }
            />
            <Route path="/" element={<p data-home="">home</p>} />
          </Routes>
        </MemoryRouter>,
      );
    });
    expect(host.querySelector("[data-page]")).toBeNull();
    expect(host.querySelector("[data-home]")).toBeNull();
    expect(host.querySelector("[aria-busy]")).not.toBeNull();
    await act(async () => {
      release(reply(200, { enabled: false }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.querySelector("[data-page]")).toBeNull();
    expect(host.querySelector("[data-home]")).not.toBeNull();
  });
});
