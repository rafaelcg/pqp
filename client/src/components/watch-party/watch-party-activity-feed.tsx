import { Hand, Users } from "lucide-react";
import { UserAvatar } from "@/components/user/user-avatar";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  useWatchPartyActivity,
  type ActivityEvent,
  type ActivityPerson,
} from "@/lib/watch-party-activity";

/**
 * THE ROOM'S ACTIVITY, for the people running the show: hands with a Chamar
 * beside them, the audience count moving, reaction bursts. It used to be the
 * bottom half of the presenter's two-monitor layout (`presenter-stage.tsx`,
 * retired in pass 3 of `docs/plans/WATCH_PARTY_UI.md`). It now sits as a
 * short strip under the host's stage, until pass 4 folds it into the chat
 * as system lines and this file goes with it.
 */
export function WatchPartyActivityFeed({
  channelId,
  audienceCount,
  hands,
  onInvite,
  className,
}: {
  channelId: string;
  audienceCount: number;
  hands: readonly ActivityPerson[];
  onInvite?: (userId: string) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const events = useWatchPartyActivity({ channelId, audienceCount, hands });

  return (
    <section
      data-testid="watch-party-activity"
      className={cn(
        "flex min-h-0 flex-col border-t border-ink-4/60 bg-ink-2",
        className,
      )}
    >
      <h3 className="flex items-center gap-2 border-b border-ink-4/60 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
        {t("watchParty.presenter.activity")}
        <span className="ml-auto flex items-center gap-1 font-normal normal-case tracking-normal text-paper-muted">
          <Users className="h-3 w-3" aria-hidden />
          {audienceCount}
        </span>
      </h3>
      <ol className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 py-1.5 text-xs">
        {events.length === 0 && (
          <li className="px-1 py-2 text-paper-muted">
            {t("watchParty.presenter.activityEmpty")}
          </li>
        )}
        {events.map((event) => (
          <ActivityRow key={event.id} event={event} onInvite={onInvite} />
        ))}
      </ol>
    </section>
  );
}

function ActivityRow({
  event,
  onInvite,
}: {
  event: ActivityEvent;
  onInvite?: (userId: string) => void;
}) {
  const { t } = useTranslation();
  const time = new Date(event.at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <li
      className={cn(
        "flex items-center gap-2 rounded-md px-1.5 py-1",
        event.kind === "hand" && "bg-signal/10",
      )}
      data-watch-party-activity={event.kind}
    >
      {event.kind === "hand" ? (
        <>
          <UserAvatar
            name={event.person.displayName}
            avatarUrl={event.person.avatarUrl}
            rounded="full"
            className="h-5 w-5 shrink-0"
          />
          <span className="min-w-0 flex-1 truncate text-paper">
            <Hand className="mr-1 inline h-3 w-3 text-signal" aria-hidden />
            {t("watchParty.presenter.activityHand", {
              name: event.person.displayName,
            })}
          </span>
          {onInvite && (
            <Button
              type="button"
              size="sm"
              onClick={() => onInvite(event.person.userId)}
              data-watch-party-activity-invite
            >
              {t("watchParty.stage.invite")}
            </Button>
          )}
        </>
      ) : event.kind === "audience" ? (
        <span className="min-w-0 flex-1 truncate text-paper-muted">
          <Users className="mr-1 inline h-3 w-3" aria-hidden />
          {t("watchParty.presenter.activityAudience", {
            count: event.delta,
            total: event.total,
          })}
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate">
          {event.items.map((item) => (
            <span key={item.emoji} className="mr-2">
              {item.emoji}
              {item.count > 1 && (
                <span className="ml-0.5 text-paper-muted">×{item.count}</span>
              )}
            </span>
          ))}
        </span>
      )}
      <span className="shrink-0 tabular-nums text-text-tertiary">{time}</span>
    </li>
  );
}
