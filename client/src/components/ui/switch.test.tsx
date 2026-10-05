// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Switch } from "@/components/ui/switch";

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

describe("Switch busy", () => {
  it("reads as busy, keeps focus, and ignores presses while a write runs", () => {
    const onChange = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root!.render(<Switch checked={false} onCheckedChange={onChange} label="Abrir" busy />),
    );
    const control = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    control.focus();
    act(() => control.click());
    expect(onChange).not.toHaveBeenCalled();
    expect(control.disabled).toBe(false);
    expect(control.getAttribute("aria-disabled")).toBe("true");
    expect(control.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(control);
  });
});

describe("Switch unavailable", () => {
  it("ignores presses and keeps focus without saying it is busy", () => {
    const onChange = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        <Switch checked={false} onCheckedChange={onChange} label="Notificações" unavailable />,
      ),
    );
    const control = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    control.focus();
    act(() => control.click());
    expect(onChange).not.toHaveBeenCalled();
    expect(control.getAttribute("aria-disabled")).toBe("true");
    expect(control.hasAttribute("aria-busy")).toBe(false);
    expect(document.activeElement).toBe(control);
  });
});
