import {
  REPORT_REASON_LABELS,
  type AllReport,
  type ReportStatus,
} from "@pqp/shared";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  ApiError,
  fetchAllReports,
  removeReportedMessage,
  resolveReport,
} from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { cn, formatFullTimestamp } from "@/lib/utils";

/**
 * The instance moderator's view across every queue at once: every server's
 * own reports plus the instance queue (DM/group and community-listing
 * reports) that `reports-section.tsx` never sees, because that component is
 * scoped to one server's managers.
 *
 * Same shape as `ReportsSection` on purpose — same tabs, same load-more, same
 * busy/note/resolve dance — plus two things a server manager never needs:
 * which server (or the instance queue) a row belongs to, and, for an
 * automated report, the scanner's own verdict.
 */

const STATUS_TABS: Array<{ id: ReportStatus | "all"; key: "reports.tab.open" | "reports.tab.actioned" | "reports.tab.dismissed" | "reports.tab.all" }> = [
  { id: "open", key: "reports.tab.open" },
  { id: "actioned", key: "reports.tab.actioned" },
  { id: "dismissed", key: "reports.tab.dismissed" },
  { id: "all", key: "reports.tab.all" },
];

const EMPTY_BY_STATUS: Record<ReportStatus | "all", "reports.empty.open" | "reports.empty.actioned" | "reports.empty.dismissed" | "reports.empty.all"> = {
  open: "reports.empty.open",
  actioned: "reports.empty.actioned",
  dismissed: "reports.empty.dismissed",
  all: "reports.empty.all",
};

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

