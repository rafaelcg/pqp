export type VoiceAvatarSize = "sm" | "md" | "lg" | "xl";

interface VoiceAvatarProps {
  name: string;
  avatarUrl?: string | null;
  isSpeaking?: boolean;
  size?: VoiceAvatarSize;
  muted?: boolean;
}

const SIZE_CLASS: Record<VoiceAvatarSize, string> = {
  sm: "h-6 w-6 text-[10px]",
  md: "h-9 w-9 text-sm",
  lg: "h-12 w-12 text-base",
  xl: "h-16 w-16 text-2xl",
};

export function VoiceAvatar({
  name,
  avatarUrl,
  isSpeaking = false,
  size = "sm",
  muted = false,
}: VoiceAvatarProps) {
  const dim = SIZE_CLASS[size];
  const initial = name.trim().slice(0, 1).toUpperCase() || "?";

  return (
    <div
      className={`relative shrink-0 rounded-full transition-shadow duration-150 ${dim} ${
        isSpeaking
          ? "ring-2 ring-accent ring-offset-1 ring-offset-surface-0 shadow-[var(--shadow-speaking)]"
          : "ring-1 ring-ink-4"
      }`}
    >
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          className={`h-full w-full rounded-full object-cover ${muted ? "opacity-50" : ""}`}
        />
      ) : (
        <div
          className={`flex h-full w-full items-center justify-center rounded-full bg-signal font-display font-bold text-ink ${muted ? "opacity-50" : ""}`}
        >
          {initial}
        </div>
      )}
    </div>
  );
}
