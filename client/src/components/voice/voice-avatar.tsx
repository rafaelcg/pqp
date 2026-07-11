interface VoiceAvatarProps {
  name: string;
  avatarUrl?: string | null;
  isSpeaking?: boolean;
  size?: "sm" | "md";
  muted?: boolean;
}

export function VoiceAvatar({
  name,
  avatarUrl,
  isSpeaking = false,
  size = "sm",
  muted = false,
}: VoiceAvatarProps) {
  const dim = size === "md" ? "h-9 w-9 text-sm" : "h-6 w-6 text-[10px]";
  const initial = name.trim().slice(0, 1).toUpperCase() || "?";

  return (
    <div
      className={`relative shrink-0 rounded-full ${dim} ${
        isSpeaking
          ? "ring-2 ring-signal ring-offset-1 ring-offset-ink shadow-[0_0_10px_oklch(0.88_0.19_125/0.45)]"
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
