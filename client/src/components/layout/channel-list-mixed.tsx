import { ArrowDown, ArrowUp, ChevronDown, Pin, Plus } from "lucide-react";
import type { DragEvent, ReactNode } from "react";
import {
  stepInLayout,
  type Channel,
  type SidebarLayout,
} from "@pqp/shared";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  type ContextMenuItemDef,
} from "@/components/ui/context-menu";
import { Menu } from "@/components/ui/menu";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * THE MIXED CHANNEL LIST'S OWN PIECES (`mixed_channel_list`): the category
 * header with its "+" and its drop states, the line that says where a drop
 * lands, the "Criar categoria" row, the loose drop zone, the drag status line
 * and the Organizar canais mode. `channel-list.tsx` keeps the drag state and
 * the rows; this file only draws.
 *
 * Every class here is a role token (`docs/DESIGN.md` Rule 4). Motion is
 * `motion-safe:` only: under reduced motion the line and the highlight simply
 * appear.
 */

export type DropEdge = "before" | "after";

/**
 * Which rows can step up and down (`stepInLayout`'s rules), for the whole
 * list in one pass. Asking `stepInLayout` per row builds a candidate layout
 * each time, which is quadratic on a big server; a step is only computed
 * when it is actually taken.
 */
export function stepAvailability(
  layout: SidebarLayout,
): Map<string, { up: boolean; down: boolean }> {
  const out = new Map<string, { up: boolean; down: boolean }>();
  const groups = [layout.loose, ...layout.categories.map((entry) => entry.children)];
  const lastGroup = groups.length - 1;
  groups.forEach((group, g) => {
    group.forEach((channel, i) => {
      out.set(channel.id, {
        up: i > 0 || g > 0,
        down: i < group.length - 1 || g < lastGroup,
      });
    });
  });
  const categories = layout.categories.length;
  layout.categories.forEach((entry, i) => {
    out.set(entry.category.id, { up: i > 0, down: i < categories - 1 });
  });
  return out;
}

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring";

/** Where a drop lands: 2px of accent between two rows, a ring at its start. */
export function DropLine({ edge }: { edge: DropEdge }) {
  return (
    <span
      aria-hidden="true"
      data-drop-line={edge}
      className={cn(
        "pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-accent",
        edge === "before" ? "-top-0.5" : "-bottom-0.5",
      )}
    >
      <span className="absolute -left-1 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full border-2 border-accent bg-surface-1" />
    </span>
  );
}

export interface CategoryHeaderDrag {
  draggable: boolean;
  /** This header is the one being dragged. */
  dragging: boolean;
  /** "into": a channel would land at the end of it; an edge: a category would land there. */
  drop: "into" | DropEdge | null;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent) => void;
  onDragLeave: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
}

/**
 * A category: the only header the list has. Chevron and name fold it; a
 * folded one says how many channels it holds and shows a dot when one of
 * them is unread. The "+" (managers) creates inside it. Over it, a dragged
 * channel lights the whole header and it says where the channel goes.
 */
