import { isPollClosed, type Poll } from "@pqp/shared";
import { BarChart3, Check, Clock, Lock } from "lucide-react";
import { CommandChip } from "@/components/chat/command-chip";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface PollCardProps {
  poll: Poll;
  canManage?: boolean;
  onVote: (optionId: string) => void;
  onClose: () => void;
}

export function PollCard({ poll, canManage = false, onVote, onClose }: PollCardProps) {
  const { t } = useTranslation();
  const closed = isPollClosed(poll);
  const canClose = !closed && (poll.canClose || canManage);
  const maxVotes = Math.max(1, ...poll.options.map((option) => option.votes));
  const topVotes = Math.max(...poll.options.map((option) => option.votes));

  return (
    <div
      data-poll={closed ? "closed" : "open"}
      className="mt-1.5 max-w-md rounded-lg border border-border bg-surface-2/60 p-3"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <CommandChip icon={BarChart3} label={t("poll.command")} />
        {!closed && (
          <span className="text-[11px] text-paper-muted">
            {t(poll.allowMultiselect ? "poll.selectMultiple" : "poll.selectOne")}
          </span>
        )}
      </div>
      <p className="mt-2 text-sm font-semibold text-paper">{poll.question}</p>
      <ul className="mt-2 space-y-1.5">
        {poll.options.map((option) => {
          const ratio = poll.totalVotes === 0 ? 0 : option.votes / poll.totalVotes;
          const leading = closed && poll.totalVotes > 0 && option.votes === topVotes;
          return (
            <li key={option.id}>
              <button
                type="button"
                disabled={closed}
                onClick={() => onVote(option.id)}
                aria-pressed={option.voted}
                aria-label={t("poll.vote")}
                className={cn(
                  "relative w-full overflow-hidden rounded-md border px-2.5 py-1.5 text-left text-sm transition-colors",
                  option.voted ? "border-signal/70 text-paper" : "border-ink-4 text-paper",
                  !closed && "hover:border-signal/50",
                  closed && "cursor-default",
                  closed && !leading && "opacity-70",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "absolute inset-y-0 left-0 rounded-r-sm transition-[width] duration-300",
                    leading ? "bg-signal/25" : "bg-signal/15",
                  )}
                  style={{ width: `${Math.round((option.votes / maxVotes) * 100)}%` }}
                />
                <span className="relative flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {option.voted && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-signal" aria-hidden />
                    )}
                    <span className="min-w-0 break-words">{option.label}</span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-xs tabular-nums",
                      leading ? "font-semibold text-signal" : "text-paper-muted",
                    )}
                  >
                    {option.votes}
                    {poll.totalVotes > 0 ? ` · ${Math.round(ratio * 100)}%` : null}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-border/60 pt-2 text-xs text-paper-muted">
        <span className="flex min-w-0 items-center gap-1.5">
          {closed ? (
            <Lock className="h-3 w-3 shrink-0" aria-hidden />
          ) : (
            <Clock className="h-3 w-3 shrink-0" aria-hidden />
          )}
          <span>
            {closed
              ? t("poll.closed")
              : t("poll.expires", { when: formatClose(poll.closesAt) })}
            {" · "}
            {t("poll.votes", { count: poll.totalVotes })}
          </span>
        </span>
        {canClose && (
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 font-medium text-signal hover:underline"
          >
            {t("poll.close")}
          </button>
        )}
      </div>
    </div>
  );
}

function formatClose(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString();
}
