import { useState } from "react";
import { ChevronDown, ChevronRight, Hand, Users } from "lucide-react";
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
 * retired in pass 3 of `docs/plans/WATCH_PARTY_UI.md`). Since pass 4 it is
 * a strip in the chat column, above the composer, that folds to one line.
 */
export function WatchPartyActivityFeed({
  channelId,
  audienceCount,
  hands,
  onInvite,
  collapsible = false,
  className,
}: {
  channelId: string;
  audienceCount: number;
  hands: readonly ActivityPerson[];
  onInvite?: (userId: string) => void;
  /**
   * IN THE CHAT COLUMN (pass 4): a strip above the composer that opens
   * and closes on its header, remembered per browser. Closed, it is one
   * line with the count of what happened since; open, the last events.
   */
  collapsible?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const events = useWatchPartyActivity({ channelId, audienceCount, hands });
  const [open, setOpen] = useState(() => readActivityOpen());
  const expanded = !collapsible || open;

  return (
    <section
      data-testid="watch-party-activity"
      data-watch-party-activity-open={expanded ? "" : undefined}
      className={cn(
        "flex min-h-0 flex-col border-t border-ink-4/60 bg-ink-2",
        collapsible && expanded && "max-h-40",
        className,
      )}
    >
      <h3 className="flex items-center gap-2 border-b border-ink-4/60 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
        {collapsible ? (
          <button
            type="button"
            aria-expanded={open}
            className="flex items-center gap-1 rounded-sm hover:text-paper"
            onClick={() =>
              setOpen((was) => {
                writeActivityOpen(!was);
                return !was;
              })
            }
            data-watch-party-activity-toggle
          >
            {open ? (
              <ChevronDown className="h-3 w-3" aria-hidden />
            ) : (
              <ChevronRight className="h-3 w-3" aria-hidden />
            )}
            {t("watchParty.presenter.activity")}
            {!open && events.length > 0 && (
              <span className="ml-1 rounded-full bg-signal/20 px-1.5 font-normal normal-case tracking-normal text-signal">
                {events.length}
              </span>
            )}
          </button>
        ) : (
          t("watchParty.presenter.activity")
        )}
        <span className="ml-auto flex items-center gap-1 font-normal normal-case tracking-normal text-paper-muted">
          <Users className="h-3 w-3" aria-hidden />
          {audienceCount}
        </span>
      </h3>
      {expanded && (
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
      )}
    </section>
  );
}

const ACTIVITY_OPEN_KEY = "pqp:watch-party-activity-open";
function readActivityOpen(): boolean {
  try {
    return localStorage.getItem(ACTIVITY_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}
function writeActivityOpen(on: boolean): void {
  try {
    localStorage.setItem(ACTIVITY_OPEN_KEY, on ? "1" : "0");
  } catch {
    // ignore
  }
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
