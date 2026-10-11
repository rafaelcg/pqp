import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { AudioLines, Plus, Volume2, VolumeX } from "lucide-react";
import { SOUNDBOARD_BUILTINS, type SoundboardBuiltinId } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
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

const PANEL_WIDTH = 280;
const PANEL_HEIGHT = 304;

export function SoundboardControl({
  serverId,
  canUse: canUseSeat,
  canManage: canManageSeat,
  size,
  iconSize,
}: {
  serverId: string | null;
  /** The seat's grant: `USE_SOUNDBOARD` and an open mic. */
  canUse: boolean;
  canManage: boolean;
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
  const portalHost = useFullscreenPortalHost();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<CSSProperties | null>(null);

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
      const anchor = triggerRef.current?.getBoundingClientRect();
      if (!anchor) {
        return;
      }
      const height = panelRef.current?.offsetHeight || PANEL_HEIGHT;
      const next = placeAnchoredPanel(
        {
          top: anchor.top,
          bottom: anchor.bottom,
          left: anchor.right - PANEL_WIDTH,
          right: anchor.right,
        },
        { width: PANEL_WIDTH, height },
        { width: window.innerWidth, height: window.innerHeight },
      );
      setPlacement({
        top: next.top,
        left: next.left,
        maxHeight: next.maxHeight,
      });
    }
    place();
    const frame = window.requestAnimationFrame(place);
    window.addEventListener("resize", place);
    // Follow the trigger when something around it scrolls. Closing on any
    // scroll shut the panel under a keyboard user whose focus scrolled the
    // member list into view.
    document.addEventListener("scroll", place, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [open, sounds.length, canManage]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function handlePointerDown(event: MouseEvent) {
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
      ];
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
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
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
    panelRef.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }, [open, placement]);

  if (!serverId || !canUse) {
    return null;
  }

  const label = t("soundboard.title");
  const panel =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={panelRef}
            id="soundboard-panel"
            role="dialog"
            aria-label={t("soundboard.title")}
            data-soundboard-panel=""
            style={{
              position: "fixed",
              top: placement?.top ?? 0,
              left: placement?.left ?? 0,
              maxHeight: placement?.maxHeight,
              visibility: placement ? "visible" : "hidden",
            }}
            className="elevation-3 z-[100] flex w-[17.5rem] origin-bottom-right flex-col overflow-hidden rounded-[var(--radius-card)] p-2.5 animate-pop-in"
          >
            {/* The notice takes the title's line, so nothing below it moves. */}
            <div className="relative flex h-5 items-center px-0.5 mb-1.5">
              <p
                aria-hidden={refused ? true : undefined}
                className={cn("text-xs font-medium text-text", refused && "invisible")}
              >
                {t("soundboard.title")}
              </p>
              <p
                role="status"
                aria-live="polite"
                className={cn(
                  "absolute inset-x-0.5 truncate text-xs font-medium text-warning",
                  !refused && "sr-only",
                )}
              >
                {refused === "removed"
                  ? t("soundboard.removed")
                  : refused === "refused"
                    ? t("soundboard.refused")
                    : ""}
              </p>
            </div>
            <div className="grid min-h-0 grid-cols-3 gap-1.5 overflow-y-auto">
              {SOUNDBOARD_BUILTINS.map((sound) => (
                <SoundTile
                  key={sound.id}
                  icon={soundboardIcon(sound.id)}
                  name={t(builtinNameKey(sound.id))}
                  playing={activeIds.has(sound.id)}
                  onPlay={() => requestSoundboardPlay(sound.id)}
                />
              ))}
              {sounds.map((sound) => (
                <SoundTile
                  key={sound.id}
                  icon={soundboardIcon(sound.id)}
                  monogram={monogramOf(sound.name)}
                  name={sound.name}
                  playing={activeIds.has(sound.id)}
                  onPlay={() => requestSoundboardPlay(sound.id)}
                />
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
              <button
                type="button"
                aria-pressed={muted}
                aria-label={t("soundboard.mute")}
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-[background-color,color,transform] duration-[var(--duration-fast)] ease-[var(--ease-standard)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring active:scale-90 motion-reduce:transition-none motion-reduce:transform-none",
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
              <Slider
                variant="volume"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                aria-label={t("soundboard.volume")}
                aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)}%`}
                className="min-w-0 flex-1"
                onValueChange={(next) => {
                  if (muted) {
                    setMuted(false);
                  }
                  setVolume(next);
                }}
              />
              {canManage && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 shrink-0 px-2"
                  disabled={boardFull}
                  onClick={() => {
                    setOpen(false);
                    setAdding(true);
                  }}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("soundboard.add.tile")}
                </Button>
              )}
            </div>
          </div>,
          portalHost ?? document.body,
        )
      : null;

  return (
    <>
      <Tooltip label={label}>
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-controls={open ? "soundboard-panel" : undefined}
          className={cn(
            "group flex items-center justify-center rounded-full transition-[background-color,color,transform] duration-[var(--duration-fast)] ease-[var(--ease-standard)] active:scale-95 motion-reduce:transition-none motion-reduce:transform-none",
            size,
            open
              ? "bg-signal/20 text-signal"
              : "bg-ink-3 text-paper hover:bg-ink-4",
          )}
          onClick={() => setOpen((next) => !next)}
        >
          <span className="flex transition-transform duration-[var(--duration-fast)] ease-[var(--ease-standard)] group-hover:scale-110 motion-reduce:transition-none motion-reduce:transform-none">
            <AudioLines className={iconSize} />
          </span>
        </button>
      </Tooltip>
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
  playing,
  onPlay,
}: {
  icon: SoundboardIcon;
  /** A custom clip's letter, drawn instead of the generic mark. */
  monogram?: string | null;
  name: string;
  /** Somebody's clip of this sound is sounding. Shown, not a toggle state. */
  playing: boolean;
  onPlay: () => void;
}) {
  const [burst, setBurst] = useState(0);
  return (
    <button
      type="button"
      aria-label={name}
      data-playing={playing ? "" : undefined}
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
          "line-clamp-2 w-full text-balance text-center text-[10px] leading-tight [overflow-wrap:anywhere] transition-colors duration-[var(--duration-fast)] motion-reduce:transition-none",
          playing
            ? "text-on-accent-soft"
            : "text-text-secondary group-hover:text-text",
        )}
      >
        {name}
      </span>
    </button>
  );
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
