import type { BotActionCard as BotActionCardData, BotActionItem, BotNotice } from "@pqp/shared";
import {
  ArrowRightLeft,
  Ban,
  BarChart3,
  CheckSquare,
  Check,
  CircleDashed,
  CircleHelp,
  Clock,
  EyeOff,
  Hash,
  History,
  Link2,
  ListChecks,
  Loader2,
  MessageCircleQuestion,
  MessageSquarePlus,
  MessagesSquare,
  Newspaper,
  Pencil,
  Pin,
  Send,
  Timer,
  Trash2,
  Undo2,
  UserCheck,
  UserMinus,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { answerBotAsk, ApiError, decideBotPlan } from "@/lib/api";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { intlLocale, type Locale } from "@/lib/locale";
import { cn } from "@/lib/utils";

/** The icon for what a step does. An unknown tool (a newer server) gets a wrench. */
const TOOL_ICON: Record<string, LucideIcon> = {
  create_channel: Hash,
  edit_channel: Pencil,
  move_channel: ArrowRightLeft,
  delete_channel: Trash2,
  post_message: Send,
  pin_message: Pin,
  create_thread: MessagesSquare,
  create_forum_post: MessageSquarePlus,
  create_bau_post: Newspaper,
  delete_message: Trash2,
  timeout_member: Timer,
  kick_member: UserMinus,
  ban_member: Ban,
  read_channel: History,
  create_invite: Link2,
  remove_timeout: Undo2,
  list_bans: Ban,
  unban_member: UserCheck,
  list_forum_posts: MessagesSquare,
  reply_forum_post: MessageSquarePlus,
  create_poll: BarChart3,
  read_poll: BarChart3,
  vote_poll: CheckSquare,
};

/** A card younger than this animates in; older ones are drawn still. */
const FRESH_MS = 30_000;

/** How long each row waits after the one above it, so a result reads top down. */
const STAGGER_MS = 70;

function StatusMark({ item, index, fresh }: { item: BotActionItem; index: number; fresh: boolean }) {
  const { t } = useTranslation();
  if (item.status === "ok") {
    return (
      <span
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-signal/15 text-signal",
          fresh && "bot-step-pop",
        )}
        style={{ animationDelay: `${index * STAGGER_MS + 120}ms` }}
        aria-label={t("chat.botCard.status.ok")}
        role="img"
      >
        <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
      </span>
    );
  }
  if (item.status === "failed") {
    return (
      <span
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-danger/15 text-danger",
          fresh && "bot-step-pop",
        )}
        style={{ animationDelay: `${index * STAGGER_MS + 120}ms` }}
        aria-label={t("chat.botCard.status.failed")}
        role="img"
      >
        <X className="h-3 w-3" strokeWidth={3} aria-hidden />
      </span>
    );
  }
  if (item.status === "unknown") {
    return (
      <CircleHelp
        className="h-5 w-5 shrink-0 text-paper-muted"
        aria-label={t("chat.botCard.status.unknown")}
        role="img"
      />
    );
  }
  // A plan's step, waiting: its number, in the order it will run.
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border font-mono text-[10px] text-paper-muted">
      {index + 1}
    </span>
  );
}

/**
 * What a server bot did, or is waiting to do, drawn as a card under its
 * sentence instead of a text list. The data is written by server code only
 * (`botCard` on the message); the body keeps a plain copy for clients that do
 * not draw this.
 */
