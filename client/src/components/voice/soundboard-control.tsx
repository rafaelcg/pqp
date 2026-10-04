import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { AudioLines, Plus, Volume2, type LucideIcon } from "lucide-react";
import { SOUNDBOARD_BUILTINS, type SoundboardBuiltinId } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Tooltip, useFullscreenPortalHost } from "@/components/ui/tooltip";
import { fetchSoundboard, type SoundboardSoundDto } from "@/lib/api";
import { placeAnchoredPanel } from "@/lib/anchored-panel";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { soundboardIcon } from "@/lib/soundboard-icons";
import {
  prefetchSoundboard,
  pulseSoundboardActive,
  requestSoundboardPlay,
  useSoundboardActiveId,
  useSoundboardListenerVolume,
} from "@/lib/soundboard";
import { cn } from "@/lib/utils";
import { SoundboardAddDialog } from "@/components/voice/soundboard-add-dialog";

const PANEL_WIDTH = 280;
const PANEL_HEIGHT = 304;

export function SoundboardControl({
  serverId,
  canUse,
  canManage,
  size,
  iconSize,
}: {
  serverId: string | null;
  canUse: boolean;
  canManage: boolean;
  size: string;
  iconSize: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [sounds, setSounds] = useState<SoundboardSoundDto[]>([]);
  const activeId = useSoundboardActiveId();
  const [volume, setVolume] = useSoundboardListenerVolume();
  const portalHost = useFullscreenPortalHost();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<CSSProperties | null>(null);

  useEffect(() => {
    if (!serverId || !canUse) {
      return;
    }
    let cancelled = false;
    void prefetchSoundboard(serverId).then(() => {
      if (cancelled) {
        return;
      }
      void fetchSoundboard(serverId)
        .then((page) => {
          if (!cancelled) {
            setSounds(page.sounds);
          }
        })
        .catch(() => undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [serverId, canUse, adding]);

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
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
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
        setOpen(false);
      }
    }
    let scrollArmed = false;
    const armScroll = window.setTimeout(() => {
      scrollArmed = true;
    }, 80);
    function handleScroll(event: Event) {
      if (!scrollArmed) {
        return;
      }
      if (panelRef.current?.contains(event.target as Node)) {
        return;
      }
      setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("scroll", handleScroll, true);
    return () => {
      window.clearTimeout(armScroll);
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("scroll", handleScroll, true);
    };
  }, [open]);

  if (!serverId || !canUse) {
    return null;
  }

  const label = open ? t("soundboard.close") : t("soundboard.open");
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
            className="elevation-3 z-[100] flex w-[17.5rem] flex-col overflow-hidden rounded-[var(--radius-card)] p-2.5 animate-fade-in"
          >
            <p className="px-0.5 pb-2 text-xs font-medium text-text">
              {t("soundboard.title")}
            </p>
            <div className="grid min-h-0 grid-cols-4 gap-1.5 overflow-y-auto">
              {SOUNDBOARD_BUILTINS.map((sound) => (
                <SoundTile
                  key={sound.id}
                  icon={soundboardIcon(sound.id)}
                  name={t(builtinNameKey(sound.id))}
                  pressed={activeId === sound.id}
                  onPlay={() => {
                    pulseSoundboardActive(sound.id);
                    requestSoundboardPlay(sound.id);
                  }}
                />
              ))}
              {sounds.map((sound) => (
                <SoundTile
                  key={sound.id}
                  icon={soundboardIcon(sound.id)}
                  name={sound.name}
                  pressed={activeId === sound.id}
                  onPlay={() => {
                    pulseSoundboardActive(sound.id);
                    requestSoundboardPlay(sound.id);
                  }}
                />
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
              <Volume2
                className="h-3.5 w-3.5 shrink-0 text-text-tertiary"
                aria-hidden="true"
              />
              <Slider
                variant="volume"
                min={0}
                max={1}
                step={0.05}
                value={volume}
                aria-label={t("soundboard.volume")}
                className="min-w-0 flex-1"
                onValueChange={setVolume}
              />
              {canManage && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0 px-2"
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
          aria-pressed={open}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-controls={open ? "soundboard-panel" : undefined}
          className={cn(
            "flex items-center justify-center rounded-full",
            size,
            open
              ? "bg-signal/20 text-signal"
              : "bg-ink-3 text-paper hover:bg-ink-4",
          )}
          onClick={() => setOpen((next) => !next)}
        >
          <AudioLines className={iconSize} />
        </button>
      </Tooltip>
      {panel}
      <SoundboardAddDialog
        open={adding}
        serverId={serverId}
        onClose={() => setAdding(false)}
        onAdded={() => {
          setAdding(false);
          void prefetchSoundboard(serverId).then(() =>
            fetchSoundboard(serverId)
              .then((page) => setSounds(page.sounds))
              .catch(() => undefined),
          );
        }}
      />
    </>
  );
}

function SoundTile({
  icon: Icon,
  name,
  pressed,
  onPlay,
}: {
  icon: LucideIcon;
  name: string;
  pressed: boolean;
  onPlay: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={name}
      aria-pressed={pressed}
      className={cn(
        "flex h-[4.25rem] w-full flex-col items-center justify-center gap-1 rounded-[var(--radius-control)] px-1 py-1.5",
        pressed
          ? "bg-accent-soft text-on-accent-soft"
          : "bg-surface-3 text-text hover:bg-border",
      )}
      onClick={onPlay}
    >
      <Icon className="h-5 w-5" aria-hidden="true" />
      <span
        className={cn(
          "w-full text-balance text-center text-[10px] leading-tight",
          pressed ? "text-on-accent-soft" : "text-text-secondary",
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
