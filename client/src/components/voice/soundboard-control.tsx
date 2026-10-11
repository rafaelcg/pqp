import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { CircleAlert, Lock, PartyPopper, Plus, Volume2, VolumeX, X } from "lucide-react";
import { SOUNDBOARD_BUILTINS, type SoundboardBuiltinId } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { useMediaQuery } from "@/components/ui/use-media-query";
import { Tooltip, useFullscreenPortalHost } from "@/components/ui/tooltip";
import { useVoiceConfig } from "@/hooks/use-voice-config";
import { placeAnchoredPanel } from "@/lib/anchored-panel";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import {
  soundboardIcon,
  type SoundboardIcon,
} from "@/lib/soundboard-icons";
import {
  prefetchSoundboard,
  refreshSoundboardCatalog,
  requestSoundboardPlay,
  setSoundboardCatalogServer,
  useSoundboardActiveIds,
  useSoundboardCatalog,
  useSoundboardListenerVolume,
  useSoundboardMuted,
  useSoundboardRefused,
} from "@/lib/soundboard";
import { cn } from "@/lib/utils";
import { SoundboardAddDialog } from "@/components/voice/soundboard-add-dialog";

/**
 * Why the board is unavailable for now. The button stays, disabled, and says
 * so: hiding it read as "this call has no soundboard". No permission, or the
 * flag off, still hides it.
 */
export type SoundboardLock = "deafened" | "serverMuted" | "audience" | "micLocked";

const LOCK_COPY: Record<SoundboardLock, MessageKey> = {
  deafened: "soundboard.lock.deafened",
  serverMuted: "soundboard.lock.serverMuted",
  audience: "soundboard.lock.audience",
  micLocked: "soundboard.lock.micLocked",
};

/** The popover: three columns, anchored to the button. */
const POPOVER_COLUMNS = 3;
const PANEL_WIDTH = 280;
const PANEL_HEIGHT = 304;

/**
 * A phone, or any window too short for the popover (a phone on its side is
 * 750 wide and 342 tall, and the 280px popover showed 1.3 rows there). Both
 * halves matter: the width alone leaves landscape on the popover.
 */
export const SOUNDBOARD_SHEET_QUERY = "(max-width: 639px), (max-height: 520px)";

/** The sheet spans the screen, up to this wide, and sits above the call bar. */
const SHEET_MAX_WIDTH = 640;
const SHEET_MARGIN = 8;
const PANEL_PADDING = 20;
const GRID_GAP = 6;
/** A tile is at least this wide, so a thumb lands on one tile. */
const TILE_MIN_WIDTH = 76;
const SHEET_MAX_COLUMNS = 6;

/** How long the lock's reason stays up after a tap. */
const LOCK_HINT_MS = 4000;
const LOCK_HINT_WIDTH = 240;

function sheetWidthFor(viewportWidth: number): number {
  return Math.max(0, Math.min(SHEET_MAX_WIDTH, viewportWidth - 2 * SHEET_MARGIN));
}

/** The number of columns for a sheet this wide. One number for layout and keys. */
export function sheetColumnsFor(sheetWidth: number): number {
  const inner = sheetWidth - PANEL_PADDING;
  const fit = Math.floor((inner + GRID_GAP) / (TILE_MIN_WIDTH + GRID_GAP));
  return Math.min(SHEET_MAX_COLUMNS, Math.max(2, fit));
}

/**
 * The height an element wants with no cap. `offsetHeight` of a capped panel
 * is the cap, so a panel placed once in a short window never grew back.
 */
function naturalHeight(element: HTMLElement | null): number {
  if (!element) {
    return 0;
  }
  const capped = element.style.maxHeight;
  element.style.maxHeight = "none";
  const height = element.offsetHeight;
  element.style.maxHeight = capped;
  return height;
}

/**
 * Where the call controls start. On a phone the bar wraps onto several rows;
 * the sheet opens above the highest of them so none is covered. Only boxes
 * about the size of a few buttons count, never a whole stage.
 */
