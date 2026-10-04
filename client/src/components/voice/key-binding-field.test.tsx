// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KeyBindingField,
  PttBindingField,
  type KeyBindingRefusal,
} from "@/components/voice/key-binding-field";
import type { KeyBinding, PttBinding } from "@/components/voice/push-to-talk";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const MUTE: KeyBinding = {
  code: "KeyM",
  label: "M",
  ctrl: false,
  alt: false,
  shift: true,
  meta: true,
};

const PTT: PttBinding = {
  device: "keyboard",
  code: "Backquote",
  label: "`",
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
};

function field(): HTMLButtonElement {
  return host!.querySelector("[data-key-binding-field]")!;
}

function press(code: string, key: string, init: KeyboardEventInit = {}) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code, key, bubbles: true, ...init }),
    );
  });
}

function caps(): string[] {
  return [...field().querySelectorAll("kbd")].map((el) => el.textContent ?? "");
}

describe("KeyBindingField", () => {
  it("draws the label visibly unless hideLabel is set", () => {
    mount(<KeyBindingField label="Mute" binding={MUTE} onChange={() => {}} />);
    expect(host!.querySelector('[aria-hidden="true"]')?.textContent).toBe("Mute");
    act(() => root!.unmount());
    host!.remove();

    mount(
      <KeyBindingField label="Mute" hideLabel binding={MUTE} onChange={() => {}} />,
    );
    expect(host!.querySelector('span[aria-hidden="true"]')).toBeNull();
    // Still named for a screen reader, inside the button.
    expect(field().querySelector(".sr-only")?.textContent).toBe("Mute: ");
  });

  it("shows the refused chord, not the current one, on a conflict", () => {
    const onChange = vi.fn();
    mount(
      <KeyBindingField
        label="Deafen"
        binding={MUTE}
        takenBy={() => "Mute"}
        onChange={onChange}
      />,
    );
    act(() => field().click());
    press("KeyD", "d", { ctrlKey: true });
    expect(onChange).not.toHaveBeenCalled();
    expect(caps()).toEqual(["Ctrl", "D"]);
    expect(field().className).toContain("border-danger");
    expect(host!.querySelector('[role="alert"]')).not.toBeNull();

    // Arming again drops the refused chord and shows the binding.
    act(() => field().click());
    press("Escape", "Escape");
    expect(caps()).toEqual(["Shift", "Cmd", "M"]);
  });

  it("hands the refusal to the caller instead of drawing it", () => {
    const reports: Array<KeyBindingRefusal | null> = [];
    mount(
      <KeyBindingField
        label="Deafen"
        hideLabel
        binding={MUTE}
        takenBy={() => "Mute"}
        onChange={() => {}}
        onRefusedChange={(refusal) => reports.push(refusal)}
      />,
    );
    act(() => field().click());
    press("KeyD", "d", { ctrlKey: true });
    expect(host!.querySelector('[role="alert"]')).toBeNull();
    const last = reports.at(-1);
    expect(last?.message).toBeTruthy();
    expect(field().getAttribute("aria-describedby")).toBe(last?.id);

    act(() => field().click());
    expect(reports.at(-1)).toBeNull();
  });
});

describe("PttBindingField", () => {
  it("saves a lone modifier even when the parent re-renders mid-press", () => {
    // Voz re-renders its pane every meter frame, handing a fresh onChange
    // each time. That used to rebuild the capture listeners between the
    // modifier's keydown and keyup and drop the binding.
    const saved: PttBinding[] = [];
    const render = () =>
      act(() =>
        root!.render(
          <PttBindingField
            label="Push-to-talk key"
            binding={PTT}
            onChange={(binding) => saved.push(binding)}
          />,
        ),
      );
    mount(
      <PttBindingField
        label="Push-to-talk key"
        binding={PTT}
        onChange={(binding) => saved.push(binding)}
      />,
    );
    act(() => field().click());
    press("ControlRight", "Control", { ctrlKey: true });
    render();
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keyup", { code: "ControlRight", key: "Control", bubbles: true }),
      );
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.code).toBe("ControlRight");
  });

  it("keeps its visible label by default", () => {
    mount(<PttBindingField label="Push-to-talk key" binding={PTT} onChange={() => {}} />);
    expect(host!.querySelector('span[aria-hidden="true"]')?.textContent).toBe(
      "Push-to-talk key",
    );
  });
});