export function BotActionCard({
  card,
  messageId,
  createdAt,
  currentUserId,
}: {
  card: BotActionCardData;
  /** The message that carries the card; a question's answer names it. */
  messageId: string;
  /** The message's; only a card that just arrived plays its entrance. */
  createdAt: string;
  /** Only the member who asked gets a plan's buttons. */
  currentUserId: string | null;
}) {
  // Read once per mount: a list that remounts an old row on scroll must not
  // replay the entrance.
  const [fresh] = useState(() => Date.now() - new Date(createdAt).getTime() < FRESH_MS);
  const { t, locale } = useTranslation();
  const failed = card.items.filter((item) => item.status === "failed").length;
  const isPlan = card.kind === "plan";
  const HeaderIcon = isPlan ? ListChecks : Wrench;
  const expired = useExpired(card.expiresAt, card.kind !== "result" && !card.state);

  if (card.kind === "ask") {
    return (
      <AskCard
        card={card}
        messageId={messageId}
        fresh={fresh}
        expired={expired}
        currentUserId={currentUserId}
      />
    );
  }

  const planState = isPlan ? (card.state ?? (expired ? "expired" : "waiting")) : null;

  const status = isPlan
    ? planState === "confirmed"
      ? { text: t("chat.botCard.confirmed"), tone: "text-signal", icon: Check }
      : planState === "cancelled"
        ? { text: t("chat.botCard.cancelled"), tone: "text-paper-muted", icon: X }
        : planState === "expired"
          ? { text: t("chat.botCard.expired"), tone: "text-paper-muted", icon: Clock }
          : { text: t("chat.botCard.waiting"), tone: "text-paper-muted", icon: Clock }
    : failed === 0
      ? { text: t("chat.botCard.done"), tone: "text-signal", icon: Check }
      : {
          text: t("chat.botCard.failed", { count: failed }),
          tone: "text-danger",
          icon: X,
        };
  const StatusIcon = status.icon;

  const deadline = isPlan ? deadlineOf(card.expiresAt, locale) : null;

  return (
    <div
      data-bot-card={card.kind}
      className={cn(
        "mt-1.5 max-w-md overflow-hidden rounded-lg border border-border bg-surface-2/60",
        fresh && "bot-step-in",
      )}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <HeaderIcon className="h-3.5 w-3.5 shrink-0 text-paper-muted" aria-hidden />
        <span className="text-xs font-semibold text-paper">
          {isPlan ? t("chat.botCard.planTitle") : t("chat.botCard.resultTitle")}
        </span>
        <span className={cn("ml-auto inline-flex items-center gap-1 text-[11px]", status.tone)}>
          <StatusIcon className="h-3 w-3" aria-hidden />
          {status.text}
        </span>
      </div>
      <ol className="space-y-1.5 px-3 py-2.5">
        {card.items.map((item, index) => {
          const ToolIcon = TOOL_ICON[item.tool] ?? Wrench;
          return (
            <li
              key={index}
              className={cn("flex items-start gap-2.5", fresh && "bot-step-in")}
              style={{ animationDelay: `${index * STAGGER_MS}ms` }}
            >
              <StatusMark item={item} index={index} fresh={fresh} />
              <div className="min-w-0 flex-1 pt-px">
                <p className="flex items-center gap-1.5 text-[13px] leading-snug text-paper/90">
                  <ToolIcon className="h-3.5 w-3.5 shrink-0 text-paper-muted" aria-hidden />
                  <span className="min-w-0 break-words">{item.label}</span>
                </p>
                {item.detail && (
                  <p
                    className={cn(
                      "mt-0.5 break-words text-xs",
                      item.status === "failed" ? "text-danger/90" : "text-paper-muted",
                    )}
                  >
                    {item.detail}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {planState === "waiting" &&
        (card.planId && card.confirmById && card.confirmById === currentUserId ? (
          <PlanButtons planId={card.planId} deadline={deadline} />
        ) : (
          <p className="flex items-start gap-1.5 border-t border-border px-3 py-2 text-xs text-paper-muted">
            <CircleDashed className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
            <span>
              {deadline
                ? t("chat.botCard.onlyRequesterUntil", { who: card.confirmBy ?? "", time: deadline })
                : t("chat.botCard.onlyRequester", { who: card.confirmBy ?? "" })}
            </span>
          </p>
        ))}
    </div>
  );
}

/** The card's deadline as a wall-clock time, or null without one. */
function deadlineOf(expiresAt: string | null, locale: Locale): string | null {
  return expiresAt
    ? new Date(expiresAt).toLocaleTimeString(intlLocale(locale), { hour: "2-digit", minute: "2-digit" })
    : null;
}

/**
 * Whether the card's buttons have run out. Repaints once at the deadline, so
 * they go without a reload. `active` is false once there is nothing to expire.
 */
function useExpired(expiresAt: string | null, active: boolean): boolean {
  const expiresAtMs = expiresAt ? new Date(expiresAt).getTime() : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || expiresAtMs === null || expiresAtMs <= now) return;
    const timer = setTimeout(() => setNow(Date.now()), expiresAtMs - now + 50);
    return () => clearTimeout(timer);
  }, [active, expiresAtMs, now]);
  return expiresAtMs !== null && expiresAtMs <= now;
}

/**
 * A question back to the member who called the bot (`ask_member`), with its
 * answers. The question itself is the message's lead, drawn above the card.
 * Only that member gets buttons; a press posts the answer as their own reply,
 * which is what wakes the bot again. Typing an answer works as well.
 */
function AskCard({
  card,
  messageId,
  fresh,
  expired,
  currentUserId,
}: {
  card: BotActionCardData;
  messageId: string;
  fresh: boolean;
  expired: boolean;
  currentUserId: string | null;
}) {
  const { t, locale } = useTranslation();
  const [sending, setSending] = useState<number | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const options = card.options ?? [];
  const waiting = !card.state && !expired;
  const mine = waiting && !!card.confirmById && card.confirmById === currentUserId;
  const deadline = deadlineOf(card.expiresAt, locale);

  const status =
    card.state === "answered"
      ? { text: t("chat.botCard.answered"), tone: "text-signal", icon: Check }
      : waiting
        ? { text: t("chat.botCard.askWaiting"), tone: "text-paper-muted", icon: Clock }
        : { text: t("chat.botCard.expired"), tone: "text-paper-muted", icon: Clock };
  const StatusIcon = status.icon;

  async function answer(option: number) {
    setSending(option);
    setError(null);
    try {
      await answerBotAsk(messageId, option);
    } catch (err) {
      setSending(null);
      setError(
        err instanceof ApiError && err.status === 409
          ? "chat.botCard.alreadyAnswered"
          : "chat.botCard.decideError",
      );
    }
  }

  return (
    <div
      data-bot-card="ask"
      className={cn(
        "mt-1.5 max-w-md overflow-hidden rounded-lg border border-border bg-surface-2/60",
        fresh && "bot-step-in",
      )}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0 text-paper-muted" aria-hidden />
        <span className="text-xs font-semibold text-paper">{t("chat.botCard.askTitle")}</span>
        <span className={cn("ml-auto inline-flex items-center gap-1 text-[11px]", status.tone)}>
          <StatusIcon className="h-3 w-3" aria-hidden />
          {status.text}
        </span>
      </div>
      {mine ? (
        <div className="flex flex-col gap-1.5 px-3 py-2.5">
          {options.map((option, index) => (
            <Button
              key={index}
              type="button"
              size="sm"
              variant="secondary"
              className={cn("h-auto justify-start whitespace-normal py-1.5 text-left", fresh && "bot-step-in")}
              style={{ animationDelay: `${index * STAGGER_MS}ms` }}
              disabled={sending !== null}
              onClick={() => void answer(index)}
            >
              {sending === index ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 shrink-0 motion-safe:animate-spin" aria-hidden />
              ) : (
                <span className="mr-2 font-mono text-[11px] text-paper-muted">{index + 1}</span>
              )}
              {option}
            </Button>
          ))}
          {error && (
            <span role="alert" className="text-[11px] text-danger">
              {t(error)}
            </span>
          )}
        </div>
      ) : (
        <ol className="space-y-1.5 px-3 py-2.5">
          {options.map((option, index) => {
            const chosen = card.state === "answered" && card.answer === index;
            return (
              <li
                key={index}
                className={cn(
                  "flex items-start gap-2.5 text-[13px] leading-snug",
                  chosen ? "text-paper" : "text-paper/80",
                  card.state === "answered" && !chosen && "opacity-60",
                )}
              >
                {chosen ? (
                  <span
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-signal/15 text-signal"
                    aria-label={t("chat.botCard.chosen")}
                    role="img"
                  >
                    <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
                  </span>
                ) : (
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border font-mono text-[10px] text-paper-muted">
                    {index + 1}
                  </span>
                )}
                <span className="min-w-0 break-words pt-px">{option}</span>
              </li>
            );
          })}
        </ol>
      )}
      {waiting && !mine && (
        <p className="flex items-start gap-1.5 border-t border-border px-3 py-2 text-xs text-paper-muted">
          <CircleDashed className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <span>
            {deadline
              ? t("chat.botCard.onlyAskedUntil", { who: card.confirmBy ?? "", time: deadline })
              : t("chat.botCard.onlyAsked", { who: card.confirmBy ?? "" })}
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * The plan's answer, for the member who asked. Typing "sim" or "não" still
 * works; this is the same answer without typing. The card repaints for
 * everybody once the server has it.
 */
function PlanButtons({ planId, deadline }: { planId: string; deadline: string | null }) {
  const { t } = useTranslation();
  const [sending, setSending] = useState<"yes" | "no" | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);

  async function decide(decision: "yes" | "no") {
    setSending(decision);
    setError(null);
    try {
      await decideBotPlan(planId, decision);
    } catch (err) {
      setSending(null);
      setError(
        err instanceof ApiError && err.status === 409
          ? "chat.botCard.alreadyDecided"
          : "chat.botCard.decideError",
      );
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
      <Button
        type="button"
        size="sm"
        disabled={sending !== null}
        onClick={() => void decide("yes")}
      >
        {sending === "yes" ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
        ) : (
          <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden />
        )}
        {t("chat.botCard.confirmButton")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={sending !== null}
        onClick={() => void decide("no")}
      >
        <X className="mr-1.5 h-3.5 w-3.5" aria-hidden />
        {t("chat.botCard.cancelButton")}
      </Button>
      {deadline && !error && (
        <span className="ml-auto text-[11px] text-paper-muted">
          {t("chat.botCard.until", { time: deadline })}
        </span>
      )}
      {error && (
        <span role="alert" className="ml-auto text-[11px] text-danger">
          {t(error)}
        </span>
      )}
    </div>
  );
}

/**
 * Why a server bot did not answer, shown only to the member it did not answer
 * (`bot-notice`), above the composer. Silence alone reads as being ignored.
 */
export function BotNoticeRow({ notice, onDismiss }: { notice: BotNotice; onDismiss: () => void }) {
  const { t, locale } = useTranslation();
  const time = deadlineOf(notice.retryAt, locale);
  const values = { name: notice.botName, limit: notice.limit ?? 0, time: time ?? "" };
  const text =
    notice.reason === "busy"
      ? t("chat.botNotice.busy", values)
      : notice.reason === "member-hour"
        ? t(time ? "chat.botNotice.memberHourUntil" : "chat.botNotice.memberHour", values)
        : notice.reason === "server-day"
          ? t(time ? "chat.botNotice.serverDayUntil" : "chat.botNotice.serverDay", values)
          : t(time ? "chat.botNotice.budgetUntil" : "chat.botNotice.budget", values);
  return (
    <div
      role="status"
      data-bot-notice={notice.reason}
      className="mx-4 mb-1 flex shrink-0 items-start gap-2 rounded-md border border-border bg-surface-2/60 px-3 py-2 text-xs text-paper/90"
    >
      <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-paper-muted" aria-hidden />
      <div className="min-w-0 flex-1">
        <p>{text}</p>
        <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-paper-muted">
          <EyeOff className="h-3 w-3" aria-hidden />
          {t("chat.botNotice.onlyYou")}
        </p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded p-0.5 text-paper-muted hover:bg-surface-3 hover:text-paper"
        aria-label={t("chat.botNotice.dismiss")}
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
