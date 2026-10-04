// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  SettingsHeaderActions,
  SettingsShellContext,
  useSettingsShell,
  type SettingsShellValue,
} from "@/components/settings/kit/shell-context";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

describe("SettingsHeaderActions", () => {
  it("renders its buttons into the shell's header slot", () => {
    const slot = document.createElement("div");
    document.body.append(slot);
    const shell: SettingsShellValue = {
      profileDirty: false,
      openSection: () => undefined,
      headerActionsSlot: slot,
    };
    mount(
      <SettingsShellContext.Provider value={shell}>
        <div data-tab>
          <SettingsHeaderActions>
            <button type="button">Testar conexão</button>
          </SettingsHeaderActions>
        </div>
      </SettingsShellContext.Provider>,
    );
    expect(slot.querySelector("button")?.textContent).toBe("Testar conexão");
    expect(host!.querySelector("[data-tab] button")).toBeNull();
    slot.remove();
  });

  it("renders nothing outside the dialog", () => {
    mount(
      <SettingsHeaderActions>
        <button type="button">Testar conexão</button>
      </SettingsHeaderActions>,
    );
    expect(document.querySelector("button")).toBeNull();
  });
});

describe("useSettingsShell", () => {
  it("answers clean and a no-op outside the dialog", () => {
    let value: ReturnType<typeof useSettingsShell> | null = null;
    function Probe() {
      value = useSettingsShell();
      return null;
    }
    mount(<Probe />);
    expect(value!.profileDirty).toBe(false);
    expect(value!.profileHandleError).toBeNull();
    expect(() => value!.openSection("voice", "ptt")).not.toThrow();
  });
});
