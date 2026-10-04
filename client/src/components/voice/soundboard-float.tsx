import { useSoundboardMark } from "@/lib/soundboard";
import { soundboardIcon } from "@/lib/soundboard-icons";

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
      className="pointer-events-none absolute left-1/2 top-1 z-20 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full elevation-3 animate-fade-in"
    >
      <Icon className="h-4 w-4 text-text" aria-hidden="true" />
    </span>
  );
}
