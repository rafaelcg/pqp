import { Bell } from "lucide-react";
import { forwardRef, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  MENU_BUTTON_ICON,
  MENU_ICON,
  MENU_ROW,
  MENU_HEADING,
  MENU_HEADING_REDESIGN,
  MENU_ROW_BUTTON,
  MENU_SEPARATOR,
  MENU_SURFACE,
  MenuItemRows,
  type MenuItemComponentProps,
} from "@/components/ui/menu-items";

const Item = forwardRef<HTMLDivElement, MenuItemComponentProps>(function Item(
  { className, children, disabled, "data-menu-item": id },
  ref,
) {
  return (
    <div ref={ref} className={className} data-menu-item={id} data-disabled={disabled ? "" : undefined}>
      {children as ReactNode}
    </div>
  );
});

function Separator({ className }: { className?: string }) {
  return <hr className={className} />;
}

function rows() {
  return renderToStaticMarkup(
    <MenuItemRows
      Item={Item}
      Separator={Separator}
      items={[
        { id: "h", label: "Notificações", heading: true },
        { id: "all", label: "Todas", icon: Bell, checked: true },
        { id: "sep", label: "", separator: true },
        { id: "leave", label: "Sair", icon: Bell, danger: true },
      ]}
    />,
  );
}

describe("menu recipe", () => {
  it("draws today's surface and row when the tokens are unset", () => {
    expect(MENU_SURFACE).toContain("elevation-3");
    expect(MENU_SURFACE).toContain("rounded-[var(--popover-radius,var(--radius-card))]");
    expect(MENU_SURFACE).toContain("p-[var(--menu-pad,0.25rem)]");
    expect(MENU_ROW).toContain("rounded-[var(--menu-row-radius,var(--radius-control))]");
    expect(MENU_ROW).toContain("py-[var(--menu-row-py,0.375rem)]");
    expect(MENU_ROW).toContain("data-[highlighted]:bg-[color:var(--menu-row-hover,var(--color-surface-2))]");
    expect(MENU_ROW).toContain("data-[disabled]:opacity-[var(--menu-disabled-opacity,0.4)]");
    expect(MENU_SEPARATOR).toContain("bg-[color:var(--menu-separator,var(--color-border))]");
  });

  it("floats on the popover surface and fades only the icon and label of a disabled row under the redesign", () => {
    expect(MENU_SURFACE).toContain("redesign:[--elevation-3-surface:var(--popover-surface)]");
    expect(MENU_ROW).toContain("redesign:data-[disabled]:opacity-100");
    expect(MENU_HEADING).toContain("redesign:normal-case");
    expect(MENU_HEADING).toContain("redesign:text-text-secondary");
    expect(MENU_HEADING).toContain(MENU_HEADING_REDESIGN);
  });

  it("gives a hand-built row the same shape, highlighted on hover and focus", () => {
    expect(MENU_ROW_BUTTON).toContain("rounded-[var(--menu-row-radius,var(--radius-control))]");
    expect(MENU_ROW_BUTTON).toContain("hover:bg-[color:var(--menu-row-hover,var(--color-surface-2))]");
    expect(MENU_ROW_BUTTON).toContain("focus-visible:bg-[color:var(--menu-row-hover,var(--color-surface-2))]");
  });

  it("draws an icon in the label's colour unless the redesign quiets it", () => {
    expect(MENU_ICON).toContain("text-[color:var(--menu-icon,currentColor)]");
    expect(MENU_ICON).toContain("group-data-[highlighted]/menu-row:text-current");
    expect(MENU_ICON).toContain("size-[var(--menu-icon-size,0.875rem)]");
    expect(MENU_ICON).not.toContain("group-hover/menu-row");
    expect(MENU_BUTTON_ICON).toContain("group-hover/menu-row:text-current");
    // Under the redesign only focus fills a button row and lifts its icon.
    expect(MENU_ROW_BUTTON).toContain("redesign:hover:bg-transparent");
    expect(MENU_ROW_BUTTON).toContain("redesign:focus:bg-[color:var(--menu-row-hover)]");
    expect(MENU_BUTTON_ICON).toContain("redesign:group-focus/menu-row:text-current");
    expect(MENU_ICON).toContain("redesign:[stroke-width:var(--icon-stroke)]");
  });

  it("keeps a danger row's icon red", () => {
    const html = rows();
    const leave = /<div[^>]*data-menu-item="leave"[^>]*>/.exec(html)?.[0] ?? "";
    expect(leave).toContain("text-danger");
    expect(leave).toContain("[--menu-icon:currentColor]");
  });

  it("draws the tick in Lucide with the toggle off and Phosphor under the redesign", () => {
    const html = rows();
    expect(html).toContain("lucide-check");
    expect(html).toContain("redesign:hidden");
    expect(html).toContain("hidden size-4 shrink-0 text-accent redesign:block");
  });

  it("sets a heading in sentence case only under the redesign", () => {
    const html = rows();
    const heading = /<div[^>]*data-menu-heading="h"[^>]*>/.exec(html)?.[0] ?? "";
    expect(heading).toContain(" uppercase ");
    expect(heading).toContain("redesign:normal-case");
  });
});
