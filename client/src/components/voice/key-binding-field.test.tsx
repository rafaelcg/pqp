// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KeyBindingField,
  PttBindingField,
  bindingKeycaps,
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

  it("stays armed on a conflict and keeps showing the current chord", () => {
    const onChange = vi.fn();
    mount(
      <KeyBindingField
        label="Deafen"
        binding={MUTE}
        takenBy={(next) => (next.code === "KeyD" ? "Mute" : null)}
        onChange={onChange}
      />,
    );
    act(() => field().click());
    press("KeyD", "d", { ctrlKey: true });
    expect(onChange).not.toHaveBeenCalled();
    // Still waiting for a key, with the saved chord dimmed beside the prompt.
    expect(field().getAttribute("aria-pressed")).toBe("true");
    expect(caps()).toEqual(["Shift", "Win", "M"]);
    expect(field().textContent).toContain("Press a key…");
    expect(field().className).toContain("border-accent");
    expect(host!.querySelector('[role="alert"]')).not.toBeNull();

    // A free chord is accepted straight away, and the message goes.
    press("KeyK", "k", { ctrlKey: true });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].code).toBe("KeyK");
    expect(field().getAttribute("aria-pressed")).toBe("false");
    expect(host!.querySelector('[role="alert"]')).toBeNull();
  });

  it("drops the refusal and the arming on Escape", () => {
    mount(
      <KeyBindingField
        label="Deafen"
        binding={MUTE}
        takenBy={() => "Mute"}
        onChange={() => {}}
      />,
    );
    act(() => field().click());
    press("KeyD", "d", { ctrlKey: true });
    press("Escape", "Escape");
    expect(field().getAttribute("aria-pressed")).toBe("false");
    expect(host!.querySelector('[role="alert"]')).toBeNull();
    expect(caps()).toEqual(["Shift", "Win", "M"]);
  });

  it("swaps on Enter only while a conflict is showing", () => {
    const onSwap = vi.fn();
    const onChange = vi.fn();
    mount(
      <KeyBindingField
        label="Deafen"
        binding={MUTE}
        takenBy={() => "Mute"}
        onChange={onChange}
        onSwap={onSwap}
      />,
    );
    act(() => field().click());
    // Enter is a reserved key until there is something to swap.
    press("Enter", "Enter");
    expect(onSwap).not.toHaveBeenCalled();
    expect(host!.querySelector('[role="alert"]')).not.toBeNull();

    press("KeyD", "d", { ctrlKey: true });
    press("Enter", "Enter");
    expect(onSwap).toHaveBeenCalledTimes(1);
    expect(onSwap.mock.calls[0]![0].code).toBe("KeyD");
    expect(onChange).not.toHaveBeenCalled();
    expect(field().getAttribute("aria-pressed")).toBe("false");
  });

  it("refuses a modifier pressed on its own and stays armed", () => {
    const onChange = vi.fn();
    mount(<KeyBindingField label="Mute" binding={MUTE} onChange={onChange} />);
    act(() => field().click());
    press("ShiftLeft", "Shift", { shiftKey: true });
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keyup", { code: "ShiftLeft", key: "Shift", bubbles: true }),
      );
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(field().getAttribute("aria-pressed")).toBe("true");
    expect(host!.querySelector('[role="alert"]')?.textContent).toContain(
      "A modifier alone does not work",
    );
  });

  it("does not end a capture when the parent hands an equal binding", () => {
    mount(<KeyBindingField label="Mute" binding={MUTE} onChange={() => {}} />);
    act(() => field().click());
    act(() =>
      root!.render(
        <KeyBindingField label="Mute" binding={{ ...MUTE }} onChange={() => {}} />,
      ),
    );
    expect(field().getAttribute("aria-pressed")).toBe("true");
    // A different binding does end it.
    act(() =>
      root!.render(
        <KeyBindingField
          label="Mute"
          binding={{ ...MUTE, code: "KeyK", label: "K" }}
          onChange={() => {}}
        />,
      ),
    );
    expect(field().getAttribute("aria-pressed")).toBe("false");
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

describe("bindingKeycaps", () => {
  it("writes Apple modifiers as glyphs in control, option, shift, command order", () => {
    const all = { ...MUTE, ctrl: true, alt: true };
    expect(bindingKeycaps(all, true).keys).toEqual(["⌃", "⌥", "⇧", "⌘", "M"]);
    expect(bindingKeycaps(MUTE, true)).toEqual({
      keys: ["⇧", "⌘", "M"],
      label: "Shift + Command + M",
    });
  });

  it("writes Ctrl, Alt, Shift in that order elsewhere", () => {
    const chord = { ...MUTE, meta: false, ctrl: true, alt: true };
    expect(bindingKeycaps(chord, false)).toEqual({
      keys: ["Ctrl", "Alt", "Shift", "M"],
      label: "Ctrl + Alt + Shift + M",
    });
    expect(bindingKeycaps({ ...MUTE, ctrl: false }, false).keys).toEqual([
      "Shift",
      "Win",
      "M",
    ]);
  });

  it("draws a bare key and a lone modifier as one cap", () => {
    expect(bindingKeycaps(PTT, true).keys).toEqual(["`"]);
    expect(bindingKeycaps({ ...PTT, label: "Shift" }, false).keys).toEqual(["Shift"]);
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

  it("still takes a modifier on its own", () => {
    const saved: PttBinding[] = [];
    mount(
      <PttBindingField
        label="Push-to-talk key"
        binding={PTT}
        onChange={(binding) => saved.push(binding)}
      />,
    );
    act(() => field().click());
    press("ShiftLeft", "Shift", { shiftKey: true });
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keyup", { code: "ShiftLeft", key: "Shift", bubbles: true }),
      );
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.code).toBe("ShiftLeft");
  });

  it("keeps its visible label by default", () => {
    mount(<PttBindingField label="Push-to-talk key" binding={PTT} onChange={() => {}} />);
    expect(host!.querySelector('span[aria-hidden="true"]')?.textContent).toBe(
      "Push-to-talk key",
    );
  });
});
