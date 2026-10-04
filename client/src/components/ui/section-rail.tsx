import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { LucideIcon } from "lucide-react";
import { SM_UP_QUERY, useMediaQuery } from "@/components/ui/use-media-query";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * How long an arrow key rests on a tab before the tab opens. The arrows move
 * focus at once; the selection follows when the person stops on a tab.
 * Flipping through the rail used to mount every tab on the way, and Voz e
 * vídeo asks for the microphone when it mounts. A click, Enter or Space opens
 * a tab at once, and leaving the rail opens the focused one.
 */
export const RAIL_ARROW_SELECT_DELAY_MS = 300;

export interface SectionRailItem<Id extends string = string> {
  id: Id;
  label: string;
  icon: LucideIcon;
  danger?: boolean;
  dirty?: boolean;
  /**
   * Key into `groupLabels`. Items of one group must be adjacent. A group with
   * no label is drawn as a divider instead of a heading.
   */
  group?: string;
}

/**
 * Settings section rail. Shared by account, community and channel settings so
 * the three dialogs walk the same way: a real tablist, arrow keys, icon + label,
 * horizontal strip on phones.
 *
 * Group headings and dividers sit inside the tablist as presentation-only
 * elements: the arrow keys address `[role="tab"]` only, so a heading never
 * takes a keystroke, and a screen reader still counts exactly the tabs. A
 * tablist may only own tabs, so the group name reaches assistive tech as each
 * tab's description ("Perfil, Conta") rather than as a `role="group"` wrapper.
 * Both are hidden on the phone strip, where they would only push tabs off
 * screen.
 *
 * A dirty tab says so in words too: the dot is decoration, and its
 * description reads "alterações não salvas". A description, not a longer
 * name, so `getByRole("tab", { name: "Perfil" })` still finds the tab. On the
 * phone strip a dirty tab that is not the selected one sticks to the start
 * edge, so the edits stay in sight while the person is three tabs away.
 *
 * `footer` renders after the tablist, outside it, on `sm` and up: a tablist's
 * children are tabs, and anything else in it lies about how many there are.
 */
