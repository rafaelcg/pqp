import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Ban, Tag as TagGlyph } from "lucide-react";
import { FORUM_TAG_ICON_KEYS, type ForumTag, type ForumTagIconKey } from "@pqp/shared";
import { Tooltip } from "@/components/ui/tooltip";
import { ForumTagIcon } from "@/components/forum/forum-tag-icon";
import { placeAnchoredPanel } from "@/lib/anchored-panel";
import {
  FORUM_TAG_ICON_COMPONENTS,
  FORUM_TAG_ICON_LABELS,
} from "@/lib/forum-tag-icons";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const COLUMNS = 6;
/** 6 cells of 40px, the gaps and the padding; 7 rows hold "no icon" and every icon. */
const PANEL_SIZE = { width: 6 * 40 + 5 * 4 + 24, height: 7 * 40 + 6 * 4 + 24 } as const;

/**
 * The square at the start of a tag row. Shows the tag's icon (or its legacy
 * emoji, or a dashed tag glyph when it has neither) and opens a grid of the
 * curated icons, each with its name.
 *
 * Keyboard: Enter or Space on the square opens it with the current icon
 * focused; the arrows move across the grid (Home and End jump to the first
 * and last), Enter or Space picks, Escape closes and gives the focus back to
 * the square (and, being caught at the window first, never reaches the
 * settings sheet's own Escape, which asks "leave without saving?"), Tab
 * closes it and carries on to the next control. A pointer outside, or a
 * scroll, closes it. It is portalled out of the settings sheet so the rows'
 * rounded, clipped card cannot cut it off.
 *
 * Motion is the panel fading in and the chosen icon popping into the square,
 * both through classes the reduced-motion block of `index.css` already turns
 * off.
 */
export function ForumTagIconPicker({
  tag,
  label,
  open,
  onToggle,
  onPick,
  onClose,
  disabled = false,
}: {
  /** What the square shows now. A preview of a tag not saved yet is fine. */
  tag: Pick<ForumTag, "icon" | "emoji">;
  /** The square's accessible name, naming the tag it belongs to. */
  label: string;
  open: boolean;
  onToggle: () => void;
  /** `null` is "no icon". */
  onPick: (icon: ForumTagIconKey | null) => void;
  onClose: () => void;
  disabled?: boolean;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  return (
    <span className="relative shrink-0">
      <Tooltip label={label}>
        <button
          ref={buttonRef}
          type="button"
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={label}
          onClick={onToggle}
          data-forum-tag-icon-button=""
          className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] border border-border bg-surface-0 text-text-secondary hover:border-border-strong hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-40 sm:h-8 sm:w-8"
        >
          {tag.icon || tag.emoji ? (
            <span
              // Re-mounted per icon so a new pick pops in.
              key={tag.icon ?? tag.emoji}
              className="flex motion-safe:animate-icon-swap"
            >
              <ForumTagIcon tag={tag} className="h-4 w-4" />
            </span>
          ) : (
            <TagGlyph className="h-4 w-4 text-text-tertiary" aria-hidden="true" />
          )}
        </button>
      </Tooltip>
      {open && (
        <IconGrid
          selected={tag.icon ?? null}
          anchor={buttonRef}
          onPick={(icon) => {
            onPick(icon);
            buttonRef.current?.focus();
          }}
          onClose={() => {
            onClose();
            buttonRef.current?.focus();
          }}
          onDismiss={onClose}
        />
      )}
    </span>
  );
}

function IconGrid({
  selected,
  anchor,
  onPick,
  onClose,
  onDismiss,
}: {
  selected: ForumTagIconKey | null;
  anchor: React.RefObject<HTMLButtonElement | null>;
  onPick: (icon: ForumTagIconKey | null) => void;
  onClose: () => void;
  /** Close without stealing the focus back (Tab, a click elsewhere, a scroll). */
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [placement, setPlacement] = useState<ReturnType<typeof placeAnchoredPanel> | null>(
    null,
  );
  // Cell 0 is "no icon", the icons follow it. Focus starts on the current one.
  const cells: Array<ForumTagIconKey | null> = [null, ...FORUM_TAG_ICON_KEYS];
  const [active, setActive] = useState(() => (selected ? cells.indexOf(selected) : 0));

  useLayoutEffect(() => {
    function place() {
      const el = anchor.current;
      if (!el) {
        return;
      }
      setPlacement(
        placeAnchoredPanel(
          el.getBoundingClientRect(),
          PANEL_SIZE,
          { width: window.innerWidth, height: window.innerHeight },
          "below",
        ),
      );
    }
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);

  useEffect(() => {
    cellRefs.current[active]?.focus();
    // Only when the panel opens and when the roving cell moves.
  }, [active, placement !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || anchor.current?.contains(target)) {
        return;
      }
      onDismiss();
    }
    // Escape belongs to the picker while it is open: caught first, at the
    // window, so the settings sheet behind it does not also ask to close.
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
    let armed = false;
    const arm = window.setTimeout(() => {
      armed = true;
    }, 80);
    function onScroll(event: Event) {
      if (armed && !panelRef.current?.contains(event.target as Node)) {
        onDismiss();
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      window.clearTimeout(arm);
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor, onClose, onDismiss]);

  function onCellKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = cells.length - 1;
    let next: number | null = null;
    switch (event.key) {
      case "ArrowRight":
        next = Math.min(last, index + 1);
        break;
      case "ArrowLeft":
        next = Math.max(0, index - 1);
        break;
      case "ArrowDown":
        next = index + COLUMNS <= last ? index + COLUMNS : index;
        break;
      case "ArrowUp":
        next = index - COLUMNS >= 0 ? index - COLUMNS : index;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      case "Tab":
        // Leave the grid for the next control after the square.
        anchor.current?.focus();
        onDismiss();
        return;
      default:
        return;
    }
    event.preventDefault();
    setActive(next);
  }

  const panel = (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("forum.settings.icon.pickerLabel")}
      data-forum-tag-icon-picker=""
      style={{
        position: "fixed",
        top: placement?.top ?? 0,
        left: placement?.left ?? 0,
        maxHeight: placement?.maxHeight,
        maxWidth: placement?.maxWidth,
        visibility: placement ? "visible" : "hidden",
      }}
      className="elevation-3 z-[120] overflow-y-auto rounded-[var(--radius-card)] border border-border bg-surface-1 p-3 motion-safe:animate-fade-in"
    >
      <div
        role="radiogroup"
        aria-label={t("forum.settings.icon.pickerLabel")}
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${COLUMNS}, 2.5rem)` }}
      >
        {cells.map((key, index) => {
          const Icon = key ? FORUM_TAG_ICON_COMPONENTS[key] : Ban;
          const name = key ? t(FORUM_TAG_ICON_LABELS[key]) : t("forum.settings.icon.none");
          const isSelected = key === selected;
          return (
            <Tooltip key={key ?? "none"} label={name}>
              <button
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-label={name}
                data-forum-tag-icon-option={key ?? "none"}
                tabIndex={index === active ? 0 : -1}
                ref={(node) => {
                  cellRefs.current[index] = node;
                }}
                onFocus={() => setActive(index)}
                onKeyDown={(event) => onCellKeyDown(event, index)}
                onClick={() => onPick(key)}
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                  isSelected
                    ? "bg-accent-soft text-on-accent-soft"
                    : "text-text-secondary hover:bg-surface-2 hover:text-text",
                  key === null && "border border-dashed border-border",
                )}
              >
                <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
              </button>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );

  return createPortal(panel, document.body);
}
