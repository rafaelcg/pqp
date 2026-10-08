// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@pqp/shared";

/**
 * `openSection(section, rowId)` when the row is not on screen: the pane lands
 * at the top of the section, nothing throws, nothing logs, and nothing
 * flashes. Atalhos jumps to Voz's "ptt", which Voz only draws in push-to-talk
 * mode. Perfil is replaced by a probe that calls the seam.
 */

vi.stubEnv("VITE_DEV_AUTH_BYPASS", "true");

vi.mock("@/components/settings/profile-section", async () => {
  const { useSettingsShell } = await import("@/components/settings/kit");
  return {
    ProfileSection: () => {
      const { openSection } = useSettingsShell();
      return (
        <div>
          <div data-settings-row="present" style={{ height: 2000 }} />
          <button type="button" data-go-missing="" onClick={() => openSection("profile", "missing")}>
            missing
          </button>
          <button type="button" data-go-present="" onClick={() => openSection("profile", "present")}>
            present
          </button>
          <button type="button" data-go-help="" onClick={() => openSection("help")}>
            help
          </button>
        </div>
      );
    },
  };
});

const { SettingsModal, defaultLocalSettings } = await import("./settings-modal");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { ROW_FLASH_CLASSES } = await import("@/components/settings/kit/flash-row");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

const scroller = () => document.getElementById("settings-panel")!;

describe("openSection with a row id", () => {
  it("lands at the top of the section when the row is not there", () => {
    const errors = vi.spyOn(console, "error");
    mount();
    scroller().scrollTop = 300;
    expect(scroller().scrollTop).toBe(300);
    act(() => document.querySelector<HTMLButtonElement>("[data-go-missing]")!.click());
    expect(scroller().scrollTop).toBe(0);

    // The retries run out quietly.
    act(() => vi.advanceTimersByTime(2000));
    expect(scroller().scrollTop).toBe(0);
    expect(document.querySelector(`.${ROW_FLASH_CLASSES[0]}`)).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });

  it("lands on the new tab's panel when the switch took the focused button away", () => {
    mount();
    const go = document.querySelector<HTMLButtonElement>("[data-go-help]")!;
    act(() => go.focus());
    act(() => go.click());
    expect(go.isConnected).toBe(false);
    expect(document.activeElement).toBe(scroller());
  });

  it("still flashes a row that is there", () => {
    mount();
    act(() => document.querySelector<HTMLButtonElement>("[data-go-present]")!.click());
    const row = document.querySelector('[data-settings-row="present"]')!;
    expect(row.classList.contains(ROW_FLASH_CLASSES[0])).toBe(true);
  });
});
