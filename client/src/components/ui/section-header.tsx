import type { ElementType, ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";

/**
 * Headings for a pane and for a section inside it.
 *
 * `PaneHeader` is the title of a settings pane or any dialog pane that
 * switches by section: the title, one line saying what the pane is for, and
 * the header actions. `SectionLabel` is the small heading over a group in a
 * list, a popover or a dialog ("Cargos", "Atalhos", "Qualidade").
 *
 * With the toggle off each caller passes the classes it always drew (sizes,
 * tracking, colours differ by screen) and `cn` keeps them. Under the
 * redesign the classes below come last and win, so every pane title and
 * every section label read the same: a Gabarito title, and a sentence-case
 * label with no tracking. A label's text is written in sentence case; the
 * old look upper-cases it with CSS.
 */
export const PANE_HEADER_REDESIGN =
  "redesign:mb-[var(--pane-header-gap)] redesign:gap-4";
export const PANE_TITLE_REDESIGN =
  "redesign:font-[family-name:var(--type-title-font)] redesign:text-[length:var(--pane-header-title-size)] redesign:leading-tight redesign:font-bold redesign:text-text";
export const PANE_DESCRIPTION_REDESIGN =
  "redesign:mt-1 redesign:text-sm redesign:text-pretty redesign:text-text-secondary";
export const SECTION_LABEL_REDESIGN =
  "redesign:font-sans redesign:text-[length:var(--section-label-size)] redesign:leading-4 redesign:font-semibold redesign:normal-case redesign:tracking-normal redesign:text-text-secondary";

export function PaneHeader({
  title,
  description,
  actions,
  actionsRef,
  as: Title = "h3",
  className,
  titleClassName,
  descriptionClassName,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Buttons on the title line. */
  actions?: ReactNode;
  /** A slot other code portals actions into (the settings shell). */
  actionsRef?: Ref<HTMLDivElement>;
  as?: "h2" | "h3";
  /** The toggle-off look, per caller. */
  className?: string;
  titleClassName?: string;
  descriptionClassName?: string;
}) {
  return (
    <header className={cn("flex items-start justify-between", className, PANE_HEADER_REDESIGN)}>
      <div className="min-w-0">
        <Title className={cn(titleClassName, PANE_TITLE_REDESIGN)}>{title}</Title>
        {description ? (
          <p className={cn(descriptionClassName, PANE_DESCRIPTION_REDESIGN)}>
            {description}
          </p>
        ) : null}
      </div>
      {/* `empty:hidden` keeps an empty slot from claiming the gap. */}
      {actions || actionsRef ? (
        <div ref={actionsRef} className="flex shrink-0 items-center gap-2 empty:hidden">
          {actions}
        </div>
      ) : null}
    </header>
  );
}

export function SectionLabel({
  as: Tag = "h3",
  id,
  tone,
  className,
  children,
}: {
  as?: ElementType;
  id?: string;
  /** A danger zone's heading keeps its tone under the redesign. */
  tone?: "danger";
  /** The toggle-off look: size, tracking, colour and spacing. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag
      id={id}
      data-section-label=""
      className={cn(className, SECTION_LABEL_REDESIGN, tone === "danger" && "redesign:text-danger")}
    >
      {children}
    </Tag>
  );
}
