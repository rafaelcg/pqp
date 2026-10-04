// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "@pqp/shared";

/**
 * The shell's section list as the device sees it. On a touch screen with no
 * mouse or trackpad, Atalhos is not in the rail at all: every row in it says
 * shortcuts need a keyboard.
 */

vi.stubEnv("VITE_DEV_AUTH_BYPASS", "true");

const { SettingsModal, defaultLocalSettings } = await import("./settings-modal");
const { TooltipProvider } = await import("@/components/ui/tooltip");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function pointer(kind: "touch" | "mouse") {
  window.matchMedia = ((query: string) => ({
    matches:
      kind === "touch"
        ? query.includes("coarse")
        : query.includes("fine") || query.includes("min-width"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <TooltipProvider>
        <SettingsModal
          open
          user={{ id: "u1", displayName: "Rafa", username: "rafa", handle: null } as unknown as User}
          localSettings={defaultLocalSettings}
          blockedUsers={[]}
          onClose={() => {}}
          onLocalSave={() => {}}
          onUserUpdated={() => {}}
          onUnblockUser={() => {}}
          requestedSection="profile"
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
  Reflect.deleteProperty(window, "matchMedia");
});

describe("Settings shell section list", () => {
  it("hides Atalhos on a touch-only device", () => {
    pointer("touch");
    mount();
    expect(document.querySelector("#settings-tab-keyboard")).toBeNull();
    expect(document.querySelector("#settings-tab-appearance")).not.toBeNull();
    expect(document.querySelector('[role="tablist"]')!.getAttribute("aria-orientation")).toBe(
      "horizontal",
    );
  });

  it("keeps Atalhos where there is a mouse or trackpad", () => {
    pointer("mouse");
    mount();
    expect(document.querySelector("#settings-tab-keyboard")).not.toBeNull();
    expect(document.querySelector('[role="tablist"]')!.getAttribute("aria-orientation")).toBe(
      "vertical",
    );
  });
});

describe("Settings section memory", () => {
  function renderOpen(open: boolean, requestedSection: "profile" | null = null) {
    act(() => {
      root!.render(
        <TooltipProvider>
          <SettingsModal
            open={open}
            user={{ id: "u1", displayName: "Rafa", username: "rafa", handle: null } as unknown as User}
            localSettings={defaultLocalSettings}
            blockedUsers={[]}
            onClose={() => {}}
            onLocalSave={() => {}}
            onUserUpdated={() => {}}
            onUnblockUser={() => {}}
            requestedSection={requestedSection}
          />
        </TooltipProvider>,
      );
    });
  }

  function selected(): string | null {
    return document.querySelector('[role="tab"][aria-selected="true"]')?.id ?? null;
  }

  afterEach(() => {
    window.sessionStorage.clear();
  });

  it("reopens after a reload where it was last closed", () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    renderOpen(true);
    expect(selected()).toBe("settings-tab-profile");
    act(() => document.querySelector<HTMLButtonElement>("#settings-tab-notifications")!.click());
    renderOpen(false);

    // A reload: a fresh mount, nothing in memory but the browser tab's storage.
    act(() => root!.unmount());
    root = createRoot(host);
    renderOpen(true);
    expect(selected()).toBe("settings-tab-notifications");

    // A caller asking for a section still wins.
    renderOpen(false);
    renderOpen(true, "profile");
    expect(selected()).toBe("settings-tab-profile");
  });

  it("starts on Perfil when storage holds nothing it knows", () => {
    window.sessionStorage.setItem("pqp:settings-section", "nonsense");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    renderOpen(true);
    expect(selected()).toBe("settings-tab-profile");
  });
});