function controlRowTop(trigger: HTMLElement): number {
  const own = trigger.getBoundingClientRect();
  let top = own.top;
  let node = trigger.parentElement;
  for (let depth = 0; node && depth < 3; depth += 1, node = node.parentElement) {
    const rect = node.getBoundingClientRect();
    if (rect.height > 0 && rect.height <= own.height * 3.5) {
      top = Math.min(top, rect.top);
    }
  }
  return top;
}

export function SoundboardControl({
  serverId,
  canUse: canUseSeat,
  canManage: canManageSeat,
  lock = null,
  size,
  iconSize,
}: {
  serverId: string | null;
  /** The seat's `USE_SOUNDBOARD`. */
  canUse: boolean;
  canManage: boolean;
  /** Set while the board is locked for a reason that will pass. */
  lock?: SoundboardLock | null;
  size: string;
  iconSize: string;
}) {
  const { t } = useTranslation();
  // The seat's grant is the bit. The `soundboard` flag is read live here,
  // as the server's play gate reads it on every click.
  const voiceConfig = useVoiceConfig(serverId);
  const canUse = canUseSeat && voiceConfig.soundboard === true;
  const canManage = canManageSeat && canUse;
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const catalog = useSoundboardCatalog(serverId);
  const sounds = catalog?.sounds ?? [];
  const boardFull = catalog !== null && catalog.slotsUsed >= catalog.maxSounds;
  const activeIds = useSoundboardActiveIds();
  const [volume, setVolume] = useSoundboardListenerVolume();
  const [muted, setMuted] = useSoundboardMuted();
  const refused = useSoundboardRefused();
  // Roving focus: one tile is in the Tab order, the arrows move between them.
  const [activeTile, setActiveTile] = useState(0);
  const portalHost = useFullscreenPortalHost();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<
    (CSSProperties & { width: number }) | null
  >(null);
  const sheet = useMediaQuery(SOUNDBOARD_SHEET_QUERY, false);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1024 : window.innerWidth,
  );
  const panelWidth = sheet ? sheetWidthFor(viewportWidth) : PANEL_WIDTH;
  // The one column count: the grid is drawn with it and the arrows step by it.
  const columns = sheet ? sheetColumnsFor(panelWidth) : POPOVER_COLUMNS;
  // Why the locked button does nothing, said on the surface: a tooltip is
  // inert on touch, so a tap shows it here instead.
  const [lockHint, setLockHint] = useState(false);
  const hintRef = useRef<HTMLDivElement>(null);
  const [hintPlacement, setHintPlacement] = useState<CSSProperties | null>(null);

  useEffect(() => {
    setSoundboardCatalogServer(serverId);
    return () => setSoundboardCatalogServer(null);
  }, [serverId]);

  useEffect(() => {
    // Someone who cannot use the board downloads and decodes nothing.
    if (!serverId || !canUse) {
      return;
    }
    void prefetchSoundboard(serverId);
  }, [serverId, canUse]);

  useEffect(() => {
    if (!lock) {
      setLockHint(false);
      return;
    }
    // The panel is still mounted here. If the person was inside it, closing
    // it would drop their focus on <body>; the locked trigger stays focusable
    // (it is aria-disabled, not disabled) and its tooltip says why.
    if (panelRef.current?.contains(document.activeElement)) {
      triggerRef.current?.focus();
    }
    setOpen(false);
  }, [lock]);

  // Somebody else may have added, renamed or deleted a clip since the call
  // started. Ask again on open, and now and then while the panel is up.
  useEffect(() => {
    if (!open || !serverId) {
      return;
    }
    void refreshSoundboardCatalog(serverId);
    const timer = window.setInterval(() => {
      void refreshSoundboardCatalog(serverId);
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [open, serverId]);

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    function place() {
      const trigger = triggerRef.current;
      const anchor = trigger?.getBoundingClientRect();
      if (!trigger || !anchor) {
        return;
      }
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      setViewportWidth(viewport.width);
      const width = sheet ? sheetWidthFor(viewport.width) : PANEL_WIDTH;
      const height = naturalHeight(panelRef.current) || PANEL_HEIGHT;
      const next = placeAnchoredPanel(
        {
          top: sheet ? controlRowTop(trigger) : anchor.top,
          bottom: anchor.bottom,
          left: sheet ? (viewport.width - width) / 2 : anchor.right - width,
          right: anchor.right,
        },
        { width, height },
        viewport,
      );
      setPlacement({
        top: next.top,
        left: next.left,
        maxHeight: next.maxHeight,
        width: next.maxWidth,
      });
    }
    place();
    const frame = window.requestAnimationFrame(place);
    window.addEventListener("resize", place);
    // Browser chrome sliding away changes the visible height with no resize.
    window.visualViewport?.addEventListener("resize", place);
    // Follow the trigger when something around it scrolls. Closing on any
    // scroll shut the panel under a keyboard user whose focus scrolled the
    // member list into view.
    document.addEventListener("scroll", place, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
    // The width and column count change the natural height, so place again.
  }, [open, sounds.length, canManage, sheet, panelWidth, columns]);

  // The lock's reason: placed above the button, gone after a few seconds, on a
  // tap anywhere else, or on Escape. It never takes focus.
  useLayoutEffect(() => {
    if (!lockHint) {
      setHintPlacement(null);
      return;
    }
    const anchor = triggerRef.current?.getBoundingClientRect();
    if (!anchor) {
      return;
    }
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const width = Math.min(LOCK_HINT_WIDTH, viewport.width - 2 * SHEET_MARGIN);
    const centre = (anchor.left + anchor.right) / 2;
    const next = placeAnchoredPanel(
      { top: anchor.top, bottom: anchor.bottom, left: centre - width / 2, right: centre + width / 2 },
      { width, height: hintRef.current?.offsetHeight || 40 },
      viewport,
    );
    setHintPlacement({ top: next.top, left: next.left, width: next.maxWidth });
  }, [lockHint, lock]);

  useEffect(() => {
    if (!lockHint) {
      return;
    }
    const timer = window.setTimeout(() => setLockHint(false), LOCK_HINT_MS);
    function dismissOutside(event: Event) {
      if (!triggerRef.current?.contains(event.target as Node)) {
        setLockHint(false);
      }
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setLockHint(false);
      }
    }
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("mousedown", dismissOutside);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("mousedown", dismissOutside);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [lockHint]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function handlePointerDown(event: Event) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // Back to the trigger whenever focus was in the panel, so a keyboard
        // user is never dropped on <body>.
        const fromPanel = panelRef.current?.contains(document.activeElement);
        setOpen(false);
        if (fromPanel) {
          triggerRef.current?.focus();
        }
        return;
      }
      if (event.key !== "Tab" || !panelRef.current?.contains(document.activeElement)) {
        return;
      }
      // The panel is portaled to the end of <body>, so the page's own Tab
      // order would never reach it or come back from it. Keep Tab inside
      // while it is open; Escape is the way out.
      const focusable = [
        ...panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [role="slider"], input:not([disabled])',
        ),
      ].filter((element) => element.tabIndex >= 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  // Move focus into the panel once it is placed, onto the first sound.
  useEffect(() => {
    if (!open || !placement) {
      return;
    }
    if (panelRef.current?.contains(document.activeElement)) {
      return;
    }
    panelRef.current
      ?.querySelector<HTMLElement>("[data-sound-tile]")
      ?.focus({ preventScroll: true });
  }, [open, placement]);

  if (!serverId || !canUse) {
    return null;
  }

  function moveBetweenTiles(event: ReactKeyboardEvent<HTMLDivElement>) {
    const tiles = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-sound-tile]"),
    ];
    const index = tiles.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) {
      return;
    }
    const last = tiles.length - 1;
    const next =
      event.key === "ArrowRight"
        ? index + 1
        : event.key === "ArrowLeft"
          ? index - 1
          : event.key === "ArrowDown"
            ? index + columns
            : event.key === "ArrowUp"
              ? index - columns
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? last
                  : null;
    if (next === null) {
      return;
    }
    event.preventDefault();
    tiles[Math.min(last, Math.max(0, next))]?.focus();
  }

  // The trigger's name comes from the Tooltip (`name`), never from an
  // `aria-label` on the button: a child's prop beats the one the Tooltip
  // injects, and an `undefined` one erased the name of the unlocked trigger.
  const mutedNote = muted ? ` (${t("soundboard.mutedNote")})` : "";
  const label = lock ? t(LOCK_COPY[lock]) : `${t("soundboard.title")}${mutedNote}`;
  const triggerName = lock
    ? `${t("soundboard.title")}: ${t(LOCK_COPY[lock])}${mutedNote}`
    : label;
  // A deleted clip can leave the remembered tile past the end of the grid.
  const rovingTile = Math.min(activeTile, SOUNDBOARD_BUILTINS.length + sounds.length - 1);
  const panel =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={panelRef}
            id="soundboard-panel"
            role="dialog"
            aria-label={t("soundboard.title")}
            data-soundboard-panel=""
            data-presentation={sheet ? "sheet" : "popover"}
            style={{
              position: "fixed",
              top: placement?.top ?? 0,
              left: placement?.left ?? 0,
              width: placement?.width ?? panelWidth,
              maxHeight: placement?.maxHeight,
              visibility: placement ? "visible" : "hidden",
            }}
            className={cn(
              "elevation-3 z-[100] flex max-w-full flex-col overflow-hidden rounded-[var(--radius-card)] p-2.5 animate-pop-in",
              sheet ? "origin-bottom" : "origin-bottom-right",
            )}
          >
            {/* The notice takes the title's line, so nothing below it moves. */}
            <div className={cn("relative mb-1.5 flex items-center px-0.5", sheet ? "h-10" : "h-5")}>
              <p
                aria-hidden={refused ? true : undefined}
                className={cn("text-xs font-medium text-text", refused && "invisible")}
              >
                {t("soundboard.title")}
              </p>
              {/* A soft warning fill with its own text token (the pair the
                  bench measures at 4.5:1) and an icon, so the notice is not
                  carried by colour alone. */}
              <p
                role="status"
                aria-live="polite"
                data-soundboard-notice=""
                className={
                  refused
                    ? cn(
                        "absolute left-0.5 flex h-5 items-center gap-1 rounded-full bg-warning-soft px-2 text-xs font-medium text-on-warning-soft",
                        sheet ? "max-w-[calc(100%-3.25rem)]" : "max-w-[calc(100%-0.25rem)]",
                      )
                    : "sr-only"
                }
              >
                <CircleAlert className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="truncate">
                  {refused === "removed"
                    ? t("soundboard.removed")
                    : refused === "refused"
                      ? t("soundboard.refused")
                      : ""}
                </span>
              </p>
              {sheet && (
                <button
                  type="button"
                  aria-label={t("soundboard.close")}
                  data-soundboard-close=""
                  className="absolute right-0 top-0 flex h-10 w-10 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-border-strong hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  onClick={() => {
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>
            <div
              className="grid min-h-0 gap-1.5 overflow-y-auto"
              style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
              onKeyDown={moveBetweenTiles}
            >
              {SOUNDBOARD_BUILTINS.map((sound, index) => (
                <SoundTile
                  key={sound.id}
                  icon={soundboardIcon(sound.id)}
                  name={t(builtinNameKey(sound.id))}
                  playing={activeIds.has(sound.id)}
                  tabIndex={index === rovingTile ? 0 : -1}
                  onFocus={() => setActiveTile(index)}
                  onPlay={() => requestSoundboardPlay(sound.id)}
                />
              ))}
              {sounds.map((sound, offset) => {
                const index = SOUNDBOARD_BUILTINS.length + offset;
                return (
                  <SoundTile
                    key={sound.id}
                    icon={soundboardIcon(sound.id)}
                    monogram={monogramOf(sound.name)}
                    name={sound.name}
                    fullNameTip
                    playing={activeIds.has(sound.id)}
                    tabIndex={index === rovingTile ? 0 : -1}
                    onFocus={() => setActiveTile(index)}
                    onPlay={() => requestSoundboardPlay(sound.id)}
                  />
                );
              })}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-2">
              <button
                type="button"
                aria-pressed={muted}
                aria-label={t("soundboard.mute")}
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-[background-color,color,transform] duration-[var(--duration-fast)] ease-[var(--ease-standard)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring active:scale-90 motion-reduce:transition-none motion-reduce:transform-none pointer-coarse:h-10 pointer-coarse:w-10",
                  sheet && "h-10 w-10",
                  muted
                    ? "bg-danger-soft text-danger hover:bg-danger-soft-hover"
                    : "text-text-tertiary hover:bg-border-strong hover:text-text",
                )}
                onClick={() => setMuted(!muted)}
              >
                <span key={muted ? "off" : "on"} className="flex animate-icon-swap">
                  {muted ? (
                    <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </span>
              </button>
              {/* The root is the hit area: a tap anywhere along its height
                  sets the value, so a taller root is a bigger target with the
                  same drawn track and thumb. */}
              <Slider
                variant="volume"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                aria-label={t("soundboard.volume")}
                aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)}%`}
                className={cn(
                  "min-w-[7rem] flex-1 basis-28 pointer-coarse:h-10",
                  sheet && "h-10",
                )}
                onValueChange={(next) => {
                  if (muted) {
                    setMuted(false);
                  }
                  setVolume(next);
                }}
              />
              {canManage && (
                // Count and Add wrap together, so the slider keeps its width.
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  {catalog && (
                    <span className="text-[11px] tabular-nums text-text-secondary">
                      {t("soundboard.slots", {
                        count: catalog.maxSounds,
                        used: catalog.slotsUsed,
                        max: catalog.maxSounds,
                      })}
                    </span>
                  )}
                  {/* aria-disabled, not disabled: a keyboard user can reach
                      the button and hear why it does nothing. The reason is
                      the tooltip's detail, which a screen reader gets as the
                      description. */}
                  <Tooltip
                    label={t("soundboard.add.tile")}
                    detail={
                      boardFull
                        ? t("soundboard.add.full", { max: catalog?.maxSounds ?? 0 })
                        : undefined
                    }
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-disabled={boardFull ? true : undefined}
                      className={cn(
                        "h-8 shrink-0 px-2 pointer-coarse:h-10 pointer-coarse:px-3",
                        sheet && "h-10 px-3",
                        boardFull &&
                          "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-text-tertiary active:scale-100",
                      )}
                      onClick={() => {
                        if (boardFull) {
                          return;
                        }
                        setOpen(false);
                        setAdding(true);
                      }}
                    >
                      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                      {t("soundboard.add.tile")}
                    </Button>
                  </Tooltip>
                </div>
              )}
            </div>
          </div>,
          portalHost ?? document.body,
        )
      : null;

  const hint =
    lock && lockHint && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={hintRef}
            role="status"
            data-soundboard-lock-hint=""
            style={{
              position: "fixed",
              top: hintPlacement?.top ?? 0,
              left: hintPlacement?.left ?? 0,
              width: hintPlacement?.width ?? LOCK_HINT_WIDTH,
              visibility: hintPlacement ? "visible" : "hidden",
            }}
            className="elevation-3 z-[100] flex max-w-full items-start gap-2 rounded-[var(--radius-control)] px-3 py-2 text-xs leading-snug text-text animate-fade-in"
          >
            <Lock className="mt-px h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
            <span>{t(LOCK_COPY[lock])}</span>
          </div>,
          portalHost ?? document.body,
        )
      : null;

  return (
    <>
      <Tooltip label={label} name={triggerName}>
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-controls={open ? "soundboard-panel" : undefined}
          // Focusable while locked, so the reason can be read.
          aria-disabled={lock ? true : undefined}
          data-locked={lock ?? undefined}
          className={cn(
            "group relative flex items-center justify-center rounded-full transition-[background-color,color,transform] duration-[var(--duration-fast)] ease-[var(--ease-standard)] active:scale-95 motion-reduce:transition-none motion-reduce:transform-none",
            size,
            // Locked is an outline with a lock badge, not a dimmed fill: the
            // icon keeps a measured contrast (secondary text on the bar), and
            // the state reads without hover.
            lock
              ? "cursor-not-allowed bg-transparent text-text-secondary ring-1 ring-inset ring-border-strong active:scale-100"
              : open
                ? "bg-signal/20 text-signal"
                : "bg-ink-3 text-paper hover:bg-ink-4",
          )}
          onClick={() => {
            if (lock) {
              // A tooltip is inert on touch. Tell the person why, here.
              setLockHint((shown) => !shown);
              return;
            }
            setOpen((next) => !next);
          }}
        >
          <span className="flex transition-transform duration-[var(--duration-fast)] ease-[var(--ease-standard)] group-hover:scale-110 motion-reduce:transition-none motion-reduce:transform-none">
            <PartyPopper className={iconSize} />
          </span>
          {lock && (
            <span
              aria-hidden="true"
              data-soundboard-lock-badge=""
              className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-surface-2 text-text ring-1 ring-border-strong"
            >
              <Lock className="h-2.5 w-2.5" />
            </span>
          )}
          {muted && (
            <span
              aria-hidden="true"
              data-soundboard-muted=""
              className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-danger-soft text-danger"
            >
              <VolumeX className="h-2.5 w-2.5" />
            </span>
          )}
        </button>
      </Tooltip>
      {hint}
      {panel}
      <SoundboardAddDialog
        open={adding}
        serverId={serverId}
        returnFocusRef={triggerRef}
        onClose={() => setAdding(false)}
        onAdded={() => {
          setAdding(false);
          void refreshSoundboardCatalog(serverId);
        }}
      />
    </>
  );
}

function SoundTile({
  icon: Icon,
  monogram = null,
  name,
  fullNameTip = false,
  playing,
  tabIndex,
  onFocus,
  onPlay,
}: {
  icon: SoundboardIcon;
  /** A custom clip's letter, drawn instead of the generic mark. */
  monogram?: string | null;
  name: string;
  /**
   * Show the whole name on hover and focus. A custom name can run past the
   * two lines the tile has room for; the built-in names always fit.
   */
  fullNameTip?: boolean;
  /** Somebody's clip of this sound is sounding. Shown, not a toggle state. */
  playing: boolean;
  tabIndex: number;
  onFocus: () => void;
  onPlay: () => void;
}) {
  const [burst, setBurst] = useState(0);
  const tile = (
    <button
      type="button"
      aria-label={name}
      data-sound-tile=""
      data-playing={playing ? "" : undefined}
      tabIndex={tabIndex}
      onFocus={onFocus}
      className={cn(
        "group flex h-[4.25rem] w-full flex-col items-center justify-center gap-1 rounded-[var(--radius-control)] px-1 py-1.5",
        "transition-[background-color,color,box-shadow,transform] duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring active:scale-[0.94]",
        "motion-reduce:transition-none motion-reduce:transform-none",
        playing
          ? "bg-accent-soft text-on-accent-soft shadow-[inset_0_0_0_1px_var(--color-accent)]"
          : "bg-surface-3 text-text hover:bg-border-strong",
      )}
      onKeyDown={(event) => {
        // Holding Enter repeats the click about thirty times a second.
        if (event.repeat && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
        }
      }}
      onClick={() => {
        setBurst((n) => n + 1);
        onPlay();
      }}
    >
      <span className="flex transition-transform duration-[var(--duration-fast)] ease-[var(--ease-standard)] group-hover:-translate-y-px group-hover:scale-110 motion-reduce:transition-none motion-reduce:transform-none">
        <span key={burst} className={cn("flex", playing && "animate-sound-pulse")}>
          {monogram ? (
            <span
              aria-hidden="true"
              className="flex h-6 w-6 items-center justify-center rounded-full bg-border-strong text-xs font-semibold"
            >
              {monogram}
            </span>
          ) : (
            <Icon className="h-6 w-6" />
          )}
        </span>
      </span>
      <span
        className={cn(
          "line-clamp-2 w-full text-balance text-center text-[11px] leading-tight [overflow-wrap:anywhere] transition-colors duration-[var(--duration-fast)] motion-reduce:transition-none",
          playing
            ? "text-on-accent-soft"
            : "text-text-secondary group-hover:text-text",
        )}
      >
        {name}
      </span>
    </button>
  );
  return fullNameTip ? <Tooltip label={name}>{tile}</Tooltip> : tile;
}

function builtinNameKey(id: SoundboardBuiltinId): MessageKey {
  const slug = id.slice("builtin:".length);
  return `soundboard.sound.${slug}` as MessageKey;
}

/**
 * A custom clip's tile mark: its first letter or digit, so twenty-four
 * custom clips do not share one icon. Null falls back to the generic mark.
 */
function monogramOf(name: string): string | null {
  const match = /[\p{L}\p{N}]/u.exec(name);
  return match ? match[0].toLocaleUpperCase() : null;
}
