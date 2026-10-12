import { soundboardBuiltin } from "@pqp/shared";
import { VolumeX } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
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

/** One person behind a count ("+N") whose clip is sounding right now. */
export interface SoundboardGroupPlay {
  userId: string;
  name: string;
  soundId: string;
  until: number;
}

function SoundboardGroupProbe({
  userId,
  name,
  onPlay,
}: {
  userId: string;
  name: string;
  onPlay: (userId: string, play: SoundboardGroupPlay | null) => void;
}) {
  const mark = useSoundboardMark(userId);
  const soundId = mark?.soundId ?? null;
  const until = mark?.until ?? 0;
  useEffect(() => {
    onPlay(userId, soundId ? { userId, name, soundId, until } : null);
  }, [userId, name, soundId, until, onPlay]);
  useEffect(() => () => onPlay(userId, null), [userId, onPlay]);
  return null;
}

/**
 * Who, among a fixed list of people, has a clip sounding. For a count like the
 * call bar's "+N", where the people it covers have no face of their own to
 * carry a badge. `useSoundboardMark` watches one person, so each person gets a
 * tiny probe component; render `probes` once, anywhere, and read `playing`
 * (newest first).
 */
export function useSoundboardGroup(
  people: ReadonlyArray<{ userId?: string; name: string }>,
): { playing: SoundboardGroupPlay[]; probes: ReactNode } {
  const [plays, setPlays] = useState<Record<string, SoundboardGroupPlay>>({});
  const onPlay = useCallback(
    (userId: string, play: SoundboardGroupPlay | null) => {
      setPlays((current) => {
        const before = current[userId];
        if (!play) {
          if (!before) {
            return current;
          }
          const rest = { ...current };
          delete rest[userId];
          return rest;
        }
        if (
          before &&
          before.soundId === play.soundId &&
          before.until === play.until &&
          before.name === play.name
        ) {
          return current;
        }
        return { ...current, [userId]: play };
      });
    },
    [],
  );
  const probes = people.map((person) =>
    person.userId ? (
      <SoundboardGroupProbe
        key={person.userId}
        userId={person.userId}
        name={person.name}
        onPlay={onPlay}
      />
    ) : null,
  );
  const listed = new Set(people.map((person) => person.userId));
  const playing = Object.values(plays)
    .filter((play) => listed.has(play.userId))
    .sort((a, b) => b.until - a.until);
  return { playing, probes };
}

/** What a screen reader hears for the people in a group who are playing. */
export function soundboardGroupLabel(
  playing: ReadonlyArray<SoundboardGroupPlay>,
  t: Translator["t"],
): string {
  return playing
    .map((play) =>
      t("soundboard.float.played", {
        name: play.name,
        sound: soundboardSoundLabel(play.soundId, t),
      }),
    )
    .join(". ");
}

/**
 * The corner badge on a count such as "+N" while anyone it covers plays a
 * clip. Same size, place and look as a face's `sm` float; the icon is the
 * newest clip's. It is a picture: the count's accessible name says who.
 */
export function SoundboardGroupBadge({
  playing,
}: {
  playing: ReadonlyArray<SoundboardGroupPlay>;
}) {
  const newest = playing[0];
  if (!newest) {
    return null;
  }
  const Icon = soundboardIcon(newest.soundId);
  return (
    <span
      aria-hidden="true"
      data-soundboard-group-mark={newest.soundId}
      className="pointer-events-none absolute -bottom-0.5 -right-0.5 z-20 h-3.5 w-3.5"
    >
      <span
        key={newest.until}
        className="flex h-full w-full items-center justify-center rounded-full elevation-3 animate-badge-pop"
      >
        <Icon className="h-2.5 w-2.5 text-text" aria-hidden="true" />
      </span>
    </span>
  );
}
