import {
  REPORT_REASON_LABELS,
  TIMEOUT_PRESET_MINUTES,
  type ReportContext,
  type ReportContextMessage,
  type ReportSubjectType,
} from "@pqp/shared";
import {
  Ban,
  ChevronDown,
  Flag,
  Hourglass,
  Phone,
  PhoneMissed,
  Server,
  ShieldAlert,
  UserPlus,
  UserX,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { UserAvatar } from "@/components/user/user-avatar";
import {
  ApiError,
  banMember,
  fetchReportContext,
  terminateAccount,
  timeoutMember,
} from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { buildTimeline, type TimelineEvent } from "@/lib/report-timeline";
import { cn, formatFullTimestamp, formatRelativeShort } from "@/lib/utils";

/**
 * The "Contexto" panel on a report card.
 *
 * A report about an account carries no message and no details, so the card
 * alone gives a moderator nothing to judge. Expanding this loads
 * `GET /api/reports/:id/context` once and lays out: who the account is and how
 * old, what it did across the instance (counts only), the sequence of it all
 * on a timeline, the words it left in servers, and the direct actions
 * (timeout, server ban, account termination) so the decision does not mean
 * leaving the card.
 *
 * What is in the read depends on who is asking and the SERVER decides it. A
 * server's staff get a context that stops at their server, and this panel
 * simply renders what is present. It never hides or reveals anything itself.
 */

type Translate = ReturnType<typeof useTranslation>["t"];

export interface ReportContextPanelProps {
  report: {
    id: string;
    subjectType: ReportSubjectType;
    createdAt: string;
    reportedUserName: string | null;
  };
  /** The moderator's note, reused as the reason of a ban or a timeout. */
  note: string;
}

/** "3 min", "2 h", "5 d": a span a moderator reads. */
export function describeSpan(span: number, t: Translate): string {
  const minutes = Math.round(span / 60_000);
  if (span < 60_000) {
    return t("reports.ctx.span.lessThanMinute");
  }
  if (minutes < 60) {
    return t("timeout.minutes", { count: minutes });
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return t("timeout.hours", { count: hours });
  }
  return t("timeout.days", { count: Math.round(hours / 24) });
}

function describeMinutes(minutes: number, t: Translate): string {
  if (minutes < 60) {
    return t("timeout.minutes", { count: minutes });
  }
  if (minutes < 60 * 24) {
    return t("timeout.hours", { count: minutes / 60 });
  }
  return t("timeout.days", { count: minutes / (60 * 24) });
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function Stat({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: number;
  sub?: string;
  tone?: "neutral" | "warn";
}) {
  return (
    <div className="rounded-md border border-ink-4 bg-ink px-2.5 py-2">
      <p
        className={cn(
          "font-display text-lg font-bold leading-none tabular-nums",
          tone === "warn" && value > 0 ? "text-warning" : "text-paper",
        )}
      >
        {value}
      </p>
      <p className="mt-1 text-[11px] leading-tight text-paper-muted">{label}</p>
      {sub && (
        <p className="mt-0.5 text-[11px] leading-tight text-paper-muted">
          {sub}
        </p>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-[11px] font-semibold uppercase tracking-wider text-paper-muted">
      {children}
    </h4>
  );
}

function Message({
  message,
  mark,
  t,
}: {
  message: ReportContextMessage;
  mark?: boolean;
  t: Translate;
}) {
  const who =
    message.party === "reported"
      ? t("reports.ctx.party.reported")
      : message.party === "reporter"
        ? t("reports.ctx.party.reporter")
        : message.authorName;
  return (
    <li
      className={cn(
        "flex gap-2 rounded px-1.5 py-1",
        mark && "bg-signal/10 ring-1 ring-signal/40",
      )}
    >
      <span
        className={cn(
          "w-20 shrink-0 truncate text-[11px] font-semibold",
          message.party === "reported" ? "text-danger" : "text-paper-muted",
        )}
        title={message.authorName}
      >
        {who}
      </span>
      <span className="min-w-0 flex-1 text-xs text-paper">
        {message.isCall ? (
          <span className="inline-flex items-center gap-1 text-paper-muted">
            <PhoneMissed className="h-3.5 w-3.5" aria-hidden="true" />
            {t("reports.ctx.missedCall")}
          </span>
        ) : (
          <span className="whitespace-pre-wrap break-words">{message.body}</span>
        )}
      </span>
      <time
        className="shrink-0 text-[11px] text-paper-muted"
        dateTime={message.createdAt}
        title={formatFullTimestamp(message.createdAt)}
      >
        {formatRelativeShort(message.createdAt)}
      </time>
    </li>
  );
}

const TIMELINE_ICONS: Record<TimelineEvent["kind"], LucideIcon> = {
  account: UserPlus,
  contacts: Phone,
  blocked: UserX,
  "server-created": Server,
  "other-report": Flag,
  ban: Ban,
  timeout: Hourglass,
  "this-report": ShieldAlert,
};

function timelineText(event: TimelineEvent, t: Translate): string {
  switch (event.kind) {
    case "account":
      return t("reports.ctx.timeline.account");
    case "contacts": {
      const parts: string[] = [];
      if (event.dms > 0) {
        parts.push(t("reports.ctx.timeline.dms", { count: event.dms }));
      }
      if (event.calls > 0) {
        parts.push(t("reports.ctx.timeline.calls", { count: event.calls }));
      }
      const span = new Date(event.until).getTime() - new Date(event.at).getTime();
      const text = parts.join(", ");
      return span >= 60_000
        ? t("reports.ctx.timeline.within", {
            text,
            span: describeSpan(span, t),
          })
        : text;
    }
    case "blocked":
      return t("reports.ctx.timeline.blocked");
    case "server-created":
      return t("reports.ctx.timeline.serverCreated", {
        name: event.name,
        count: event.members,
      });
    case "other-report":
      return t("reports.ctx.timeline.otherReport", {
        id: event.id,
        reason: REPORT_REASON_LABELS[event.reason],
        status: t(
          event.status === "open"
            ? "reports.tab.open"
            : event.status === "actioned"
              ? "reports.tab.actioned"
              : "reports.tab.dismissed",
        ),
      });
    case "ban":
      return t("reports.ctx.timeline.ban", { server: event.serverName });
    case "timeout":
      return t("reports.ctx.timeline.timeout", { server: event.serverName });
    case "this-report":
      return t("reports.ctx.timeline.thisReport");
  }
}

function Timeline({
  events,
  accountCreatedAt,
  t,
}: {
  events: TimelineEvent[];
  accountCreatedAt: string | null;
  t: Translate;
}) {
  const origin = accountCreatedAt ? new Date(accountCreatedAt).getTime() : null;
  return (
    <ol className="space-y-0" aria-label={t("reports.ctx.timeline.title")}>
      {events.map((event, index) => {
        const Icon = TIMELINE_ICONS[event.kind];
        const alarming = event.kind === "contacts" || event.kind === "blocked";
        const offset =
          origin !== null && event.kind !== "account"
            ? new Date(event.at).getTime() - origin
            : null;
        return (
          <li key={`${event.kind}-${index}`} className="relative flex gap-2.5 pb-2.5 last:pb-0">
            {index < events.length - 1 && (
              <span
                className="absolute left-[11px] top-6 bottom-0 w-px bg-ink-4"
                aria-hidden="true"
              />
            )}
            <span
              className={cn(
                "relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
                event.kind === "this-report"
                  ? "border-signal bg-signal/15 text-signal"
                  : alarming
                    ? "border-warning/60 bg-warning/10 text-warning"
                    : "border-ink-4 bg-ink text-paper-muted",
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-paper">{timelineText(event, t)}</p>
              <p className="text-[11px] text-paper-muted">
                {formatFullTimestamp(event.at)}
                {offset !== null && offset >= 0 && (
                  <>
                    {" · "}
                    {t("reports.ctx.timeline.afterSignup", {
                      span: describeSpan(offset, t),
                    })}
                  </>
                )}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function ReportContextPanel({ report, note }: ReportContextPanelProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState<ReportContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [timeoutChoosing, setTimeoutChoosing] = useState(false);
  const [pendingTimeout, setPendingTimeout] = useState<number | null>(null);
  const [confirmingBan, setConfirmingBan] = useState(false);
  const [confirmingTerminate, setConfirmingTerminate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionDone, setActionDone] = useState<string | null>(null);

  // A response that lands after the card was closed and reopened, or after a
  // newer load started, must not overwrite the newer one.
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchReportContext(report.id);
      if (generation.current === mine) {
        setContext(next);
      }
    } catch (err) {
      if (generation.current === mine) {
        setError(messageOf(err, t("reports.ctx.loadFailed")));
      }
    } finally {
      if (generation.current === mine) {
        setLoading(false);
      }
    }
  }, [report.id, t]);

  useEffect(() => {
    if (open && context === null && !loading && error === null) {
      void load();
    }
  }, [open, context, loading, error, load]);

  const account = context?.account ?? null;
  const serverAction = context?.actions.server ?? null;
  const reason = note.trim() || null;

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setActionError(null);
    setActionDone(null);
    try {
      await action();
      setActionDone(done);
      await load();
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        typeof err.details === "object" &&
        err.details !== null &&
        "servers" in err.details
      ) {
        const servers = (err.details as { servers?: { name: string }[] })
          .servers;
        setActionError(
          t("reports.ctx.actions.ownsServers", {
            servers: (servers ?? []).map((s) => s.name).join(", "),
          }),
        );
      } else {
        setActionError(messageOf(err, t("reports.ctx.actions.failed")));
      }
      // A failure can be ambiguous (the write committed and the response was
      // lost), so reconcile with the server before offering the action again.
      await load();
    } finally {
      setBusy(false);
    }
  }

  const timeline =
    context && report.subjectType !== "message"
      ? buildTimeline(context, report.createdAt)
      : null;
  const accountAgeMs = account
    ? Date.now() - new Date(account.createdAt).getTime()
    : null;

  return (
    <div className="rounded-md border border-ink-4 bg-ink-3/30">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`report-context-${report.id}`}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-xs font-medium text-paper-muted transition-colors hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/50"
      >
        <span>{t("reports.ctx.toggle")}</span>
        <ChevronDown
          className={cn(
            "h-4 w-4 transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          id={`report-context-${report.id}`}
          className="space-y-4 border-t border-ink-4 px-3 py-3"
        >
          {loading && context === null && (
            <p role="status" aria-live="polite" className="text-xs text-paper-muted">
              {t("common.loading")}
            </p>
          )}
          {error && (
            <div className="space-y-2">
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setError(null);
                  void load();
                }}
              >
                {t("reports.ctx.retry")}
              </Button>
            </div>
          )}

          {context && (
            <>
              {context.lens === "server" && (
                <p className="text-[11px] text-paper-muted">
                  {t("reports.ctx.serverLens")}
                </p>
              )}

              {account ? (
                <div className="flex items-center gap-2.5">
                  <UserAvatar
                    name={account.displayName}
                    avatarUrl={account.avatarUrl}
                    className="h-9 w-9"
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-paper">
                      {account.displayName}
                      {account.tag && (
                        <span className="ml-1.5 font-normal text-paper-muted">
                          {account.tag}
                        </span>
                      )}
                    </p>
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-paper-muted">
                      <span
                        className={cn(
                          accountAgeMs !== null &&
                            accountAgeMs < DAY_MS &&
                            "font-semibold text-warning",
                        )}
                        title={formatFullTimestamp(account.createdAt)}
                      >
                        {t("reports.ctx.accountCreated", {
                          when: formatRelativeShort(account.createdAt),
                        })}
                      </span>
                      {account.lastCountry && (
                        <span>
                          {t("reports.ctx.country", {
                            country: account.lastCountry,
                          })}
                        </span>
                      )}
                      {account.deletionStartedAt && (
                        <span className="font-semibold text-danger">
                          {t("reports.ctx.deleting")}
                        </span>
                      )}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-paper-muted">
                  {t("reports.ctx.noAccount")}
                </p>
              )}

              {context.signals && (
                <div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Stat
                      tone="warn"
                      label={t("reports.ctx.stat.dms")}
                      value={context.signals.dmsStarted.total}
                      sub={t("reports.ctx.stat.firstHour", {
                        count: context.signals.dmsStarted.firstHour,
                      })}
                    />
                    <Stat
                      tone="warn"
                      label={t("reports.ctx.stat.calls")}
                      value={context.signals.callsPlaced.total}
                      sub={t("reports.ctx.stat.firstHour", {
                        count: context.signals.callsPlaced.firstHour,
                      })}
                    />
                    <Stat
                      tone="warn"
                      label={t("reports.ctx.stat.blocks")}
                      value={context.signals.blockedByCount}
                    />
                    <Stat
                      tone="warn"
                      label={t("reports.ctx.stat.reports")}
                      value={context.otherReports.length}
                    />
                  </div>
                  <p className="mt-1.5 text-[11px] text-paper-muted">
                    {t("reports.ctx.callsNote")}
                  </p>
                </div>
              )}

              {timeline && (
                <section className="space-y-2">
                  <SectionTitle>{t("reports.ctx.timeline.title")}</SectionTitle>
                  <Timeline
                    events={timeline}
                    accountCreatedAt={account?.createdAt ?? null}
                    t={t}
                  />
                </section>
              )}

              {context.surrounding && (
                <section className="space-y-1.5">
                  <SectionTitle>{t("reports.ctx.surrounding")}</SectionTitle>
                  {context.surrounding.withheld ? (
                    <p className="text-xs text-paper-muted">
                      {t(
                        context.surrounding.withheld === "group"
                          ? "reports.ctx.withheld.group"
                          : "reports.ctx.withheld.noAccess",
                      )}
                    </p>
                  ) : (
                    <ul className="space-y-0.5">
                      {context.surrounding.before.map((m) => (
                        <Message key={m.id} message={m} t={t} />
                      ))}
                      <li className="px-1.5 py-0.5 text-[11px] font-semibold text-signal">
                        {t("reports.ctx.reportedMessage")}
                      </li>
                      {context.surrounding.after.map((m) => (
                        <Message key={m.id} message={m} t={t} />
                      ))}
                    </ul>
                  )}
                </section>
              )}

              {context.conversation && (
                <section className="space-y-1.5">
                  <SectionTitle>{t("reports.ctx.conversation")}</SectionTitle>
                  <ul className="space-y-0.5">
                    {context.conversation.map((m) => (
                      <Message key={m.id} message={m} t={t} />
                    ))}
                  </ul>
                </section>
              )}

              {account && (
                <section className="space-y-1.5">
                  <SectionTitle>{t("reports.ctx.serverMessages")}</SectionTitle>
                  {context.serverMessages.length === 0 ? (
                    <p className="text-xs text-paper-muted">
                      {t("reports.ctx.serverMessagesEmpty")}
                    </p>
                  ) : (
                    <ul className="max-h-60 space-y-1 overflow-y-auto pr-1">
                      {context.serverMessages.map((m) => (
                        <li
                          key={m.id}
                          className="rounded bg-ink px-2 py-1.5 text-xs"
                        >
                          <p className="flex flex-wrap items-baseline justify-between gap-x-2 text-[11px] text-paper-muted">
                            <span className="truncate">
                              {m.serverName} #{m.channelName}
                              {m.isPrivate && ` (${t("reports.ctx.private")})`}
                            </span>
                            <time
                              dateTime={m.createdAt}
                              title={formatFullTimestamp(m.createdAt)}
                            >
                              {formatRelativeShort(m.createdAt)}
                            </time>
                          </p>
                          {m.body && (
                            <p className="mt-0.5 whitespace-pre-wrap break-words text-paper">
                              {m.body}
                            </p>
                          )}
                          {m.attachmentCount > 0 && (
                            <p className="mt-0.5 text-[11px] text-paper-muted">
                              {t("reports.ctx.attachments", {
                                count: m.attachmentCount,
                              })}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}

              {context.ownedServers.length > 0 && (
                <section className="space-y-1.5">
                  <SectionTitle>{t("reports.ctx.owned")}</SectionTitle>
                  <ul className="space-y-0.5">
                    {context.ownedServers.map((s) => (
                      <li key={s.id} className="flex items-baseline justify-between gap-2 text-xs text-paper">
                        <span className="truncate">{s.name}</span>
                        <span className="shrink-0 text-[11px] text-paper-muted">
                          {t("reports.ctx.members", { count: s.memberCount })}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {context.otherReports.length > 0 && (
                <section className="space-y-1.5">
                  <SectionTitle>{t("reports.ctx.otherReports")}</SectionTitle>
                  <ul className="space-y-0.5">
                    {context.otherReports.map((r) => (
                      <li key={r.id} className="text-xs text-paper">
                        <span className="font-semibold">#{r.id}</span>{" "}
                        {REPORT_REASON_LABELS[r.reason]}
                        <span className="text-paper-muted">
                          {" · "}
                          {t(
                            r.status === "open"
                              ? "reports.tab.open"
                              : r.status === "actioned"
                                ? "reports.tab.actioned"
                                : "reports.tab.dismissed",
                          )}
                          {r.serverName ? ` · ${r.serverName}` : ""}
                          {" · "}
                          {formatRelativeShort(r.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {(context.sanctions.bans.length > 0 ||
                context.sanctions.timeouts.length > 0) && (
                <section className="space-y-1.5">
                  <SectionTitle>{t("reports.ctx.sanctions")}</SectionTitle>
                  <ul className="space-y-0.5 text-xs text-paper">
                    {context.sanctions.bans.map((b) => (
                      <li key={`ban-${b.serverId}`}>
                        {t("reports.ctx.timeline.ban", { server: b.serverName })}
                        {b.reason && (
                          <span className="text-paper-muted">{` · ${b.reason}`}</span>
                        )}
                      </li>
                    ))}
                    {context.sanctions.timeouts.map((x) => (
                      <li key={`timeout-${x.serverId}`}>
                        {t("reports.ctx.timeline.timeout", {
                          server: x.serverName,
                        })}
                        <span className="text-paper-muted">
                          {` · ${t("reports.ctx.until", {
                            when: formatFullTimestamp(x.expiresAt),
                          })}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Not while the context is stale (a failed refresh): the
                  actions it offers may already have happened. */}
              {account &&
                error === null &&
                (context.actions.canTerminate ||
                  (serverAction &&
                    (serverAction.canBan || serverAction.canTimeout))) && (
                  <section className="space-y-2 border-t border-ink-4 pt-3">
                    <SectionTitle>{t("reports.ctx.actions.title")}</SectionTitle>
                    <div className="flex flex-wrap gap-2">
                      {serverAction?.canTimeout && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          aria-expanded={timeoutChoosing}
                          onClick={() => setTimeoutChoosing((v) => !v)}
                        >
                          {t("timeout.action")}
                        </Button>
                      )}
                      {serverAction?.canBan && !serverAction.alreadyBanned && (
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busy}
                          onClick={() => setConfirmingBan(true)}
                        >
                          {t("reports.ctx.actions.ban", {
                            server: serverAction.name,
                          })}
                        </Button>
                      )}
                      {serverAction?.alreadyBanned && (
                        <span className="self-center text-xs text-paper-muted">
                          {t("reports.ctx.actions.alreadyBanned", {
                            server: serverAction.name,
                          })}
                        </span>
                      )}
                      {context.actions.canTerminate && (
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busy}
                          onClick={() => setConfirmingTerminate(true)}
                        >
                          {t("reports.ctx.actions.terminate")}
                        </Button>
                      )}
                    </div>
                    {timeoutChoosing && serverAction?.canTimeout && (
                      <div
                        className="flex flex-wrap items-center gap-1.5"
                        role="group"
                        aria-label={t("timeout.howLong")}
                      >
                        {TIMEOUT_PRESET_MINUTES.map((minutes) => (
                          <Button
                            key={minutes}
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => setPendingTimeout(minutes)}
                          >
                            {describeMinutes(minutes, t)}
                          </Button>
                        ))}
                      </div>
                    )}
                  </section>
                )}

              {/* Outside the actions section on purpose: after a termination
                  the account is gone and that section with it, and the
                  moderator still needs to read that it worked. */}
              {actionDone && (
                <p role="status" className="text-xs text-signal">
                  {actionDone}
                </p>
              )}
              {actionError && (
                <p role="alert" className="text-xs text-danger">
                  {actionError}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {account && serverAction && (
        <>
          <ConfirmDialog
            open={pendingTimeout !== null}
            title={t("timeout.title", { name: account.displayName })}
            description={t("timeout.body", {
              name: account.displayName,
              server: serverAction.name,
            })}
            confirmLabel={
              pendingTimeout !== null
                ? t("timeout.confirm", {
                    duration: describeMinutes(pendingTimeout, t),
                  })
                : ""
            }
            onConfirm={() => {
              const minutes = pendingTimeout;
              if (minutes === null) {
                return;
              }
              setTimeoutChoosing(false);
              void run(
                () => timeoutMember(serverAction.id, account.id, minutes, reason),
                t("reports.ctx.actions.timedOut", {
                  duration: describeMinutes(minutes, t),
                }),
              );
            }}
            onClose={() => setPendingTimeout(null)}
          />
          <ConfirmDialog
            open={confirmingBan}
            title={t("member.banTitle", { name: account.displayName })}
            description={t("member.banBody", {
              name: account.displayName,
              server: serverAction.name,
            })}
            confirmLabel={t("member.banAction")}
            onConfirm={() =>
              void run(
                () => banMember(serverAction.id, account.id, reason),
                t("reports.ctx.actions.banned", { server: serverAction.name }),
              )
            }
            onClose={() => setConfirmingBan(false)}
          />
        </>
      )}
      {account && context?.actions.canTerminate && (
        <ConfirmDialog
          open={confirmingTerminate}
          title={t("reports.ctx.actions.terminateTitle", {
            name: account.displayName,
          })}
          description={t("reports.ctx.actions.terminateBody")}
          confirmLabel={t("reports.ctx.actions.terminateAction")}
          onConfirm={() =>
            void run(
              () => terminateAccount(account.id),
              t("reports.ctx.actions.terminated"),
            )
          }
          onClose={() => setConfirmingTerminate(false)}
        />
      )}
    </div>
  );
}
