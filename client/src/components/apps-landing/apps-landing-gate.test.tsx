// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppsLandingProbe } from "@/lib/apps-landing";
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
  ])("%s is the same as off", async (_name, answer) => {
    await open("/apps", async () => answer());
    expect(host!.querySelector("[data-page]")).toBeNull();
    expect(host!.querySelector("[data-home]")).not.toBeNull();
  });

  it("a network error is the same as off", async () => {
    await open("/apps", async () => {
      throw new TypeError("offline");
    });
    expect(host!.querySelector("[data-page]")).toBeNull();
    expect(host!.querySelector("[data-home]")).not.toBeNull();
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
