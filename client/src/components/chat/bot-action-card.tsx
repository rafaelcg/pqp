import type { BotActionCard as BotActionCardData, BotActionItem, BotNotice } from "@pqp/shared";
import {
  Check,
  ChevronDown,
  CircleHelp,
  Clock,
  EyeOff,
  ListChecks,
  Loader2,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { answerBotAsk, ApiError, decideBotPlan } from "@/lib/api";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { intlLocale, type Locale } from "@/lib/locale";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/** A card younger than this animates in; older ones are drawn still. */
const FRESH_MS = 30_000;

/** How long each row waits after the one above it, so a result reads top down. */
const STAGGER_MS = 70;

/** A plan's window to answer, `BOT_PLAN_TTL_MS` on the server: the countdown's full ring. */
const PLAN_WINDOW_MS = 5 * 60_000;

/** Steps that cannot be undone: marked "Apaga" while they wait for a "sim". */
const DESTRUCTIVE_TOOLS = new Set(["delete_channel", "delete_message", "kick_member", "ban_member"]);

type Tone = "warning" | "accent" | "success" | "danger" | "neutral";

const TILE: Record<Tone, string> = {
  warning: "bg-warning-soft text-on-warning-soft",
  accent: "bg-accent-soft text-on-accent-soft",
  success: "bg-success-soft text-on-success-soft",
  danger: "bg-danger-soft text-on-danger-soft",
  neutral: "bg-surface-3 text-text-secondary",
};

/** The card's frame; a plan waiting on the viewer is outlined, so it is not missed. */
function CardFrame({
  kind,
  fresh,
  calling,
  children,
}: {
  kind: string;
  fresh: boolean;
  calling: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-bot-card={kind}
      className={cn(
        "mt-1.5 max-w-md overflow-hidden rounded-[var(--radius-card)] border bg-surface-card transition-colors duration-[var(--duration-base)]",
        calling ? "border-warning" : "border-border",
        fresh && "bot-step-in",
      )}
    >
      {children}
    </div>
  );
}

function CardHeader({
  icon: Icon,
  tone,
  spin,
  title,
  subtitle,
  trailing,
}: {
  icon: LucideIcon;
  tone: Tone;
  spin?: boolean;
  title: string;
  subtitle?: string | null;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 px-3 pb-2 pt-3">
      <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-control)]", TILE[tone])}>
        {spin ? (
          <Spinner className="h-4 w-4 motion-safe:animate-spin" />
        ) : (
          <Icon className="h-4 w-4" aria-hidden />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold leading-tight text-text">{title}</p>
        {subtitle && <p className="truncate text-xs text-text-tertiary">{subtitle}</p>}
      </div>
      {trailing}
    </div>
  );
}

/**
 * A settled card in one line: what happened, who decided it, and (for a card
 * with steps to show) a toggle that opens them. A card only takes room while
 * it needs somebody, or when something went wrong.
 */
function CompactRow({
  icon: Icon,
  tone,
  title,
  subtitle,
  trailing,
}: {
  icon: LucideIcon;
  tone: Tone;
  title: ReactNode;
  subtitle?: string | null;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2 px-2.5 py-2">
      <span className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-[var(--radius-control)]", TILE[tone])}>
        <Icon className="h-3.5 w-3.5" aria-hidden />
      </span>
      {/* Two lines at most: a long answer or step stays readable. */}
      <p className="line-clamp-2 min-w-0 flex-1 break-words pt-[3px] text-[13px] leading-snug text-text">
        <span className="font-semibold">{title}</span>
        {subtitle && <span className="text-text-tertiary"> · {subtitle}</span>}
      </p>
      {trailing}
    </div>
  );
}

function StepsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="flex shrink-0 items-center gap-1 rounded-[var(--radius-control)] px-1.5 py-1 text-xs text-text-tertiary transition-colors duration-[var(--duration-fast)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
    >
      {t(open ? "chat.botCard.hideSteps" : "chat.botCard.showSteps")}
      <ChevronDown
        className={cn("h-3.5 w-3.5 transition-transform duration-[var(--duration-fast)] motion-reduce:transition-none", open && "rotate-180")}
        aria-hidden
      />
    </button>
  );
}

