// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { Bell, Hash } from "@phosphor-icons/react";
import { describe, expect, it } from "vitest";
import { Icon } from "@/components/ui/icon";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function draw(element: ReactElement): HTMLElement {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(element));
  return host;
}

describe("Icon", () => {
  it("fills an object and hides it from assistive tech by default", () => {
    const svg = draw(<Icon icon={Bell} />).querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("class")).toContain("h-[var(--icon-md)]");
  });

  it("draws a symbol in the bold weight, which differs from the fill", () => {
    const bold = draw(<Icon icon={Hash} kind="symbol" />).innerHTML;
    const fill = draw(<Icon icon={Hash} />).innerHTML;
    expect(bold).not.toBe(fill);
  });

  it("names itself when it is the only label", () => {
    const svg = draw(<Icon icon={Bell} size="lg" label="Notificações" />).querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Notificações");
    expect(svg.getAttribute("aria-hidden")).toBeNull();
    expect(svg.getAttribute("class")).toContain("h-[var(--icon-lg)]");
  });
});