export function MixedCategoryHeader({
  category,
  collapsed,
  onToggle,
  childCount,
  hasUnread,
  addItems,
  menuItems,
  drag,
}: {
  category: Channel;
  collapsed: boolean;
  onToggle: () => void;
  childCount: number;
  hasUnread: boolean;
  /** Empty for anybody without MANAGE_CHANNELS: no "+". */
  addItems: ContextMenuItemDef[];
  menuItems: ContextMenuItemDef[];
  drag: CategoryHeaderDrag;
}) {
  const { t } = useTranslation();
  const into = drag.drop === "into";
  return (
    <ContextMenu items={menuItems}>
      <div
        data-category-id={category.id}
        data-drop={drag.drop ?? undefined}
        draggable={drag.draggable}
        onDragStart={drag.onDragStart}
        onDragEnd={drag.onDragEnd}
        onDragOver={drag.onDragOver}
        onDragLeave={drag.onDragLeave}
        onDrop={drag.onDrop}
        className={cn(
          "group/category relative mt-2 flex min-h-7 items-center gap-1 rounded-[var(--radius-control)] px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em]",
          "motion-safe:transition-colors motion-safe:duration-[var(--duration-fast)]",
          into
            ? "bg-accent-soft text-on-accent-soft ring-1 ring-inset ring-accent"
            : "text-text-tertiary hover:text-text-secondary",
          drag.dragging && "opacity-40",
        )}
      >
        {drag.drop === "before" || drag.drop === "after" ? (
          <DropLine edge={drag.drop} />
        ) : null}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className={cn("flex min-w-0 flex-1 items-center gap-1 rounded-sm text-left", FOCUS_RING)}
        >
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "h-3 w-3 shrink-0 motion-safe:transition-transform motion-safe:duration-[var(--duration-fast)]",
              collapsed && "-rotate-90",
            )}
          />
          {/* On the span: a browser resets text-transform on a button. */}
          <span className="truncate uppercase">{category.name}</span>
        </button>
        {into ? (
          <span
            data-category-drop-label=""
            className="shrink-0 text-[10px] font-semibold normal-case tracking-normal"
          >
            {t("chrome.dropOnCategory", { name: category.name })}
          </span>
        ) : collapsed && childCount > 0 ? (
          <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium normal-case tracking-normal text-text-tertiary">
            {t("chrome.categoryChannelCount", { count: childCount })}
            {hasUnread && (
              <>
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-text" />
                <span className="sr-only">{t("chrome.unreadSr")}</span>
              </>
            )}
          </span>
        ) : null}
        {addItems.length > 0 && !into && (
          // The tooltip-free "+": its accessible name says where it creates.
          <Menu items={addItems} align="end">
            <button
              type="button"
              data-category-add=""
              aria-label={t("chrome.createInCategory", { name: category.name })}
              className={cn(
                "flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-text-tertiary hover:bg-surface-2 hover:text-text",
                "opacity-0 group-hover/category:opacity-100 group-focus-within/category:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100",
                FOCUS_RING,
              )}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </Menu>
        )}
      </div>
    </ContextMenu>
  );
}

/** "Vazia. Arrasta um canal pra cá." It is a drop target too. */
export function EmptyCategoryDrop({
  active,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  active: boolean;
  onDragOver: (event: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent) => void;
}) {
  const { t } = useTranslation();
  return (
    <p
      data-testid="empty-category-drop"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        "rounded-[var(--radius-control)] border border-dashed px-2 py-1.5 text-xs italic",
        active
          ? "border-accent bg-accent-soft text-on-accent-soft"
          : "border-transparent text-text-tertiary",
      )}
    >
      {t("chrome.emptyCategory")}
    </p>
  );
}

/**
 * Pinning by drag while nothing is pinned yet. A bar under the list rather
 * than a Pinados section that opens at the top: a section appearing above the
 * rows the moment one is picked up pushes every row down, and the drop lands
 * on the wrong one. Nothing in the list moves while a drag is on.
 */
export function PinDropBar({
  active,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  active: boolean;
  onDragOver: (event: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-pin-drop=""
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        "flex items-center gap-1.5 border-t border-border px-3 py-2 text-xs",
        active ? "bg-accent-soft text-on-accent-soft" : "text-text-secondary",
      )}
    >
      <Pin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {t("chrome.dropToPin")}
    </div>
  );
}

/**
 * The last row, for managers: where the old CATEGORIAS label and its
 * folder-plus button were. While a category is dragged it is also the drop
 * spot for "after the last category".
 */
export function CreateCategoryRow({
  onCreate,
  dropAfterLast,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  onCreate: () => void;
  dropAfterLast: boolean;
  onDragOver: (event: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="relative mt-2"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dropAfterLast && <DropLine edge="before" />}
      <button
        type="button"
        data-create-category=""
        onClick={onCreate}
        className={cn(
          "flex w-full items-center gap-2 rounded-[var(--radius-control)] px-2 py-1.5 text-sm text-text-tertiary hover:bg-surface-2 hover:text-text",
          FOCUS_RING,
        )}
      >
        <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {t("chrome.createCategory")}
      </button>
    </div>
  );
}

