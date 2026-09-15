import { Mic } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * CONVIDADOS §4: "guest presence in the header — up to three small avatars,
 * 20px, with a mic glyph on the group, and a tooltip listing the names."
 * Derived from the party frame's `guests.onAir`, never the roster: the
 * audience has no roster.
 *
 * NOT ANIMATED. §4: "the presence avatars light up in real time, and the
 * voices arrive twenty-five seconds later... the fix is to not animate them:
 * the avatars say who is on air, never who is speaking right now." No
 * speaking ring here — that belongs on the presenter's own surface, where it
 * is in sync with reality.
 */
export function GuestHeaderAvatars({
  onAir,
  className,
}: {
  onAir: readonly { userId: string; displayName: string; avatarUrl: string | null }[];
  className?: string;
}) {
  const { t } = useTranslation();
  if (onAir.length === 0) {
    return null;
  }
  const shown = onAir.slice(0, 3);
  const names = onAir.map((p) => p.displayName).join(", ");

  return (
    <Tooltip label={t("watchParty.guests.onAirWith", { names })}>
      <div
        data-watch-party-guest-avatars
        className={cn(
          "flex items-center gap-1 rounded-full bg-surface-2 py-0.5 pl-0.5 pr-2",
          className,
        )}
        role="img"
        aria-label={t("watchParty.guests.onAirWith", { names })}
      >
        <div className="flex -space-x-1.5">
          {shown.map((person) => (
            <UserAvatar
              key={person.userId}
              name={person.displayName}
              avatarUrl={person.avatarUrl}
              className="h-5 w-5 ring-2 ring-surface-2"
              rounded="full"
            />
          ))}
        </div>
        <Mic className="h-3 w-3 shrink-0 text-text-tertiary" aria-hidden="true" />
      </div>
    </Tooltip>
  );
}
