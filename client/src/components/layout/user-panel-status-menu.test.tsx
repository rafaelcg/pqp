// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UserPanel } from "./user-panel";

/**
 * The status popover's open/close race (criterion 47,
 * `docs/plans/DM_NOTIFICATIONS_POLISH.md` §8.3): a real click is mousedown
 * THEN click, and the popover's own "click outside closes it" listener is a
 * raw `document.addEventListener("mousedown", ...)` — so a second click on
 * the AVATAR ITSELF, meant to close an open menu, fired that outside-click
 * handler first (the trigger button is outside `popoverRef`, same as
 * anything else on the page) and then the button's own `onClick` toggle ran
 * on top of it, reopening what the mousedown had just closed. Net effect:
 * the menu never closed on a second click, only on Escape or a click
 * elsewhere. `renderToStaticMarkup` (`user-panel-custom-status.test.tsx`)
 * cannot reach this — it never dispatches events — so this one mounts for
 * real and fires both halves of a click in order, the way a browser does.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function panel() {
  mount(
    <TooltipProvider>
      <UserPanel
        displayName="Ana"
        tag="ana#0001"
        handle={null}
        avatarUrl={null}
        isMuted={false}
        isDeafened={false}
        inVoice={false}
        showUserButton={false}
        manualStatus="online"
        effectiveStatus="online"
        statusSaving={false}
        statusError={null}
        onSetStatus={() => {}}
        customStatus=""
        customStatusSaving={false}
        customStatusError={null}
        onSetCustomStatus={() => {}}
        onClearCustomStatusError={() => {}}
        onToggleMute={() => {}}
        onToggleDeafen={() => {}}
        onOpenSettings={() => {}}
        onOpenFeedback={() => {}}
        onOpenProfile={() => {}}
      />
    </TooltipProvider>,
  );
}

function avatarButton(): HTMLButtonElement {
  return document.querySelector('button[aria-haspopup="menu"]')!;
}

function statusGroup(): Element | null {
  return document.querySelector('[role="group"]');
}

/** Mousedown then click, in that order, bubbling — same as a real click. */
function realClick(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("the status popover's own trigger", () => {
  it("opens on a click and closes on a second click on the same button", () => {
    panel();
    expect(statusGroup()).toBeNull();

    realClick(avatarButton());
    expect(statusGroup()).not.toBeNull();

    realClick(avatarButton());
    expect(statusGroup()).toBeNull();
  });

  it("still closes on a click genuinely outside it", () => {
    panel();
    realClick(avatarButton());
    expect(statusGroup()).not.toBeNull();

    act(() => {
      document.body.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
    });
    expect(statusGroup()).toBeNull();
  });
});
