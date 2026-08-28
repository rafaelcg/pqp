import { isPollClosed, type Poll, type PollVoter } from "@pqp/shared";
import { BarChart3, Check } from "lucide-react";
import { CommandChip } from "@/components/chat/command-chip";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation, type Translator } from "@/lib/i18n";
import { cn, formatFullTimestamp } from "@/lib/utils";

const MAX_VISIBLE_VOTERS = 4;

interface PollCardProps {
  poll: Poll;
  canManage?: boolean;
  onVote: (optionId: string) => void;
  onClose: () => void;
}

/*
 * Mirrors the chance-card shell: soft tonal surface, lit from above, no 1px
 * border. Black/white in the shadows are light and shade, not palette.
 */
const SHELL = cn(
  "mt-1.5 max-w-md rounded-2xl px-4 py-3",
  "bg-[linear-gradient(165deg,color-mix(in_oklab,var(--color-signal)_6%,var(--color-surface-2)),var(--color-surface-2)_72%)]",
  "shadow-[inset_0_1px_0_rgb(255_255_255/0.05),0_1px_2px_rgb(0_0_0/0.1),0_12px_28px_-20px_rgb(0_0_0/0.55)]",
);

export function PollCard({ poll, canManage = false, onVote, onClose }: PollCardProps) {
  const { t } = useTranslation();
  const closed = isPollClosed(poll);
  const canClose = !closed && (poll.canClose || canManage);
  const maxVotes = Math.max(1, ...poll.options.map((option) => option.votes));
  const topVotes = Math.max(...poll.options.map((option) => option.votes));

  return (
    <div data-poll={closed ? "closed" : "open"} className={SHELL}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <CommandChip icon={BarChart3} label={t("poll.command")} />
        {!closed && (
          <span className="text-[11px] text-paper-muted">
            {t(poll.allowMultiselect ? "poll.selectMultiple" : "poll.selectOne")}
          </span>
        )}
      </div>
      <p className="mt-2 font-display text-lg font-semibold leading-snug text-paper">
        {poll.question}
      </p>
      <ul className="mt-3 space-y-1.5">
        {poll.options.map((option) => {
          const ratio = poll.totalVotes === 0 ? 0 : option.votes / poll.totalVotes;
          // Bars fill relative to the leader, so the leader reads full.
          const fill = poll.totalVotes === 0 ? 0 : Math.round((option.votes / maxVotes) * 100);
          const leading = poll.totalVotes > 0 && option.votes === topVotes;
          const voters = option.voters ?? [];
          const names = voters.map((voter) => voter.displayName).join(", ");
          return (
            <li key={option.id}>
              <button
                type="button"
                disabled={closed}
                onClick={() => onVote(option.id)}
                aria-pressed={option.voted}
                aria-label={
                  names
                    ? t("poll.voteWithVoters", { option: option.label, names })
                    : t("poll.vote")
                }
                className={cn(
                  "relative flex h-11 w-full items-center overflow-hidden rounded-xl px-3.5 text-left text-sm transition-colors",
                  "shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]",
                  option.voted
                    ? "bg-[color-mix(in_oklab,var(--color-signal)_10%,var(--color-surface-1))]"
                    : "bg-[color-mix(in_oklab,var(--color-paper)_5%,var(--color-surface-1))]",
                  !closed &&
                    "hover:bg-[color-mix(in_oklab,var(--color-paper)_10%,var(--color-surface-1))]",
                  closed && "cursor-default",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "absolute inset-y-0 left-0 transition-[width] duration-500 ease-out",
                    leading
                      ? "bg-[color-mix(in_oklab,var(--color-signal)_36%,var(--color-surface-3))]"
                      : "bg-[color-mix(in_oklab,var(--color-signal)_20%,var(--color-surface-3))]",
                  )}
                  style={{ width: `${fill}%` }}
                />
                <span className="relative flex min-w-0 flex-1 items-center gap-2">
                  {option.voted && (
                    <Check className="h-4 w-4 shrink-0 text-signal" strokeWidth={3} aria-hidden />
                  )}
                  <span
                    className={cn(
                      "min-w-0 truncate text-paper",
                      leading && "font-medium",
                    )}
                  >
                    {option.label}
                  </span>
                </span>
                {voters.length > 0 && <VoterStack voters={voters} names={names} />}
                {poll.totalVotes > 0 && (
                  <span
                    className={cn(
                      "relative ml-2 shrink-0 tabular-nums text-xs",
                      leading ? "font-semibold text-paper" : "text-paper-muted",
                    )}
                  >
                    {Math.round(ratio * 100)}%
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-2.5 flex items-center justify-between gap-3 text-[11px] text-paper-muted">
        <span title={formatFullTimestamp(poll.closesAt)}>
          {closed
            ? t("poll.closed")
            : t("poll.expires", { when: formatExpiresWhen(poll.closesAt, t) })}
          {" · "}
          {t("poll.votes", { count: poll.totalVotes })}
        </span>
        {canClose && (
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 whitespace-nowrap font-medium text-paper-muted transition-colors hover:text-paper"
          >
            {t("poll.close")}
          </button>
        )}
      </div>
    </div>
  );
}

function VoterStack({ voters, names }: { voters: PollVoter[]; names: string }) {
  const shown = voters.slice(0, MAX_VISIBLE_VOTERS);
  const overflow = voters.length - shown.length;
  return (
    <span
      title={names}
      aria-hidden
      className="relative ml-2 flex shrink-0 -space-x-1.5"
    >
      {shown.map((voter) => (
        <UserAvatar
          key={voter.userId}
          name={voter.displayName}
          avatarUrl={voter.avatarUrl}
          className="h-5 w-5 ring-2 ring-surface-1"
          fallbackClassName="bg-surface-3 text-[9px] text-paper"
          rounded="full"
        />
      ))}
      {overflow > 0 && (
        <span className="relative flex h-5 min-w-5 items-center justify-center rounded-full bg-surface-3 px-1 text-[9px] font-semibold text-paper ring-2 ring-surface-1">
          +{overflow}
        </span>
      )}
    </span>
  );
}

function formatExpiresWhen(iso: string, t: Translator["t"]): string {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) {
    return t("poll.expires.soon");
  }
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) {
    return t("poll.expires.minutes", { count: minutes });
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return t("poll.expires.hours", { count: hours });
  }
  return t("poll.expires.days", { count: Math.round(hours / 24) });
}
