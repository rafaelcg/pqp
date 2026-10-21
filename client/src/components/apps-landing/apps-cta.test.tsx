// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACQUISITION_KEY } from "@/lib/acquisition";
import { LOCADORA_LANDING_REF, APPS_LANDING_REF } from "@/lib/apps-landing";
import { AppsCta } from "./apps-cta";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = { isLoaded: true, isSignedIn: false };
const openSignUp = vi.fn(async () => undefined);

vi.mock("@clerk/clerk-react", () => ({
  useAuth: () => auth,
  useClerk: () => ({ openSignUp }),
}));

let root: Root | null = null;
let host: HTMLElement | null = null;

function Where() {
  const location = useLocation();
  return <p data-where="">{location.pathname + location.search}</p>;
}

function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={["/apps"]}>
        <Routes>
          <Route path="/apps" element={node} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}

beforeEach(() => {
  auth.isLoaded = true;
  auth.isSignedIn = false;
  openSignUp.mockClear();
  window.localStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("the sign-up button of the pqp Apps pages", () => {
  it("signed out: stashes the page's ref, then opens sign-up on a redirect URL that carries it", () => {
    mount(<AppsCta tag={LOCADORA_LANDING_REF} path="/apps/locadora" label="Abrir o pqp" />);
    const button = host!.querySelector<HTMLButtonElement>("[data-apps-cta]")!;
    expect(button.textContent).toContain("Abrir o pqp");
    act(() => button.click());

    const stored = JSON.parse(window.localStorage.getItem(ACQUISITION_KEY) ?? "null") as
      | Record<string, unknown>
      | null;
    expect(stored).toMatchObject({ ref: "locadora-landing", landing: "/apps" });
    // No id, no email, nothing but the site's own tag and the landing.
    expect(Object.keys(stored ?? {}).sort()).toEqual(["at", "landing", "ref"]);
    expect(openSignUp).toHaveBeenCalledTimes(1);
    expect(openSignUp).toHaveBeenCalledWith({ forceRedirectUrl: "/app?ref=locadora-landing" });
  });

  it("the hub's button carries its own tag", () => {
    mount(<AppsCta tag={APPS_LANDING_REF} path="/apps" label="Abrir o pqp" />);
    act(() => host!.querySelector<HTMLButtonElement>("[data-apps-cta]")!.click());
    expect(JSON.parse(window.localStorage.getItem(ACQUISITION_KEY)!)).toMatchObject({
      ref: "apps-landing",
    });
    expect(openSignUp).toHaveBeenCalledWith({ forceRedirectUrl: "/app?ref=apps-landing" });
  });

  it("Clerk not ready: goes to /app with the tag on the URL instead of doing nothing", () => {
    auth.isLoaded = false;
    mount(<AppsCta tag={APPS_LANDING_REF} path="/apps" label="Abrir o pqp" />);
    act(() => host!.querySelector<HTMLButtonElement>("[data-apps-cta]")!.click());
    expect(openSignUp).not.toHaveBeenCalled();
    expect(host!.querySelector("[data-where]")?.textContent).toBe("/app?ref=apps-landing");
  });

  it("Clerk throwing: same fallback", () => {
    openSignUp.mockImplementationOnce(() => {
      throw new Error("clerk");
    });
    mount(<AppsCta tag={APPS_LANDING_REF} path="/apps" label="Abrir o pqp" />);
    act(() => host!.querySelector<HTMLButtonElement>("[data-apps-cta]")!.click());
    expect(host!.querySelector("[data-where]")?.textContent).toBe("/app?ref=apps-landing");
  });

  it("signed in: a plain link to /app, no stash, no sign-up", () => {
    auth.isSignedIn = true;
    mount(<AppsCta tag={APPS_LANDING_REF} path="/apps" label="Abrir o pqp" />);
    const link = host!.querySelector<HTMLAnchorElement>("a[data-apps-cta]")!;
    expect(link.getAttribute("href")).toBe("/app");
    act(() => link.click());
    expect(openSignUp).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(ACQUISITION_KEY)).toBeNull();
  });
});
