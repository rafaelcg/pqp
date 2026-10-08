import { formatNoteDuration, type Attachment } from "@pqp/shared";
import { AlertCircle, Headphones, Loader2, Pause, Play } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { useTranslation, type MessageKey, type MessageVars } from "@/lib/i18n";
import { cn, formatTime } from "@/lib/utils";
import { decodeWaveform } from "@/lib/voice-note-recorder";
import {
  mountVoiceNote,
  nextRate,
  registerVoiceNote,
  seekVoiceNote,
  setPlaybackRate,
  toggleVoiceNote,
  useCardPlayback,
  useListened,
  usePlaybackRate,
  type VoiceNoteEntry,
} from "@/lib/voice-note-player";

/** The message a voice note belongs to, as the card needs it. */
export interface VoiceNoteMessage {
  channelId: string;
  messageId: string;
  createdAt: string;
  authorId: string;
  authorName: string;
  isMine: boolean;
}

/**
 * Display names for receipts ("Ana ouviu"). The list provides it from the
 * authors it already has; a listener it cannot name is still counted.
 */
export const VoiceNoteNamesContext = createContext<(userId: string) => string | null>(
  () => null,
);

/** Seek step for the arrow keys. WhatsApp and every podcast app use 5 s. */
const SEEK_STEP_MS = 5000;

type ListenedBy = { userId: string; listenedAt: string | null };

/**
 * `listenedBy` as the server sends it. The contract fixes
 * `[{ userId, listenedAt }]`; the first shared schema typed it as bare ids.
 * Both are read, so neither half of the rollout breaks the other.
 */
function readListenedBy(raw: unknown): ListenedBy[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ListenedBy[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item === "string") {
      out.push({ userId: item, listenedAt: null });
    } else if (item && typeof item === "object" && typeof (item as ListenedBy).userId === "string") {
      const at = (item as { listenedAt?: unknown }).listenedAt;
      out.push({ userId: (item as ListenedBy).userId, listenedAt: typeof at === "string" ? at : null });
    }
  }
  return out;
}

/**
 * A voice note, drawn inside the ordinary message row: play, a waveform that
 * fills as it plays, the length, a dot until you have heard it, the speed
 * pill, and under your own notes who has heard them.
 */
