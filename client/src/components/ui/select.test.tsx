// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { Select } from "@/components/ui/select";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function draw(element: ReactElement): HTMLElement {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(element));
  return host;
}

describe("Select", () => {
  it("keeps the native arrow and today's box with the toggle off", () => {
    const select = draw(
      <Select>
        <option>a</option>
      </Select>,
    ).querySelector("select")!;
    expect(select.className).toContain("[appearance:var(--select-appearance,auto)]");
    expect(select.className).toContain("pr-[var(--select-pr,0.75rem)]");
    expect(select.className).toContain("bg-[color:var(--input-bg,var(--color-surface-0))]");
    expect(select.className).toContain("h-[var(--input-h,var(--control-lg))]");
  });

  it("draws a caret only under the redesign, out of the pointer's way", () => {
    const caret = draw(
      <Select>
        <option>a</option>
      </Select>,
    ).querySelector("svg")!;
    const cls = caret.getAttribute("class")!;
    expect(cls).toContain("hidden");
    expect(cls).toContain("redesign:block");
    expect(cls).toContain("pointer-events-none");
    expect(caret.getAttribute("aria-hidden")).toBe("true");
  });

  it("puts layout on the wrapper and a size on the field", () => {
    const host = draw(
      <Select size="sm" wrapperClassName="sm:w-48" className="text-text-secondary">
        <option>a</option>
      </Select>,
    );
    expect(host.querySelector("span")!.className).toContain("sm:w-48");
    const select = host.querySelector("select")!;
    expect(select.className).toContain("h-[var(--select-h-sm,var(--control-md))]");
    expect(select.className).toContain("text-text-secondary");
  });

  it("fades a disabled field by the shared token and dims the caret with it", () => {
    const host = draw(
      <Select disabled>
        <option>a</option>
      </Select>,
    );
    const select = host.querySelector("select")!;
    expect(select.className).toContain("peer");
    expect(select.className).toContain("disabled:opacity-[var(--input-disabled-opacity,0.5)]");
    expect(select.className).not.toContain("disabled:opacity-50");
    const caret = host.querySelector("svg")!.getAttribute("class")!;
    expect(caret).toContain("redesign:peer-disabled:");
    expect(caret).toContain("redesign:peer-aria-invalid:text-danger");
    expect(caret).toContain("redesign:peer-enabled:peer-hover:not-peer-aria-invalid:text-text-secondary");
    expect(caret).toContain("redesign:peer-focus-visible:not-peer-aria-invalid:text-text-secondary");
    expect(caret).toContain(
      "redesign:peer-disabled:text-[color:color-mix(in_oklab,var(--color-text-tertiary)_70%,transparent)]",
    );
  });
});
