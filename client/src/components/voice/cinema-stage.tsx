import { useState } from "react";
import { Crown, Phone } from "lucide-react";
import { UserAvatar } from "@/components/user/user-avatar";
import { HlsWatchPlayer } from "@/components/voice/hls-watch-player";
import { presenceAvatars, type CinemaStagePerson } from "@/lib/cinema-layout";
import { useTranslation } from "@/lib/i18n";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";

/**
 * Full-bleed HLS video for a live stream's audience: no roster, no mute or
 * camera controls, and a stage overlay for whoever is actually on the call.
 *
 * Mounted instead of `CallStage`'s grid whenever `shouldShowCinema` says so;
 * the chat beside or below it is `App.tsx`'s ordinary transcript, unchanged.
 */
export function CinemaStage({
  hlsUrl,
  delaySeconds,
  mediaTitle,
  communityName,
  coverUrl,
  viewerCount,
  audience,
  stagePeople,
  onJoin,
  canJoin,
  className,
}: {
  hlsUrl: string;
  delaySeconds?: number;
  mediaTitle?: string;
  communityName?: string | null;
  coverUrl?: string | null;
  /** How many people the roster reports for this channel right now. */
  viewerCount: number;
  /** Faces for the presence strip, most-recently-joined last. */
  audience: { key: string; name: string; avatarUrl: string | null }[];
  /** Who is actually on the WebRTC call, for the stage overlay. */
  stagePeople: CinemaStagePerson[];
  onJoin: () => void;
  canJoin: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const [sheetOpen, setSheetOpen] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const strip = presenceAvatars(audience);

  return (
    <div className={cn("flex h-full w-full flex-col bg-ink", className)}>
      <div className="relative min-h-0 w-full flex-1 bg-black">
        <HlsWatchPlayer
          src={hlsUrl}
          delaySeconds={delaySeconds}
          mediaTitle={mediaTitle}
          communityName={communityName}
          coverUrl={coverUrl}
          className="group h-full w-full"
        />
        {stagePeople.length > 0 && (
          <button
            type="button"
            className="absolute bottom-2 left-2 flex items-center -space-x-2"
            aria-label={t("voice.cinema.stage")}
            onClick={() => setSheetOpen(true)}
          >
            {stagePeople.slice(0, 5).map((person) => (
              <span
                key={person.key}
                className={cn(
                  "relative block h-7 w-7 rounded-full ring-2 ring-black",
                  person.speaking &&
                    (reducedMotion
                      ? "ring-success"
                      : "animate-pulse ring-success"),
                )}
              >
                <UserAvatar
                  name={person.name}
                  avatarUrl={person.avatarUrl}
                  rounded="full"
                  className="h-full w-full"
                />
                {person.isHost && (
                  <Crown className="absolute -top-1.5 -right-1 h-3.5 w-3.5 text-warning" />
                )}
              </span>
            ))}
          </button>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-ink-4/60 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex -space-x-1.5">
            {strip.map((person) => (
              <UserAvatar
                key={person.key}
                name={person.name}
                avatarUrl={person.avatarUrl}
                rounded="full"
                className="h-5 w-5 ring-2 ring-ink"
              />
            ))}
          </div>
          <p className="truncate text-xs text-paper-muted">
            {t("voice.cinema.watching", { count: viewerCount })}
          </p>
        </div>
        {canJoin && (
          <button
            type="button"
            className="flex shrink-0 items-center gap-1.5 rounded-md bg-success/90 px-2.5 py-1.5 text-xs font-semibold text-ink hover:bg-success"
            onClick={onJoin}
          >
            <Phone className="h-3.5 w-3.5" />
            {t("voice.cinema.join")}
          </button>
        )}
      </div>
      {sheetOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-ink/60 sm:items-center"
          onClick={() => setSheetOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-t-xl bg-ink-2 p-3 sm:rounded-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="mb-2 px-1 text-sm font-semibold text-paper">
              {t("voice.cinema.stage")}
            </p>
            <ul className="max-h-64 space-y-1 overflow-y-auto">
              {stagePeople.map((person) => (
                <li
                  key={person.key}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5"
                >
                  <span
                    className={cn(
                      "relative block h-8 w-8 rounded-full",
                      person.speaking && "ring-2 ring-success",
                    )}
                  >
                    <UserAvatar
                      name={person.name}
                      avatarUrl={person.avatarUrl}
                      rounded="full"
                      className="h-full w-full"
                    />
                  </span>
                  <span className="truncate text-sm text-paper">
                    {person.name}
                  </span>
                  {person.isHost && (
                    <Crown className="h-3.5 w-3.5 shrink-0 text-warning" />
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
