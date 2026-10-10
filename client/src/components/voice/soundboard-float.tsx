import { soundboardBuiltin } from "@pqp/shared";
import { useTranslation, type MessageKey, type Translator } from "@/lib/i18n";
import { soundboardCustomName, useSoundboardMark } from "@/lib/soundboard";
import { soundboardIcon } from "@/lib/soundboard-icons";

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
  const { t } = useTranslation();
  const mark = useSoundboardMark(userId);
  if (!mark) {
    return null;
  }
  const Icon = soundboardIcon(mark.soundId);
  return (
    <span
      key={mark.until}
      data-soundboard-mark={mark.soundId}
      title={soundboardSoundLabel(mark.soundId, t)}
      className="pointer-events-none flex h-4 w-4 shrink-0 items-center justify-center text-signal animate-badge-pop"
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </span>
  );
}

/** Who just played a clip, sitting on their face for a couple of seconds. */
export function SoundboardFloat({ userId }: { userId?: string }) {
  const mark = useSoundboardMark(userId);
  if (!mark) {
    return null;
  }
  const Icon = soundboardIcon(mark.soundId);
  return (
    <span
      role="status"
      aria-label={mark.displayName}
      className="pointer-events-none absolute left-1/2 top-1 z-20 h-8 w-8 -translate-x-1/2"
    >
      <span
        key={mark.until}
        className="flex h-full w-full items-center justify-center rounded-full elevation-3 animate-badge-pop"
      >
        <Icon className="h-4 w-4 text-text" aria-hidden="true" />
      </span>
    </span>
  );
}