export function VoiceNoteCard({
  attachment,
  message,
}: {
  attachment: Attachment & { voice: NonNullable<Attachment["voice"]> };
  message: VoiceNoteMessage;
}) {
  const { t } = useTranslation();
  const voice = attachment.voice;
  const durationMs = Math.max(1, voice.durationMs);
  const narrow = useNarrowScreen();
  // 64 bars do not fit a phone-width card with a gap between them, so a
  // phone draws 32: the louder of each pair, same shape, still the whole note.
  const peaks = useMemo(() => {
    const all = decodeWaveform(voice.waveform);
    if (!narrow) {
      return all;
    }
    const half: number[] = [];
    for (let i = 0; i < all.length; i += 2) {
      half.push(Math.max(all[i]!, all[i + 1] ?? 0));
    }
    return half;
  }, [narrow, voice.waveform]);
  const playback = useCardPlayback(attachment.id);
  const rate = usePlaybackRate();
  const listened = useListened(attachment.id);
  const nameFor = useContext(VoiceNoteNamesContext);
  const waveRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const entry: VoiceNoteEntry = useMemo(
    () => ({
      attachmentId: attachment.id,
      messageId: message.messageId,
      channelId: message.channelId,
      createdAt: message.createdAt,
      authorId: message.authorId,
      authorName: message.authorName,
      url: attachment.url,
      durationMs,
      listenedByMe: message.isMine || voice.listenedByMe === true,
    }),
    [
      attachment.id,
      attachment.url,
      durationMs,
      message.authorId,
      message.authorName,
      message.channelId,
      message.createdAt,
      message.isMine,
      message.messageId,
      voice.listenedByMe,
    ],
  );

  useEffect(() => {
    registerVoiceNote(entry);
  }, [entry]);
  useEffect(() => mountVoiceNote(attachment.id), [attachment.id]);

  const heardByMe = entry.listenedByMe || listened?.me === true;
  const isPlaying = playback.isCurrent && playback.status === "playing";
  const isLoading = playback.isCurrent && playback.status === "loading";
  const isBroken = playback.isCurrent && playback.status === "error";
  const positionMs = playback.isCurrent ? Math.min(durationMs, playback.positionMs) : 0;
  const progress = positionMs / durationMs;
  const clock = playback.isCurrent && positionMs > 0
    ? formatClock(positionMs)
    : formatNoteDuration(durationMs);

  const receipts = useMemo(() => {
    if (!message.isMine) {
      return [];
    }
    const merged = new Map<string, string | null>();
    for (const one of readListenedBy(voice.listenedBy)) {
      merged.set(one.userId, one.listenedAt);
    }
    for (const [userId, at] of listened?.by ?? []) {
      merged.set(userId, at ?? merged.get(userId) ?? null);
    }
    return [...merged.entries()].map(([userId, listenedAt]) => ({ userId, listenedAt }));
  }, [listened?.by, message.isMine, voice.listenedBy]);

  function seekToClientX(clientX: number) {
    const box = waveRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) {
      return;
    }
    const fraction = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    seekVoiceNote(entry, fraction * durationMs);
  }

  function handleWaveKey(event: KeyboardEvent<HTMLDivElement>) {
    let target: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      target = positionMs + SEEK_STEP_MS;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      target = positionMs - SEEK_STEP_MS;
    } else if (event.key === "Home") {
      target = 0;
    } else if (event.key === "End") {
      target = durationMs;
    } else if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      toggleVoiceNote(entry);
      return;
    }
    if (target !== null) {
      event.preventDefault();
      seekVoiceNote(entry, target);
    }
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }
    draggingRef.current = true;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic or already released pointer: seeking still works.
    }
    seekToClientX(event.clientX);
  }

  const playLabel = isBroken
    ? t("voiceNote.retry")
    : isPlaying || isLoading
      ? t("voiceNote.pausePlayback")
      : t("voiceNote.play", { name: message.authorName });

  return (
    <div className="max-w-full" data-voice-note={attachment.id}>
      <div
        role="group"
        aria-label={t("voiceNote.label", { duration: formatNoteDuration(durationMs) })}
        className="flex w-[27.5rem] max-w-full items-center gap-2.5 rounded-[var(--radius-card)] border border-border bg-surface-2 py-1.5 pl-1.5 pr-2"
      >
        <Tooltip label={playLabel}>
          <button
            type="button"
            onClick={() => toggleVoiceNote(entry)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent transition-colors duration-[var(--duration-fast)] hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring"
          >
            {isBroken ? (
              <AlertCircle className="h-4 w-4" aria-hidden />
            ) : isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : isPlaying ? (
              <Pause className="h-4 w-4 fill-current" aria-hidden />
            ) : (
              <Play className="ml-0.5 h-4 w-4 fill-current" aria-hidden />
            )}
          </button>
        </Tooltip>
        <div
          ref={waveRef}
          role="slider"
          tabIndex={0}
          aria-label={t("voiceNote.seek")}
          aria-valuemin={0}
          aria-valuemax={Math.round(durationMs / 1000)}
          aria-valuenow={Math.round(positionMs / 1000)}
          aria-valuetext={t("voiceNote.position", {
            position: formatClock(positionMs),
            duration: formatNoteDuration(durationMs),
          })}
          onKeyDown={handleWaveKey}
          onPointerDown={handlePointerDown}
          onPointerMove={(event) => {
            if (draggingRef.current) {
              seekToClientX(event.clientX);
            }
          }}
          onPointerUp={() => {
            draggingRef.current = false;
          }}
          onPointerCancel={() => {
            draggingRef.current = false;
          }}
          className="flex h-8 min-w-0 flex-1 cursor-pointer touch-none items-center gap-px overflow-hidden rounded-[var(--radius-control)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          {peaks.map((peak, index) => {
            const played = (index + 0.5) / peaks.length <= progress;
            return (
              <span
                key={index}
                aria-hidden
                style={{ height: `${Math.max(12, Math.round(peak * 100))}%` }}
                className={cn(
                  "min-w-0 flex-1 rounded-full transition-colors duration-[var(--duration-fast)]",
                  played
                    ? "bg-accent"
                    : heardByMe
                      ? "bg-border-strong"
                      : "bg-text-tertiary",
                )}
              />
            );
          })}
        </div>
        <span className="shrink-0 text-xs tabular-nums text-text-secondary">{clock}</span>
        {!heardByMe && (
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-accent"
            title={t("voiceNote.unheard")}
            data-voice-note-unheard
          >
            <span className="sr-only">{t("voiceNote.unheard")}</span>
          </span>
        )}
        <Tooltip label={t("voiceNote.speed", { rate: `${rate}x` })}>
          <button
            type="button"
            onClick={() => setPlaybackRate(nextRate(rate))}
            className="h-6 min-w-10 shrink-0 rounded-full border border-border-strong bg-surface-1 px-2 text-xs font-semibold tabular-nums text-text transition-colors duration-[var(--duration-fast)] hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring"
          >
            {rate}x
          </button>
        </Tooltip>
      </div>
      {isBroken && (
        <p className="mt-1 text-xs text-danger">{t("voiceNote.unavailable")}</p>
      )}
      {receipts.length > 0 && (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-text-tertiary" data-voice-note-receipt>
          <Headphones className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{receiptText(receipts, nameFor, t)}</span>
        </p>
      )}
    </div>
  );
}

const NARROW_QUERY = "(max-width: 639px)";

function subscribeNarrow(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) {
    return () => {};
  }
  const query = window.matchMedia(NARROW_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Phone width, the same breakpoint as Tailwind's `sm`. */
function useNarrowScreen(): boolean {
  return useSyncExternalStore(
    subscribeNarrow,
    () => typeof window !== "undefined" && Boolean(window.matchMedia?.(NARROW_QUERY).matches),
    () => false,
  );
}

/** `0:07`, from a playback position. Unlike the duration, 0 is allowed. */
function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function receiptText(
  receipts: ListenedBy[],
  nameFor: (userId: string) => string | null,
  t: (key: MessageKey, vars?: MessageVars) => string,
): string {
  const names = receipts
    .map((one) => nameFor(one.userId))
    .filter((name): name is string => Boolean(name));
  if (names.length === 0) {
    return t("voiceNote.heard");
  }
  if (receipts.length === 1 && receipts[0]!.listenedAt) {
    return t("voiceNote.heardByAt", {
      names: names[0],
      time: formatTime(receipts[0]!.listenedAt),
    });
  }
  return t("voiceNote.heardBy", { names: names.join(", ") });
}
