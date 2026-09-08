import { Bell, BellOff, CalendarClock, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ChannelSession } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatSessionRelativeTime } from "@/lib/channel-session-schedule";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The one-session-at-a-time card at the top of a voice channel: what's
 * coming ("Cinemoon, sexta às 21h"), a relative-time readout, a "Lembrar"
 * toggle bound to the reminder subscription with optimistic state, and,
 * for MANAGE_CHANNELS, "Cancelar" behind a confirm.
 *
 * FOUR STATUSES, FOUR READOUTS. `scheduled` is the only one with live
 * actions (remind, cancel, edit); `live` drops them (an already-live session
 * has nothing left to remind about, and cancelling a stream in progress is
 * not a thing this feature does (the stream itself decides when it ends);
 * `ended` and `cancelled` are a quiet, actionless line rather than the card
 * disappearing outright, so a manager who just cancelled sees the
 * confirmation rather than the card silently vanishing.
 *
 * `now` is provided by the caller's own `setInterval` (or a fixed `Date` in
 * tests) rather than read from `Date.now()` here, so the relative-time text
 * updates on the same schedule the rest of the app already runs on and a
 * test can assert a fixed instant without faking timers globally.
 */
export function UpcomingSessionCard({
  session,
  now,
  canManage,
  onToggleReminder,
  onCancel,
  onEdit,
}: {
  session: ChannelSession;
  now: Date;
  canManage: boolean;
  onToggleReminder: (wants: boolean) => Promise<void>;
  onCancel: () => Promise<void>;
  onEdit?: () => void;
}) {
  const { t } = useTranslation();
  const [reminding, setReminding] = useState(session.reminding);
  const [reminderBusy, setReminderBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    setReminding(session.reminding);
  }, [session.id, session.reminding]);

  const toggleReminder = async () => {
    const next = !reminding;
    setReminding(next); // optimistic
    setReminderBusy(true);
    try {
      await onToggleReminder(next);
    } catch {
      setReminding(!next); // revert on failure
    } finally {
      setReminderBusy(false);
    }
  };

  const relative = formatSessionRelativeTime(session.startsAt, now, "pt-BR");
  const isScheduled = session.status === "scheduled";
  const isLive = session.status === "live";

  const subtitle = isLive
    ? t("watchPartySchedule.card.live")
    : session.status === "ended"
      ? t("watchPartySchedule.card.ended")
      : session.status === "cancelled"
        ? t("watchPartySchedule.card.cancelled")
        : relative;

  return (
    <div
      data-upcoming-session-card
      data-session-status={session.status}
      className="mx-3 mt-3 flex items-center gap-3 rounded-xl border border-ink-4/70 bg-ink-2 px-3 py-2.5"
    >
      <span
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
          isLive ? "bg-danger/20 text-danger" : "bg-ink-3 text-paper-muted",
        )}
      >
        <CalendarClock className="h-4.5 w-4.5" aria-hidden />
      </span>
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={isScheduled ? onEdit : undefined}
        disabled={!canManage || !onEdit || !isScheduled}
      >
        <span className="block truncate text-sm font-semibold text-paper">
          {session.title}
        </span>
        <span className="block truncate text-xs text-paper-muted">
          {subtitle}
        </span>
      </button>
      {isScheduled && (
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant={reminding ? "default" : "ghost"}
            size="sm"
            disabled={reminderBusy}
            onClick={() => void toggleReminder()}
            data-session-remind-toggle
            aria-pressed={reminding}
          >
            {reminding ? (
              <Bell className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            ) : (
              <BellOff className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            )}
            {t("watchPartySchedule.card.remind")}
          </Button>
          {canManage && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={t("watchPartySchedule.card.cancel")}
              onClick={() => setConfirmCancel(true)}
              data-session-cancel
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </Button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirmCancel}
        title={t("watchPartySchedule.card.cancelConfirmTitle")}
        description={t("watchPartySchedule.card.cancelConfirmBody", {
          title: session.title,
        })}
        confirmLabel={t("watchPartySchedule.card.cancelConfirmAction")}
        onClose={() => setConfirmCancel(false)}
        onConfirm={() => void onCancel()}
      />
    </div>
  );
}
