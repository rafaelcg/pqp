// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { REDESIGN_STORAGE_KEY, isRedesignOn } from "@/lib/redesign";
import { ServerRail } from "./server-rail";

/**
 * The foot of the rail: no sparkle (Baú carries the news), the Novo visual
 * switch, and an update button that is there with nothing to take.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <TooltipProvider>
        <ServerRail
          servers={[]}
          selectedServerId={null}
          serverUnread={{}}
          homeSelected={false}
          homeUnread={{ count: 0, mentions: 0 }}
          onSelectHome={() => {}}
          onSelectServer={() => {}}
          onCreateServer={() => {}}
          onJoinServer={() => {}}
          onInvite={() => {}}
          onOpenMembers={() => {}}
          onOpenSettings={() => {}}
          onLeaveServer={() => {}}
          onOpenWhatsNew={() => {}}
        />
      </TooltipProvider>,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("the foot of the rail", () => {
  it("has no What's New sparkle, even with the notes wired", async () => {
    await mount();
    expect(document.querySelector("[data-whats-new-rail]")).toBeNull();
  });

  it("always draws the update button", async () => {
    await mount();
    expect(document.querySelector("[data-update-indicator]")?.getAttribute("data-update-phase")).toBe(
      "current",
    );
  });

  it("flips the look and remembers it", async () => {
    await mount();
    const toggle = document.querySelector<HTMLButtonElement>("[data-new-look-rail]")!;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await act(async () => toggle.click());
    expect(localStorage.getItem(REDESIGN_STORAGE_KEY)).toBe("on");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("wins over a ?redesign= in the address", async () => {
    window.history.replaceState(null, "", "/app?redesign=1&x=2");
    await mount();
    const toggle = document.querySelector<HTMLButtonElement>("[data-new-look-rail]")!;
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await act(async () => toggle.click());
    expect(window.location.search).toBe("?x=2");
    expect(isRedesignOn()).toBe(false);
  });
});
