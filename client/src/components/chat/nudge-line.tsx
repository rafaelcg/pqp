import { NUDGE_FRESH_MS, type NudgeRefusalReason } from "@pqp/shared";
import { Flag, Trash2, Vibrate, X } from "lucide-react";
import { memo, useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { clearNudgeNotice, useNudgeChannelState } from "@/lib/nudge";
import { cn, formatFullTimestamp, formatTime } from "@/lib/utils";

/**
 * A nudge in the log: not a bubble, a line in the middle. "Lu chamou tua
 * atenção!" for a nudge received, "Tu chamou a atenção de Lu." for one sent.
 *
 * It slides in (opacity and a small rise) and its phone rattles once, but only
 * when it is fresh at mount: a nudge read out of history just sits there, the
 * same rule that keeps the pane from shaking on a reload. Delete (mine) and
 * report (theirs) stay reachable on hover and on focus, like any message.
 */
export interface NudgeLineProps {
  messageId: string;
  createdAt: string;
  mine: boolean;
  /** The sender for theirs, the other person for mine. */
  name: string;
  registerRow?: (messageId: string, node: HTMLElement | null) => void;
  onDelete?: () => void;
  onReport?: () => void;
}

export const NudgeLine = memo(function NudgeLine({
  messageId,
  createdAt,
  mine,
  name,
  registerRow,
  onDelete,
  onReport,
}: NudgeLineProps) {
  const { t } = useTranslation();
  const [fresh] = useState(() => {
    const age = Date.now() - Date.parse(createdAt);
    return Number.isFinite(age) && age >= -NUDGE_FRESH_MS && age < NUDGE_FRESH_MS;
  });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const text = mine ? t("nudge.sent", { name }) : t("nudge.received", { name });
  const canDelete = mine && Boolean(onDelete);
  const canReport = !mine && Boolean(onReport);

  return (
    <>
      <div
        ref={(node) => registerRow?.(messageId, node)}
        data-message-id={messageId}
        data-testid="nudge-line"
        data-nudge-mine={mine ? "true" : "false"}
        tabIndex={-1}
        aria-label={text}
        className={cn(
          "group relative flex items-center justify-center px-5 py-1.5",
          fresh && "nudge-line-in",
        )}
      >
        <p
          className={cn(
            "flex max-w-full items-center gap-2 rounded-full border border-border/70 bg-surface-1 px-3 py-1",
            "text-xs text-text-secondary",
          )}
        >
          <Vibrate
            aria-hidden
            className={cn("h-3.5 w-3.5 shrink-0 text-warning", fresh && "nudge-wiggle")}
          />
          <span className="min-w-0 truncate font-medium">{text}</span>
          <time
            dateTime={createdAt}
            title={formatFullTimestamp(createdAt)}
            className="shrink-0 tabular-nums text-text-tertiary"
          >
            {formatTime(createdAt)}
          </time>
        </p>
        {canDelete || canReport ? (
          <div className="absolute right-4 top-1/2 flex -translate-y-1/2 gap-0.5 opacity-0 transition-opacity duration-[var(--duration-fast)] focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none">
            {canReport ? (
              <button
                type="button"
                aria-label={t("chat.report")}
                title={t("chat.report")}
                onClick={onReport}
                className="flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-2 hover:text-text"
              >
                <Flag aria-hidden className="h-3.5 w-3.5" />
              </button>
            ) : null}
            {canDelete ? (
              <button
                type="button"
                aria-label={t("chat.delete")}
                title={t("chat.delete")}
                onClick={() => setDeleteOpen(true)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-2 hover:text-danger"
              >
                <Trash2 aria-hidden className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {canDelete ? (
        <ConfirmDialog
          open={deleteOpen}
          title={t("chat.delete")}
          description={t("chat.deleteConfirm")}
          confirmLabel={t("chat.delete")}
          onConfirm={() => onDelete?.()}
          onClose={() => setDeleteOpen(false)}
        />
      ) : null}
    </>
  );
});

const REFUSAL_COPY: Record<NudgeRefusalReason, MessageKey> = {
  cooldown: "nudge.refused.cooldown",
  unanswered: "nudge.refused.unanswered",
  busy: "nudge.refused.busy",
  "self-off": "nudge.refused.selfOff",
  unavailable: "nudge.refused.unavailable",
};

/** The i18n key for a refusal, so every surface words it the same. */
export function nudgeRefusalKey(reason: NudgeRefusalReason): MessageKey {
  return REFUSAL_COPY[reason];
}

/**
 * The server's "no", as a line only the sender sees, under the log. It is
 * never stored and goes away by itself after a few seconds.
 */
export function NudgeNotice({ channelId, name }: { channelId: string; name: string }) {
  const { t } = useTranslation();
  const { notice } = useNudgeChannelState(channelId);
  if (!notice) {
    return null;
  }
  return (
    <div
      key={notice.at}
      role="status"
      data-testid="nudge-notice"
      data-reason={notice.reason}
      className="animate-fade-in flex items-center justify-center px-5 py-1.5"
    >
      <p className="flex max-w-full items-center gap-2 rounded-full bg-surface-2/70 px-3 py-1 text-xs text-text-secondary">
        <Vibrate aria-hidden className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
        <span className="min-w-0">{t(nudgeRefusalKey(notice.reason), { name })}</span>
        <button
          type="button"
          aria-label={t("nudge.dismiss")}
          onClick={() => clearNudgeNotice(channelId)}
          className="-mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-text-tertiary hover:bg-surface-2 hover:text-text"
        >
          <X aria-hidden className="h-3 w-3" />
        </button>
      </p>
    </div>
  );
}
