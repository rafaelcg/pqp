import { UserAvatar } from "@/components/user/user-avatar";

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

  return (
    <div
      className={`relative shrink-0 rounded-full transition-shadow duration-150 ${dim} ${
        isSpeaking
          ? "ring-2 ring-accent ring-offset-1 ring-offset-surface-0 shadow-[var(--shadow-speaking)]"
          : "ring-1 ring-ink-4"
      }`}
    >
      {/* The sizing ring stays on the wrapper — it is what `isSpeaking`
          animates — and the picture fills it. `text-inherit` keeps the
          monogram at the size the wrapper's class set, which is the one thing
          `SIZE_CLASS` carries that a fixed fallback class could not. */}
      <UserAvatar
        name={name}
        avatarUrl={avatarUrl}
        className="h-full w-full"
        fallbackClassName="bg-signal text-inherit text-ink"
        rounded="full"
        dimmed={muted}
      />
    </div>
  );
}