/** A step's label with `#channel` names drawn as chips, the way chat draws them. */
function StepLabel({ label, struck }: { label: string; struck: boolean }) {
  const parts = label.split(/(#[\p{L}\p{N}_-]+)/u);
  return (
    <span className={cn("min-w-0 break-words", struck && "text-text-tertiary line-through")}>
      {parts.map((part, index) =>
        part.startsWith("#") && !struck ? (
          <span key={index} className="rounded-[var(--radius-tick)] bg-surface-2 px-1 font-semibold text-text">
            {part}
          </span>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </span>
  );
}

function StatusMark({
  item,
  index,
  fresh,
  running,
}: {
  item: BotActionItem;
  index: number;
  fresh: boolean;
  running: boolean;
}) {
  const { t } = useTranslation();
  const delay = { animationDelay: `${index * STAGGER_MS + 120}ms` };
  if (item.status === "ok") {
    return (
      <span
        className={cn(
          "grid h-5 w-5 shrink-0 place-items-center rounded-full bg-success-soft text-on-success-soft",
          fresh && "bot-step-pop",
        )}
        style={delay}
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
          "grid h-5 w-5 shrink-0 place-items-center rounded-full bg-danger-soft text-on-danger-soft",
          fresh && "bot-step-pop",
        )}
        style={delay}
        aria-label={t("chat.botCard.status.failed")}
        role="img"
      >
        <X className="h-3 w-3" strokeWidth={3} aria-hidden />
      </span>
    );
  }
  if (item.status === "unknown") {
    return (
      <span
        className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-warning-soft text-on-warning-soft"
        aria-label={t("chat.botCard.status.unknown")}
        role="img"
      >
        <span className="text-[11px] font-bold leading-none" aria-hidden>
          !
        </span>
      </span>
    );
  }
  if (running) {
    return (
      <Spinner
        className="h-5 w-5 shrink-0 text-accent motion-safe:animate-spin"
        label={t("chat.botCard.status.running")}
      />
    );
  }
  // A plan's step, waiting: its number, in the order it will run.
  return (
    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-border-strong text-[10px] font-semibold text-text-secondary">
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
  botName,
}: {
  card: BotActionCardData;
  /** The message that carries the card; a question's answer names it. */
  messageId: string;
  /** The message's; only a card that just arrived plays its entrance. */
  createdAt: string;
  /** Only the member who asked gets a plan's buttons. */
  currentUserId: string | null;
  /** The bot's name, for "ainda dá pra responder escrevendo pro Tico". */
  botName?: string;
}) {
  // Read once per mount: a list that remounts an old row on scroll must not
  // replay the entrance.
  const [fresh] = useState(() => Date.now() - new Date(createdAt).getTime() < FRESH_MS);
  const { t, locale } = useTranslation();
  const expired = useExpired(card.expiresAt, card.kind !== "result" && !card.state);
  const [open, setOpen] = useState(false);
  const [checksAtMount] = useState(() => card.items.map((item) => item.status));
  // What the card was when it was drawn: only a change after that animates,
  // and the buttons stay mounted long enough to fold away.
  const [settledAtMount] = useState(() => settledOf(card, expired));
  const [waitingAtMount] = useState(() => card.kind === "plan" && !card.state && !expired);

  if (card.kind === "ask") {
    return (
      <AskCard
        card={card}
        messageId={messageId}
        fresh={fresh}
        expired={expired}
        currentUserId={currentUserId}
        botName={botName ?? ""}
      />
    );
  }

  const total = card.items.length;
  const ok = card.items.filter((item) => item.status === "ok").length;
  const failed = card.items.filter((item) => item.status === "failed").length;
  const unknown = card.items.filter((item) => item.status === "unknown").length;
  const pending = card.items.filter((item) => item.status === "pending").length;
  const deadline = deadlineOf(card.expiresAt, locale);
  const isPlan = card.kind === "plan";
  const planState = isPlan ? (card.state ?? (expired ? "expired" : "waiting")) : null;
  const mine = !!card.confirmById && card.confirmById === currentUserId;
  const running = planState === "confirmed" && pending > 0;
  const struck = planState === "cancelled" || planState === "expired";
  const who = card.confirmBy ?? "";

  let header: { icon: LucideIcon; tone: Tone; spin?: boolean; title: string; subtitle: string | null };
  if (planState === "waiting") {
    header = {
      icon: ListChecks,
      tone: "warning",
      title: t("chat.botCard.planSteps", { count: total }),
      subtitle: mine ? t("chat.botCard.waitingYou") : t("chat.botCard.waitingWho", { who }),
    };
  } else if (planState === "cancelled") {
    header = { icon: X, tone: "neutral", title: t("chat.botCard.cancelledTitle"), subtitle: t("chat.botCard.cancelledBy", { who }) };
  } else if (planState === "expired") {
    header = {
      icon: Clock,
      tone: "neutral",
      title: t("chat.botCard.expiredTitle"),
      subtitle: deadline ? t("chat.botCard.expiredUntil", { time: deadline }) : t("chat.botCard.expiredNothing"),
    };
  } else if (running) {
    header = {
      // Drawn as the shared Spinner (`spin`); the glyph is only the type.
      icon: Loader2,
      tone: "accent",
      spin: true,
      title: t("chat.botCard.doing", { done: total - pending, total }),
      subtitle: t("chat.botCard.confirmedBy", { who }),
    };
  } else if (failed > 0) {
    header = {
      icon: TriangleAlert,
      tone: "danger",
      title: t("chat.botCard.partly", { done: ok, total }),
      subtitle: t("chat.botCard.failed", { count: failed }),
    };
  } else if (unknown > 0) {
    header = {
      icon: CircleHelp,
      tone: "warning",
      title: t("chat.botCard.unknownTitle", { count: unknown }),
      subtitle: t("chat.botCard.unknownHint"),
    };
  } else {
    header = {
      icon: Check,
      tone: "success",
      title: t("chat.botCard.doneTitle", { count: total }),
      subtitle: who
        ? isPlan
          ? t("chat.botCard.confirmedBy", { who })
          : t("chat.botCard.askedBy", { who })
        : null,
    };
  }

  const trailing =
    planState === "waiting" ? (
      mine && card.expiresAt ? (
        <Countdown expiresAt={card.expiresAt} />
      ) : deadline ? (
        <span className="shrink-0 text-xs text-text-tertiary">{t("chat.botCard.until", { time: deadline })}</span>
      ) : null
    ) : null;

  const settled = settledOf(card, expired);
  const steps = (
      <ol className={cn("space-y-1.5 px-3 pb-3", settled ? "pt-0.5" : "pt-1")}>
        {card.items.map((item, index) => {
          const firstPending = running && item.status === "pending" && index === total - pending;
          const destructive = planState === "waiting" && DESTRUCTIVE_TOOLS.has(item.tool);
          return (
            <li
              key={index}
              className={cn("flex items-start gap-2.5", fresh && "bot-step-in")}
              style={{ animationDelay: `${index * STAGGER_MS}ms` }}
            >
              <StatusMark
                item={item}
                index={index}
                fresh={fresh || item.status !== checksAtMount[index]}
                running={firstPending}
              />
              <div className="min-w-0 flex-1 pt-px">
                <p className="flex items-start gap-2 text-[13px] leading-snug text-text">
                  <StepLabel label={item.label} struck={struck} />
                  {destructive && (
                    <span className="ml-auto shrink-0 rounded-[var(--radius-tick)] bg-danger-soft px-1.5 py-px text-[10px] font-semibold text-on-danger-soft">
                      {t("chat.botCard.deletes")}
                    </span>
                  )}
                </p>
                {destructive && <p className="mt-0.5 text-xs text-text-tertiary">{t("chat.botCard.noUndo")}</p>}
                {item.detail && (
                  <p
                    className={cn(
                      "mt-0.5 break-words text-xs",
                      item.status === "failed" ? "text-danger" : "text-text-tertiary",
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
  );

  const single = settled && total === 1 && !struck;
  // One frame through every state: the header changes in place and the steps
  // and buttons fold away, so a plan settling into its one line shrinks
  // instead of being swapped for a different card.
  return (
    <CardFrame kind={card.kind} fresh={fresh} calling={planState === "waiting" && mine}>
      {settled ? (
        <div key="settled" className={cn(!settledAtMount && "chat-swap-in")}>
          <CompactRow
            icon={header.icon}
            tone={header.tone}
            title={single ? <StepLabel label={card.items[0]!.label} struck={false} /> : header.title}
            subtitle={header.subtitle}
            trailing={single ? null : <StepsToggle open={open} onToggle={() => setOpen((value) => !value)} />}
          />
        </div>
      ) : (
        <CardHeader {...header} trailing={trailing} />
      )}
      <div className="chat-collapse" data-open={!settled || (open && !single)}>
        <div>{steps}</div>
      </div>
      {(planState === "waiting" || waitingAtMount) && (
        <div className="chat-collapse" data-open={planState === "waiting"}>
          <div>
            {card.planId && mine ? (
              <PlanButtons planId={card.planId} />
            ) : (
              <p className="border-t border-border px-3 py-2 text-xs text-text-tertiary">
                {t("chat.botCard.onlyRequester", { who })}
              </p>
            )}
          </div>
        </div>
      )}
    </CardFrame>
  );
}

/** The time left to answer, as a ring that empties; amber in the last minute. */
function Countdown({ expiresAt }: { expiresAt: string }) {
  const end = new Date(expiresAt).getTime();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (now >= end) return;
    const timer = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(timer);
  }, [now, end]);
  const left = Math.max(0, Math.ceil((end - now) / 1000));
  const fraction = Math.min(1, left / (PLAN_WINDOW_MS / 1000));
  const lastMinute = left <= 60;
  const circumference = 2 * Math.PI * 7;
  return (
    <span
      className={cn("flex shrink-0 items-center gap-1.5 text-xs tabular-nums", lastMinute ? "text-warning" : "text-text-secondary")}
      role="timer"
    >
      <svg viewBox="0 0 18 18" className="h-[18px] w-[18px] -rotate-90" aria-hidden>
        <circle cx="9" cy="9" r="7" fill="none" stroke="var(--color-surface-3)" strokeWidth="2.5" />
        <circle
          cx="9"
          cy="9"
          r="7"
          fill="none"
          stroke={lastMinute ? "var(--color-warning)" : "var(--color-accent)"}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          className="transition-[stroke-dashoffset] duration-[1000ms] ease-linear motion-reduce:transition-none"
        />
      </svg>
      {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
    </span>
  );
}

/**
 * Done, cancelled or expired, with nothing that failed: drawn as one line. A
 * step that failed, or may not have finished, keeps the card open so it is
 * seen. A question is never "settled" here; it has its own one line.
 */
function settledOf(card: BotActionCardData, expired: boolean): boolean {
  if (card.kind === "ask") return false;
  const planState = card.kind === "plan" ? (card.state ?? (expired ? "expired" : "waiting")) : null;
  const count = (status: BotActionItem["status"]) => card.items.filter((item) => item.status === status).length;
  if (planState === "cancelled" || planState === "expired") return true;
  const running = planState === "confirmed" && count("pending") > 0;
  return !running && planState !== "waiting" && count("failed") === 0 && count("unknown") === 0;
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
 * Only that member gets buttons; a press wakes the bot with the answer and
 * posts nothing for them. Typing an answer works as well.
 */
function AskCard({
  card,
  messageId,
  fresh,
  expired,
  currentUserId,
  botName,
}: {
  card: BotActionCardData;
  messageId: string;
  fresh: boolean;
  expired: boolean;
  currentUserId: string | null;
  botName: string;
}) {
  const { t, locale } = useTranslation();
  const [sending, setSending] = useState<number | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const options = card.options ?? [];
  const waiting = !card.state && !expired;
  const mine = waiting && !!card.confirmById && card.confirmById === currentUserId;
  const deadline = deadlineOf(card.expiresAt, locale);
  const who = card.confirmBy ?? "";
  const answered = card.state === "answered";
  const [waitingAtMount] = useState(waiting);

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

  const header = answered
    ? { icon: Check, tone: "success" as Tone, title: t("chat.botCard.chose", { who }), subtitle: null }
    : !waiting
      ? {
          icon: Clock,
          tone: "neutral" as Tone,
          title: t("chat.botCard.askExpired"),
          subtitle: botName ? t("chat.botCard.askExpiredHint", { name: botName }) : null,
        }
      : mine
        ? { icon: CircleHelp, tone: "warning" as Tone, title: t("chat.botCard.pickOne"), subtitle: t("chat.botCard.orOwnWords") }
        : {
            icon: CircleHelp,
            tone: "neutral" as Tone,
            title: t("chat.botCard.askFor", { who }),
            subtitle: deadline ? t("chat.botCard.onlyAskedUntil", { who, time: deadline }) : t("chat.botCard.onlyAsked", { who }),
          };

  // Answered or run out: one line, with the answer readable in it. The
  // answers fold away under it rather than the card being swapped.
  const compact = answered || !waiting;
  const picked = answered && card.answer !== null ? options[card.answer] : null;
  return (
    <CardFrame kind="ask" fresh={fresh} calling={mine}>
      {compact ? (
        <div key="compact" className={cn(waitingAtMount && "chat-swap-in")}>
          <CompactRow
            icon={header.icon}
            tone={header.tone}
            title={
              picked ? (
                <>
                  <span className="font-normal text-text-secondary">{header.title}</span> {picked}
                </>
              ) : (
                header.title
              )
            }
            subtitle={picked ? null : header.subtitle}
          />
        </div>
      ) : (
        <CardHeader
          {...header}
          trailing={
            mine && deadline ? (
              <span className="shrink-0 text-xs text-text-tertiary">{t("chat.botCard.until", { time: deadline })}</span>
            ) : null
          }
        />
      )}
      {(waiting || waitingAtMount) && (
        <div className="chat-collapse" data-open={waiting}>
          <div>
            {/* The answers side by side, wrapping when they are long: a question
                with short answers is two lines tall, not one row per answer. */}
            <div className="flex flex-wrap gap-1.5 px-3 pb-3 pt-1">
              {options.map((option, index) =>
                mine ? (
                  <button
                    key={index}
                    type="button"
                    disabled={sending !== null}
                    onClick={() => void answer(index)}
                    className={cn(
                      "flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1.5 text-left text-[13px] font-medium text-text transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] disabled:cursor-default",
                      sending === index
                        ? "border-accent bg-accent-soft text-on-accent-soft"
                        : "border-border-strong bg-surface-2 hover:border-accent hover:bg-accent-soft hover:text-on-accent-soft",
                      sending !== null && sending !== index && "text-text-tertiary",
                      fresh && "bot-step-in",
                    )}
                    style={{ animationDelay: `${index * STAGGER_MS}ms` }}
                  >
                    {sending === index && <Spinner className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin" />}
                    <span className="min-w-0 break-words">{option}</span>
                  </button>
                ) : (
                  <span
                    key={index}
                    className={cn(
                      "max-w-full break-words rounded-full border px-3 py-1.5 text-[13px]",
                      card.answer === index ? "border-accent bg-accent-soft text-on-accent-soft" : "border-border text-text-secondary",
                    )}
                  >
                    {option}
                  </span>
                ),
              )}
              {error && (
                <span role="alert" className="w-full text-xs text-danger">
                  {t(error)}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </CardFrame>
  );
}

/**
 * The plan's answer, for the member who asked. Typing "sim" or "não" still
 * works; this is the same answer without typing. The card repaints for
 * everybody once the server has it.
 */
function PlanButtons({ planId }: { planId: string }) {
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
    <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2.5">
      <Button type="button" size="sm" disabled={sending !== null} onClick={() => void decide("yes")}>
        {sending === "yes" ? (
          <Spinner className="mr-1.5 h-3.5 w-3.5 motion-safe:animate-spin" />
        ) : (
          <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden />
        )}
        {sending === "yes" ? t("chat.botCard.confirming") : t("chat.botCard.confirmButton")}
      </Button>
      <Button type="button" size="sm" variant="secondary" disabled={sending !== null} onClick={() => void decide("no")}>
        {t("chat.botCard.cancelButton")}
      </Button>
      {error ? (
        <span role="alert" className="ml-auto text-xs text-danger">
          {t(error)}
        </span>
      ) : (
        <span className="ml-auto text-xs text-text-tertiary">{t("chat.botCard.orSayYes")}</span>
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
