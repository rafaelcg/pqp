// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Tooltip, TooltipProvider } from "./tooltip";

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

async function focusTrigger(disabled: boolean) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <TooltipProvider>
        <Tooltip label="geral" disabled={disabled}>
          <button type="button">row</button>
        </Tooltip>
      </TooltipProvider>,
    );
  });
  const trigger = host.querySelector("button")!;
  await act(async () => {
    trigger.focus();
  });
  return trigger;
}

describe("Tooltip disabled", () => {
  it("opens on focus by default", async () => {
    await focusTrigger(false);
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
  });

  it("never opens, and the trigger keeps its name", async () => {
    const trigger = await focusTrigger(true);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(trigger.getAttribute("aria-label")).toBe("geral");
  });
});