export function AllReportsSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ReportStatus | "all">("open");
  const [reports, setReports] = useState<AllReport[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [confirmingRemoveId, setConfirmingRemoveId] = useState<string | null>(
    null,
  );
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());

  const filter = status === "all" ? undefined : status;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchAllReports({ status: filter })
      .then((res) => {
        if (!cancelled) {
          setReports(res.reports);
          setHasMore(res.hasMore);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(messageOf(err, t("reports.loadFailed")));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [filter, t]);

  async function loadMore() {
    const last = reports.at(-1);
    if (!last) {
      return;
    }
    setLoadingMore(true);
    try {
      const res = await fetchAllReports({
        status: filter,
        before: last.id,
      });
      setReports((prev) => [...prev, ...res.reports]);
      setHasMore(res.hasMore);
    } catch (err) {
      setError(messageOf(err, t("reports.loadMoreFailed")));
    } finally {
      setLoadingMore(false);
    }
  }

  const resolve = useCallback(
    async (report: AllReport, next: "actioned" | "dismissed") => {
      setBusyId(report.id);
      setError(null);
      try {
        const res = await resolveReport(report.id, {
          status: next,
          note: notes[report.id]?.trim() || null,
        });
        setReports((prev) =>
          // On the open tab a closed report leaves the list; on any other tab it
          // stays and re-renders with its new state.
          status === "open"
            ? prev.filter((r) => r.id !== report.id)
            : prev.map((r) =>
                r.id === report.id ? { ...r, ...res.report } : r,
              ),
        );
      } catch (err) {
        setError(messageOf(err, t("reports.updateFailed")));
      } finally {
        setBusyId(null);
      }
    },
    [notes, status, t],
  );

  const removeMessage = useCallback(
    async (reportId: string) => {
      setBusyId(reportId);
      setError(null);
      try {
        await removeReportedMessage(reportId);
        setReports((prev) =>
          prev.map((r) =>
            r.id === reportId ? { ...r, messageDeleted: true } : r,
          ),
        );
        setRemovedIds((prev) => new Set(prev).add(reportId));
      } catch (err) {
        setError(messageOf(err, t("reports.all.removeMessageFailed")));
      } finally {
        setBusyId(null);
      }
    },
    [t],
  );

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap gap-1.5" role="tablist">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={status === tab.id}
            onClick={() => setStatus(tab.id)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              status === tab.id
                ? "bg-signal text-ink"
                : "bg-ink-3 text-paper-muted hover:text-paper",
            )}
          >
            {t(tab.key)}
          </button>
        ))}
      </div>

      {loading && (
        <p role="status" aria-live="polite" className="text-sm text-paper-muted">
          Loading…
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {!loading && !error && reports.length === 0 && (
        <p className="text-sm text-paper-muted">{t(EMPTY_BY_STATUS[status])}</p>
      )}

      {reports.length > 0 && (
        <ul className="max-h-96 space-y-2 overflow-y-auto">
          {reports.map((report) => {
            const canRemoveMessage =
              report.subjectType === "message" &&
              Boolean(report.messageId) &&
              !report.messageDeleted;
            return (
              <li
                key={report.id}
                className="space-y-2 rounded-md border border-ink-4 bg-ink-3/40 p-3 text-sm"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <p className="text-paper">
                    <span className="font-semibold">
                      {REPORT_REASON_LABELS[report.reason]}
                    </span>
                    {" — "}
                    {t(
                      report.subjectType === "message"
                        ? "reports.subjectMessage"
                        : "reports.subjectAccount",
                    )}{" "}
                    <span className="font-semibold">
                      {report.reportedUserName ?? t("reports.departed")}
                    </span>
                    {report.channelName && (
                      <span className="text-paper-muted">
                        {t("reports.inChannel", { name: report.channelName })}
                      </span>
                    )}
                  </p>
                  <span className="text-xs text-paper-muted">
                    {formatFullTimestamp(report.createdAt)}
                  </span>
                </div>

                <div>
                  {report.serverId ? (
                    <span className="inline-block rounded bg-ink-4 px-1.5 py-0.5 text-xs text-paper-muted">
                      {t("reports.all.inServer", {
                        name: report.serverName ?? t("reports.all.unknownServer"),
                      })}
                    </span>
                  ) : (
                    <span className="inline-block rounded bg-signal/15 px-1.5 py-0.5 text-xs font-medium text-signal">
                      {t("reports.all.instanceQueue")}
                    </span>
                  )}
                </div>

                <p className="text-xs text-paper-muted">
                  {t("reports.reportedBy", {
                    name: report.reporterName ?? t("reports.departed"),
                  })}
                </p>

                {report.contentSnapshot !== null && (
                  <blockquote className="whitespace-pre-wrap break-words rounded-md border-l-2 border-ink-4 bg-ink px-3 py-2 text-sm text-paper">
                    {report.contentSnapshot}
                  </blockquote>
                )}
                {report.messageDeleted && (
                  <p className="text-xs text-warning">
                    {t("reports.messageDeleted")}
                  </p>
                )}

                {report.details && (
                  <p className="whitespace-pre-wrap break-words text-sm text-paper-muted">
                    {report.details}
                  </p>
                )}

                {report.scan && (
                  <div className="space-y-0.5 rounded-md border border-ink-4 bg-ink px-3 py-2 text-xs text-paper-muted">
                    <p className="font-medium text-paper-muted">
                      {t("reports.all.scanTitle")}
                    </p>
                    <p>{t("reports.all.scanStatus", { status: report.scan.status })}</p>
                    <p>
                      {t("reports.all.scanProvider", {
                        provider: report.scan.provider ?? t("reports.all.scanUnknown"),
                      })}
                    </p>
                    {report.scan.score !== null && (
                      <p>
                        {t("reports.all.scanScore", {
                          score: report.scan.score.toFixed(2),
                        })}
                      </p>
                    )}
                    <p>
                      {t("reports.all.scanLabels", {
                        labels: report.scan.labels.length
                          ? report.scan.labels.join(", ")
                          : t("reports.all.scanNoLabels"),
                      })}
                    </p>
                    {report.scan.contentType && (
                      <p>
                        {t("reports.all.scanContentType", {
                          contentType: report.scan.contentType,
                        })}
                      </p>
                    )}
                    <p>
                      {report.scan.stillAttached
                        ? t("reports.all.scanStillAttached")
                        : t("reports.all.scanNotAttached")}
                    </p>
                  </div>
                )}

                {report.status === "open" ? (
                  <div className="space-y-2">
                    <label className="block text-xs text-paper-muted">
                      {t("reports.noteLabel")}
                      <input
                        value={notes[report.id] ?? ""}
                        disabled={busyId === report.id}
                        onChange={(e) =>
                          setNotes((prev) => ({
                            ...prev,
                            [report.id]: e.target.value,
                          }))
                        }
                        className="mt-1 h-9 w-full rounded-md border border-ink-4 bg-ink px-3 text-sm text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/50 disabled:opacity-50"
                        placeholder={t("reports.notePlaceholder")}
                      />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={busyId === report.id}
                        onClick={() => void resolve(report, "actioned")}
                      >
                        {t("reports.markActioned")}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busyId === report.id}
                        onClick={() => void resolve(report, "dismissed")}
                      >
                        {t("reports.dismiss")}
                      </Button>
                      {canRemoveMessage && (
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busyId === report.id}
                          onClick={() => setConfirmingRemoveId(report.id)}
                        >
                          {t("reports.all.removeMessage")}
                        </Button>
                      )}
                    </div>
                    {removedIds.has(report.id) && (
                      <p className="text-xs text-signal">
                        {t("reports.all.removeMessageDone")}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-paper-muted">
                    {t(
                      report.resolvedAt
                        ? "reports.resolvedBy"
                        : "reports.resolvedByNoDate",
                      {
                        status: t(
                          report.status === "actioned"
                            ? "reports.tab.actioned"
                            : "reports.tab.dismissed",
                        ),
                        name: report.resolvedByName ?? t("reports.departed"),
                        date: report.resolvedAt
                          ? formatFullTimestamp(report.resolvedAt)
                          : "",
                      },
                    )}
                    {report.resolutionNote ? ` — ${report.resolutionNote}` : ""}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {hasMore && (
        <Button
          variant="secondary"
          size="sm"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? t("common.loading") : t("common.loadMore")}
        </Button>
      )}

      <ConfirmDialog
        open={confirmingRemoveId !== null}
        title={t("reports.all.removeMessageConfirmTitle")}
        description={t("reports.all.removeMessageConfirm")}
        confirmLabel={t("reports.all.removeMessageConfirmAction")}
        onConfirm={() => {
          if (confirmingRemoveId) {
            void removeMessage(confirmingRemoveId);
          }
        }}
        onClose={() => setConfirmingRemoveId(null)}
      />
    </section>
  );
}
