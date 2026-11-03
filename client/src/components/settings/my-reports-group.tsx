import type { ReportStatus, ReportSummary } from "@pqp/shared";
import { Flag as FlagGlyph } from "@phosphor-icons/react";
import { Flag } from "lucide-react";
import { useEffect, useState } from "react";
import { SettingsEmpty, SettingsGroup, SettingsRow } from "@/components/settings/kit";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fetchMyReports } from "@/lib/api";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { reportReasonKey } from "@/lib/report-reasons";

const STATUS: Record<ReportStatus, { key: MessageKey; variant: BadgeVariant }> = {
  open: { key: "report.mine.status.open", variant: "warning" },
  actioned: { key: "report.mine.status.actioned", variant: "success" },
  dismissed: { key: "report.mine.status.dismissed", variant: "neutral" },
};

const SUBJECT: Record<ReportSummary["subjectType"], MessageKey> = {
  message: "report.mine.subject.message",
  user: "report.mine.subject.user",
  server: "report.mine.subject.server",
  story: "report.mine.subject.story",
};

type Load =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; reports: ReportSummary[]; hasMore: boolean; more: boolean };

/**
 * The reports a person filed and where each one stands (the text channels
 * canvas, "Como tá cada uma"), read from `GET /api/reports/mine`. Only the
 * status the server keeps today: never who looked at it, never a note from
 * the staff. Under the redesign only.
 */
export function MyReportsGroup() {
  const { t, locale } = useTranslation();
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    fetchMyReports()
      .then((page) => {
        if (live) {
          setLoad({ kind: "ready", reports: page.reports, hasMore: page.hasMore, more: false });
        }
      })
      .catch(() => {
        if (live) {
          setLoad({ kind: "failed" });
        }
      });
    return () => {
      live = false;
    };
  }, []);

  function loadMore() {
    if (load.kind !== "ready" || load.more) {
      return;
    }
    const before = load.reports.at(-1)?.id;
    setLoad({ ...load, more: true });
    fetchMyReports({ before })
      .then((page) =>
        setLoad((current) =>
          current.kind === "ready"
            ? { kind: "ready", reports: [...current.reports, ...page.reports], hasMore: page.hasMore, more: false }
            : current,
        ),
      )
      .catch(() =>
        setLoad((current) => (current.kind === "ready" ? { ...current, more: false } : current)),
      );
  }

  const date = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" });

  return (
    <SettingsGroup
      id="my-reports"
      title={t("report.mine.title")}
      description={t("report.mine.hint")}
    >
      {load.kind === "loading" ? (
        <p className="px-4 py-3 text-sm text-text-tertiary">{t("report.mine.loading")}</p>
      ) : load.kind === "failed" ? (
        <p role="alert" className="px-4 py-3 text-sm text-danger">
          {t("report.mine.failed")}
        </p>
      ) : load.reports.length === 0 ? (
        <SettingsEmpty icon={Flag} glyph={FlagGlyph} title={t("report.mine.empty")} />
      ) : (
        <>
          {load.reports.map((report) => {
            const status = STATUS[report.status];
            return (
              <SettingsRow
                key={report.id}
                id={`my-report-${report.id}`}
                searchable={false}
                keepInline
                label={t(SUBJECT[report.subjectType], {
                  name: report.reportedUserName ?? t("report.mine.someone"),
                })}
                description={`${date.format(new Date(report.createdAt))} · ${t(reportReasonKey(report.reason))}`}
                control={
                  <Badge variant={status.variant} data-my-report-status={report.status}>
                    {t(status.key)}
                  </Badge>
                }
              />
            );
          })}
          {load.hasMore && (
            <div className="px-4 py-3">
              <Button size="sm" variant="ghost" disabled={load.more} onClick={loadMore}>
                {t("report.mine.more")}
              </Button>
            </div>
          )}
        </>
      )}
    </SettingsGroup>
  );
}