export function SectionRail<Id extends string>({
  sections,
  active,
  onSelect,
  idFor,
  panelId,
  label,
  groupLabels,
  footer,
  className,
  fadeEnd = false,
}: {
  sections: readonly SectionRailItem<Id>[];
  active: Id;
  onSelect: (id: Id) => void;
  idFor: (id: Id) => string;
  panelId: string;
  label: string;
  groupLabels?: Record<string, string>;
  /** After the tablist, `sm` and up only. */
  footer?: ReactNode;
  /** Width and strip height. Defaults keep `sm:w-56`. */
  className?: string;
  /** Phone strip: fade the right edge while more tabs are off screen. */
  fadeEnd?: boolean;
}) {
  const { t } = useTranslation();
  const railRef = useRef<HTMLDivElement>(null);
  const [moreAfter, setMoreAfter] = useState(false);
  const vertical = useMediaQuery(SM_UP_QUERY, true);
  const baseId = useId();
  const groupId = (group: string) => `${baseId}-group-${group}`;
  const dirtyId = `${baseId}-dirty`;
  // The tab an arrow key landed on, waiting to be opened.
  const pending = useRef<{ timer: number; id: Id } | null>(null);

  function cancelPending() {
    if (pending.current) {
      window.clearTimeout(pending.current.timer);
      pending.current = null;
    }
  }

  function commitPending() {
    const waiting = pending.current;
    if (!waiting) {
      return;
    }
    cancelPending();
    if (waiting.id !== active) {
      onSelect(waiting.id);
    }
  }

  // An unmount drops the wait: a closed dialog has nothing left to open.
  useEffect(() => cancelPending, []);

  // The selected tab is always on screen, including the phone strip, where
  // seven of ten tabs start off the right edge. A dirty tab pinned to the
  // strip's start would cover it, so the scroll leaves that much room.
  // Optional call: jsdom has no `scrollIntoView`.
  useEffect(() => {
    const rail = railRef.current;
    const index = sections.findIndex((section) => section.id === active);
    const tabs = rail?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    if (rail) {
      const pinned = rail.querySelector<HTMLElement>("[data-rail-pinned]");
      const room = pinned && !vertical ? pinned.offsetWidth : 0;
      rail.style.scrollPaddingInlineStart = room ? `${room + 8}px` : "";
    }
    tabs?.[index]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active, sections, vertical]);

  // The fade says "there is more this way" and goes once the strip is at its
  // end. Measured, not assumed: on a desktop the rail is vertical and never
  // scrolls sideways, so the fade never shows there.
  useEffect(() => {
    if (!fadeEnd) {
      return;
    }
    const rail = railRef.current;
    if (!rail) {
      return;
    }
    const sync = () =>
      setMoreAfter(rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 1);
    sync();
    rail.addEventListener("scroll", sync, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(rail);
    return () => {
      rail.removeEventListener("scroll", sync);
      observer?.disconnect();
    };
  }, [fadeEnd]);

  function tabElements(): HTMLButtonElement[] {
    return [
      ...(railRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ??
        []),
    ];
  }

  function move(to: number) {
    const index = (to + sections.length) % sections.length;
    const next = sections[index]!;
    tabElements()[index]?.focus();
    cancelPending();
    if (next.id === active) {
      return;
    }
    const timer = window.setTimeout(() => {
      pending.current = null;
      onSelect(next.id);
    }, RAIL_ARROW_SELECT_DELAY_MS);
    pending.current = { timer, id: next.id };
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    const to = event.relatedTarget as Node | null;
    if (!to || !railRef.current?.contains(to)) {
      commitPending();
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // From the focused tab, not the selected one: two quick presses walk two
    // tabs even though the first has not opened yet.
    const focused = tabElements().indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const current =
      focused >= 0
        ? focused
        : sections.findIndex((section) => section.id === active);
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        move(current + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        move(current - 1);
        break;
      case "Home":
        event.preventDefault();
        move(0);
        break;
      case "End":
        event.preventDefault();
        move(sections.length - 1);
        break;
      default:
        break;
    }
  }

  const tablist = (
    <div
      ref={railRef}
      role="tablist"
      aria-label={label}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      data-fade-end={fadeEnd && moreAfter ? "" : undefined}
      className={cn(
        "flex shrink-0 gap-1 overflow-x-auto px-3 py-2",
        "sm:flex-col sm:overflow-x-hidden sm:overflow-y-auto sm:px-3 sm:py-4",
        // The last 32px of the strip fade out while tabs remain past the edge.
        "max-sm:data-[fade-end]:[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]",
        footer
          ? "min-h-0 flex-1 max-sm:items-center"
          : cn(
              "border-b border-border sm:w-56 sm:border-b-0 sm:border-r",
              className,
            ),
      )}
    >
      {sections.map((section, index) => {
        const selected = section.id === active;
        const Icon = section.icon;
        const previous = sections[index - 1];
        const startsGroup =
          section.group !== undefined && section.group !== previous?.group;
        const heading = startsGroup ? groupLabels?.[section.group!] : undefined;
        const groupName =
          section.group !== undefined ? groupLabels?.[section.group] : undefined;
        const describedBy =
          [
            groupName ? groupId(section.group!) : null,
            section.dirty ? dirtyId : null,
          ]
            .filter(Boolean)
            .join(" ") || undefined;
        // Only off the selected tab: the selected one is already in view.
        const pinned = Boolean(section.dirty) && !selected;
        return (
          <Fragment key={section.id}>
            {startsGroup && heading ? (
              <div
                id={groupId(section.group!)}
                role="presentation"
                aria-hidden="true"
                className="hidden px-3 pb-1 pt-4 text-xs font-medium text-text-tertiary first:pt-0 sm:block"
              >
                {heading}
              </div>
            ) : null}
            {startsGroup && !heading && index > 0 ? (
              <div
                role="presentation"
                aria-hidden="true"
                className="mx-3 my-2 hidden border-t border-border sm:block"
              />
            ) : null}
            <button
              id={idFor(section.id)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId}
              aria-describedby={describedBy}
              tabIndex={selected ? 0 : -1}
              data-rail-pinned={pinned ? "" : undefined}
              onClick={() => {
                cancelPending();
                onSelect(section.id);
              }}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-[var(--radius-control)] px-3 py-2 text-sm whitespace-nowrap transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring sm:w-full",
                selected
                  ? "bg-accent/12 font-medium text-text"
                  : "text-text-tertiary hover:bg-surface-2 hover:text-text",
                section.danger && !selected && "text-danger/80",
                // Phone strip: stays at the start edge while the strip scrolls.
                pinned &&
                  "max-sm:sticky max-sm:left-0 max-sm:z-10 max-sm:bg-surface-2 max-sm:text-text",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0">{section.label}</span>
              {section.dirty ? (
                <span
                  data-rail-dirty
                  className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                  aria-hidden
                />
              ) : null}
            </button>
          </Fragment>
        );
      })}
      {/* What a dirty tab's description reads. `hidden` keeps it out of the
          layout and the reading order; `aria-describedby` still reads it. */}
      {sections.some((section) => section.dirty) ? (
        <span id={dirtyId} hidden>
          {t("settings.nav.unsaved")}
        </span>
      ) : null}
    </div>
  );

  if (!footer) {
    return tablist;
  }

  return (
    <div
      className={cn(
        "flex shrink-0 flex-col border-b border-border sm:w-56 sm:border-b-0 sm:border-r",
        className,
      )}
    >
      {tablist}
      <div className="hidden shrink-0 border-t border-border px-3 pt-3 pb-4 sm:block">
        {footer}
      </div>
    </div>
  );
}
