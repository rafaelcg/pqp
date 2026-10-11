import { soundboardBuiltin } from "@pqp/shared";
import { VolumeX } from "lucide-react";
import { useTranslation, type MessageKey, type Translator } from "@/lib/i18n";
import {
  soundboardCustomName,
  useSoundboardMark,
  useSoundboardUserMuted,
} from "@/lib/soundboard";
import { soundboardIcon } from "@/lib/soundboard-icons";
import { cn } from "@/lib/utils";

export function soundboardSoundLabel(soundId: string, t: Translator["t"]): string {
  const builtin = soundboardBuiltin(soundId);
  if (builtin) {
    const slug = builtin.id.slice("builtin:".length);
    return t(`soundboard.sound.${slug}` as MessageKey);
  }
  return soundboardCustomName(soundId) ?? t("soundboard.title");
}

/**
 * Who just played a clip, next to their name under the voice channel.
 * One icon per person: the next click swaps it. Mute does not hide it.
 */
export function SoundboardOccupantMark({ userId }: { userId: string }) {
  const mark = useSoundboardMark(userId);
  if (!mark) {
    return null;
  }
  const Icon = soundboardIcon(mark.soundId);
  // No tooltip: the mark is not hoverable, and the row's own name already
  // says which sound is playing.
  return (
    <span
      key={mark.until}
      data-soundboard-mark={mark.soundId}
      className="pointer-events-none flex h-4 w-4 shrink-0 items-center justify-center text-signal animate-badge-pop"
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </span>
  );
}

/**
 * A quiet "you muted this person's soundboard" glyph, for their row and for
 * their audio menu. Nothing when they are not muted. It is a picture with a
 * name, not a button: the switch in their menu is the control.
 */
export function SoundboardMutedMark({
  userId,
  name,
  className,
}: {
  userId: string;
  name: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const [muted] = useSoundboardUserMuted(userId);
  if (!muted) {
    return null;
  }
  const label = t("voice.audio.soundboardMarkMuted", { name });
  return (
    <VolumeX
      role="img"
      aria-label={label}
      data-soundboard-muted-mark=""
      className={cn("h-3 w-3 shrink-0 text-paper-muted", className)}
    >
      <title>{label}</title>
    </VolumeX>
  );
}

/**
 * Who just played a clip, sitting on their face for as long as it sounds.
 *
 * `md` is the room view's badge, centred over a large face. `sm` is for the
 * small faces (the collapsed call bar, the listener chips): a corner badge
 * inside the face's own box, because a 32px disc on a 24px avatar hid the
 * face it was announcing, and two neighbours' discs ran into each other.
 */
export function SoundboardFloat({
  userId,
  size = "md",
}: {
  userId?: string;
  size?: "md" | "sm";
}) {
  const { t } = useTranslation();
  const mark = useSoundboardMark(userId);
  if (!mark) {
    return null;
  }
  const Icon = soundboardIcon(mark.soundId);
  const small = size === "sm";
  return (
    <span
      role="status"
      data-soundboard-float={size}
      className={cn(
        "pointer-events-none absolute z-20",
        small
          ? "-bottom-0.5 -right-0.5 h-3.5 w-3.5"
          : "left-1/2 top-1 h-8 w-8 -translate-x-1/2",
      )}
    >
      {/* The icon says nothing to a screen reader: name the person and the sound. */}
      <span className="sr-only">
        {t("soundboard.float.played", {
          name: mark.displayName,
          sound: soundboardSoundLabel(mark.soundId, t),
        })}
      </span>
      <span
        key={mark.until}
        className="flex h-full w-full items-center justify-center rounded-full elevation-3 animate-badge-pop"
      >
        <Icon
          className={small ? "h-2.5 w-2.5 text-text" : "h-4 w-4 text-text"}
          aria-hidden="true"
        />
      </span>
    </span>
  );
}
