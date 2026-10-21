// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { APP_COLUMN_MIN_PX, APP_COLUMN_STEP_PX } from "@/lib/apps/app-chat-visibility";
import { AppColumnDivider } from "./app-column-divider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(width: number, onCommit: (width: number | null) => void) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <TooltipProvider>
        <AppColumnDivider width={width} body={1600} controls="col" onDrag={() => {}} onCommit={onCommit} />
      </TooltipProvider>,
    ),
  );
  return host.querySelector<HTMLElement>('[role="separator"]')!;
}

const key = (element: HTMLElement, init: KeyboardEventInit) =>
  act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });

describe("the divider between the app and the column", () => {
  it("is a focusable vertical separator that says its width and its ends", () => {
    const separator = render(480, () => {});
    expect(separator.getAttribute("tabindex")).toBe("0");
    expect(separator.getAttribute("aria-orientation")).toBe("vertical");
    expect(separator.getAttribute("aria-valuenow")).toBe("480");
    expect(separator.getAttribute("aria-valuemin")).toBe(String(APP_COLUMN_MIN_PX));
    expect(separator.getAttribute("aria-controls")).toBe("col");
  });

  it("moves with the arrows (left is wider, Shift four times), resets with Enter and a double click", () => {
    const onCommit = vi.fn();
    const separator = render(480, onCommit);
    key(separator, { key: "ArrowLeft" });
    expect(onCommit).toHaveBeenLastCalledWith(480 + APP_COLUMN_STEP_PX);
    key(separator, { key: "ArrowRight", shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(480 - APP_COLUMN_STEP_PX * 4);
    key(separator, { key: "End" });
    expect(onCommit).toHaveBeenLastCalledWith(APP_COLUMN_MIN_PX);
    key(separator, { key: "Enter" });
    expect(onCommit).toHaveBeenLastCalledWith(null);
    act(() => {
      separator.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onCommit).toHaveBeenLastCalledWith(null);
  });
});