/** "Solta pra mover. Esc cancela." under the list while a drag is on. */
export function DragStatus() {
  const { t } = useTranslation();
  return (
    <p
      role="status"
      data-drag-status=""
      className="flex items-center gap-1.5 border-t border-border px-3 py-2 text-xs text-text-secondary"
    >
      <span>{t("chrome.dragStatusDrop")}</span>
      <kbd className="rounded-sm border border-border px-1 py-px font-sans text-[10px] text-text-tertiary">
        Esc
      </kbd>
      <span>{t("chrome.dragStatusCancel")}</span>
    </p>
  );
}

/**
 * ORGANIZAR CANAIS: the list as an edit mode, for a touch screen (HTML5 drag
 * does not exist there) and for anybody who would rather not drag. Every row
 * and every header gets Mover para cima / Mover para baixo, crossing category
 * borders the way the keyboard does (`stepInLayout`). Nothing is sent until
 * Concluir, as ONE full-order write; Cancelar throws the staged order away.
 */
export function OrganizeChannels({
  layout,
  onChange,
  onCancel,
  onDone,
  busy,
  iconFor,
}: {
  layout: SidebarLayout<Channel>;
  onChange: (next: SidebarLayout<Channel>) => void;
  onCancel: () => void;
  onDone: () => void;
  busy: boolean;
  iconFor: (channel: Channel) => ReactNode;
}) {
  const { t } = useTranslation();
  const steps = stepAvailability(layout);
  const step = (id: string, direction: -1 | 1) => {
    const next = stepInLayout(layout, id, direction);
    if (next) {
      onChange(next.layout);
    }
  };

  function row(channel: Channel, isCategory: boolean) {
    const up = steps.get(channel.id)?.up ?? false;
    const down = steps.get(channel.id)?.down ?? false;
    return (
      <li
        key={channel.id}
        data-organize-row={channel.id}
        className={cn(
          "flex min-h-9 items-center gap-2 rounded-[var(--radius-control)] px-2",
          isCategory
            ? "mt-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-tertiary"
            : "text-sm text-text-secondary",
        )}
      >
        {!isCategory && <span className="shrink-0 text-text-tertiary">{iconFor(channel)}</span>}
        <span className="min-w-0 flex-1 truncate">{channel.name}</span>
        <button
          type="button"
          disabled={!up || busy}
          aria-label={t("chrome.moveNamedUp", { name: channel.name })}
          onClick={() => step(channel.id, -1)}
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-text-tertiary hover:bg-surface-2 hover:text-text disabled:opacity-30",
            FOCUS_RING,
          )}
        >
          <ArrowUp className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          disabled={!down || busy}
          aria-label={t("chrome.moveNamedDown", { name: channel.name })}
          onClick={() => step(channel.id, 1)}
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-text-tertiary hover:bg-surface-2 hover:text-text disabled:opacity-30",
            FOCUS_RING,
          )}
        >
          <ArrowDown className="h-4 w-4" aria-hidden="true" />
        </button>
      </li>
    );
  }

  return (
    <section data-organize-channels="" aria-label={t("chrome.organizeChannels")}>
      {/* Title on its own line: the sidebar is 256px, and "Organizar canais"
          between two buttons was cut to "Organizar...". */}
      <h2 className="mb-2 px-2 text-sm font-semibold text-text">{t("chrome.organizeChannels")}</h2>
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {t("chrome.organizeCancel")}
        </Button>
        <Button type="button" size="sm" onClick={onDone} disabled={busy}>
          {t("chrome.organizeDone")}
        </Button>
      </div>
      <p className="mb-2 px-2 text-xs text-text-tertiary">{t("chrome.organizeTipButtons")}</p>
      <ul>
        {layout.loose.map((channel) => row(channel, false))}
        {layout.categories.map((entry) => (
          <li key={entry.category.id}>
            <ul>
              {row(entry.category, true)}
              {entry.children.length === 0 ? (
                <li className="px-2 py-1 text-xs italic text-text-tertiary">
                  {t("chrome.emptyCategoryShort")}
                </li>
              ) : (
                entry.children.map((channel) => row(channel, false))
              )}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
