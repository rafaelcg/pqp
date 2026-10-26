// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { vi } from "vitest";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { IconButton } from "@/components/ui/icon-button";
import { TooltipProvider } from "@/components/ui/tooltip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function draw(element: ReactElement): HTMLButtonElement {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(<TooltipProvider>{element}</TooltipProvider>));
  return host.querySelector("button")!;
}

describe("IconButton", () => {
  it("names itself from the label and is a plain button by default", () => {
    const button = draw(<IconButton label="Configurações">⚙</IconButton>);
    expect(button.getAttribute("aria-label")).toBe("Configurações");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-pressed")).toBeNull();
    expect(button.className).toContain("h-8 w-8");
    expect(button.className).toContain("max-sm:h-11");
  });

  it("falls back to today's look when the redesign tokens are unset", () => {
    const { className } = draw(<IconButton label="Fixar">•</IconButton>);
    expect(className).toContain("rounded-[var(--icon-button-radius,var(--radius-control))]");
    expect(className).toContain("hover:bg-[var(--icon-button-hover,var(--color-surface-2))]");
    expect(className).toContain(
      "text-[color:var(--icon-button-text,var(--color-text-tertiary))]",
    );
  });

  it("states a toggle, a size, the danger tone and no touch growth", () => {
    const button = draw(
      <IconButton label="Silenciar" size="xs" tone="danger" pressed touch={false}>
        •
      </IconButton>,
    );
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.className).toContain("h-6 w-6");
    expect(button.className).toContain("hover:text-danger");
    expect(button.className).not.toContain("max-sm:h-11");
  });

  it("lets a call site's own class win", () => {
    const { className } = draw(
      <IconButton label="Remover" className="h-5 w-5 text-danger">
        •
      </IconButton>,
    );
    expect(className).toContain("h-5 w-5");
    expect(className).not.toContain("h-8 w-8");
    expect(className).toContain("text-danger");
  });

  it("owns the glyph size, falling back to what the forum drew", () => {
    expect(draw(<IconButton label="Fixar">•</IconButton>).className).toContain(
      "[&_svg]:size-[var(--icon-button-glyph-md,1rem)]",
    );
    expect(draw(<IconButton label="Menu" size="lg">•</IconButton>).className).toContain(
      "[&_svg]:size-[var(--icon-button-glyph-lg,1.25rem)]",
    );
  });

  it("stays focusable and named when disabled, and does not fire", () => {
    const onClick = vi.fn();
    const button = draw(
      <IconButton label="Notificações" disabled onClick={onClick}>
        •
      </IconButton>,
    );
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Notificações");
    act(() => button.click());
    expect(onClick).not.toHaveBeenCalled();
  });
});
