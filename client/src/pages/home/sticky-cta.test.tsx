// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetUpdateState, setUpdateWaiting } from "@/lib/update-prompt-state";
import { StickyCta } from "./sticky-cta";

/*
 * The sticky create bar and the corner update indicator share the bottom of a
 * phone screen. While a build is offered, `StandaloneUpdateIndicator` draws a
 * 36 px round button at bottom-4 left-4 above the bar, so the bar must leave
 * that corner free (VERIFY round 1, F2: they overlapped by 36 x 36 px at 390).
 * The geometry itself is checked in a browser; this pins the reserve to the
 * same signal the indicator renders on, in both directions.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The bypass face: a plain link, no Clerk.
vi.mock("@/components/marketing/marketing-auth-ctas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/marketing/marketing-auth-ctas")>();
  return {
    ...actual,
    MarketingAuthGate: ({
      children,
    }: {
      children: (auth: { signedIn: boolean; bypass: boolean; join: () => void; signIn: () => void }) => ReactNode;
    }) => <>{children({ signedIn: false, bypass: true, join: () => {}, signIn: () => {} })}</>,
  };
});

/** The reserve for the update indicator (bottom left). */
const UPDATE_ROOM = "pl-[4.5rem]";
/** The reserve for the review build's corner button (bottom right). */
const PREVIEW_ROOM = "pr-[4.5rem]";

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(path = "/") {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <StickyCta />
      </MemoryRouter>,
    );
  });
}

function barClasses(): string[] {
  const bar = host?.querySelector("aside");
  if (!bar) throw new Error("the sticky bar did not render");
  return [...bar.classList];
}

beforeEach(() => {
  resetUpdateState();
  // jsdom has no matchMedia; a phone width answers "not pinned".
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  resetUpdateState();
});

describe("StickyCta and the update indicator's corner", () => {
  it("keeps the full width when no build is offered", async () => {
    await mount();
    expect(barClasses()).not.toContain(UPDATE_ROOM);
    expect(barClasses()).toContain("px-4");
  });

  it("leaves the bottom-left corner free while a build is offered", async () => {
    setUpdateWaiting(true);
    await mount();
    expect(barClasses()).toContain(UPDATE_ROOM);
    // tailwind-merge keeps the right gutter: only the left side changes.
    expect(barClasses()).toContain("px-4");
  });

  it("follows the offer as it comes and goes", async () => {
    await mount();
    expect(barClasses()).not.toContain(UPDATE_ROOM);
    await act(async () => setUpdateWaiting(true));
    expect(barClasses()).toContain(UPDATE_ROOM);
    await act(async () => setUpdateWaiting(false));
    expect(barClasses()).not.toContain(UPDATE_ROOM);
  });

  it("keeps both corners free on a preview with a build offered", async () => {
    setUpdateWaiting(true);
    await mount("/preview/home/flagship");
    expect(barClasses()).toContain(UPDATE_ROOM);
    expect(barClasses()).toContain(PREVIEW_ROOM);
  });
});
