import {
  REPORT_DETAILS_MAX_LENGTH,
  REPORT_REASONS,
  REPORT_REASON_LABELS,
  type CreateReportRequest,
  type Report,
  type ReportReason,
} from "@pqp/shared";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { useTranslation } from "@/lib/i18n";
import { ApiError, createReport } from "@/lib/api";
import { useRedesign } from "@/lib/redesign";
import { reportReasonKey } from "@/lib/report-reasons";

/**
 * What is being reported, in the two shapes the API accepts.
 *
 * `subjectName` is display-only — it never travels to the server, which reads
 * the author and the context from the reported thing itself.
 */
export type ReportTarget =
  | {
      kind: "message";
      messageId: string;
      subjectName: string | null;
      /** The author, so the sent screen can offer to block them. */
      authorId?: string | null;
    }
  | {
      kind: "user";
      userId: string;
      subjectName: string | null;
      /** The server this is being reported from, when there is one. */
      serverId?: string | null;
    }
  /**
   * A whole community, from the directory. The subject is the LISTING — its
   * name and its stated purpose — not anything anybody said inside it, which is
   * why nothing about a channel or a message travels with it.
   *
   * The server routes this to the INSTANCE queue and never to the community's
   * own owner (see `resolveServerSubject`), which is what the dialog's copy has
   * to convey: somebody reporting a community is usually reporting the person
   * who would otherwise be reading the report.
   */
  | { kind: "community"; serverId: string; subjectName: string | null };

interface ReportDialogProps {
  target: ReportTarget | null;
  onClose: () => void;
  /** Under the redesign the sent screen offers this, for the reported person. */
  onBlock?: (userId: string) => void;
  /** Whether that person is already blocked, so the offer is not made twice. */
  isBlocked?: (userId: string) => boolean;
  /** The server the report was filed from, for "Foi pra staff do …". */
  placeName?: string | null;
}

/**
 * Where a filed report went, from the row the server answered with. The
 * server decides routing; this only reads it back. A minor, a conversation, a
 * report with no place and a whole community all go to the pqp team.
 */
export function sentToPqp(report: Pick<Report, "reason" | "subjectType" | "contextKind">): boolean {
  return (
    report.reason === "minor_sexual" ||
    report.subjectType === "server" ||
    report.contextKind !== "server"
  );
}

export function ReportDialog({ target, onClose, onBlock, isBlocked, placeName }: ReportDialogProps) {
  const { t } = useTranslation();
  const redesign = useRedesign();
  const [filed, setFiled] = useState<Report | null>(null);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Reset per target, so a second report never opens holding the last one's
  // reason — which is the fastest way to file the wrong thing about somebody.
  const targetKey =
    target === null
      ? null
      : target.kind === "message"
        ? `message:${target.messageId}`
        : target.kind === "community"
          ? `community:${target.serverId}`
          : `user:${target.userId}`;

  useEffect(() => {
    setReason(null);
    setDetails("");
    setError(null);
    setDone(false);
    setSubmitting(false);
    setFiled(null);
    setConfirmBlock(false);
    setBlocked(false);
  }, [targetKey]);

  if (!target) {
    return null;
  }

  async function submit() {
    if (!target || !reason) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const body: CreateReportRequest =
        target.kind === "message"
          ? {
              subjectType: "message",
              messageId: target.messageId,
              reason,
              details: details.trim() || null,
            }
          : target.kind === "community"
            ? {
                subjectType: "server",
                serverId: target.serverId,
                reason,
                details: details.trim() || null,
              }
            : {
                subjectType: "user",
                userId: target.userId,
                serverId: target.serverId ?? null,
                reason,
                details: details.trim() || null,
              };
      const { report } = await createReport(body);
      setFiled(report);
      // A duplicate answers 200 rather than an error, so re-reporting the same
      // thing lands here too and is told the same thing. That is deliberate:
      // "we already have this" and "thank you" are the same fact to a reporter.
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : t("report.sendFailed"),
      );
    } finally {
      setSubmitting(false);
    }
  }

  const blockUserId =
    target.kind === "message" ? (target.authorId ?? null) : target.kind === "user" ? target.userId : null;

  if (done && redesign) {
    // The text channels canvas, "Enviada": where it went, that the other
    // person hears nothing, and what helps right now. Nothing here is lime.
    const name = target.subjectName;
    const place = target.kind === "community" ? null : (placeName ?? null);
    const toPqp = filed ? sentToPqp(filed) : target.kind === "community";
    const canBlock = Boolean(blockUserId && onBlock && !(isBlocked?.(blockUserId) ?? false));
    return (
      <>
        <Dialog
          open
          title={t("report.sent")}
          eyebrow={t("report.eyebrow")}
          onClose={onClose}
          size="sm"
          footer={
            <Button variant="secondary" onClick={onClose}>
              {t("common.close")}
            </Button>
          }
        >
          <div data-report-sent="" className="space-y-4 px-5 py-4 text-sm text-text-secondary">
            <p>
              {toPqp
                ? t("report.sentTo.pqp")
                : place
                  ? t("report.sentTo.server", { place })
                  : t("report.sentTo.serverUnnamed")}{" "}
              {target.kind === "community"
                ? null
                : name
                  ? t("report.sentQuiet", { name })
                  : t("report.sentQuietSomeone")}
            </p>
            {(canBlock || blocked) && blockUserId && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-text-tertiary">{t("report.meanwhile")}</p>
                {blocked ? (
                  <p role="status" className="text-text">
                    {t("report.blockedNamed", { name: name ?? t("report.thisAccount") })}
                  </p>
                ) : (
                  <Button variant="secondary" size="sm" onClick={() => setConfirmBlock(true)}>
                    {t("report.blockNamed", { name: name ?? t("report.thisAccount") })}
                  </Button>
                )}
              </div>
            )}
          </div>
        </Dialog>
        <ConfirmDialog
          open={confirmBlock}
          title={t("profile.block")}
          description={t("profile.block.confirm", { name: name ?? t("report.thisAccount") })}
          confirmLabel={t("profile.block")}
          destructive
          onConfirm={() => {
            if (blockUserId && onBlock) {
              onBlock(blockUserId);
              setBlocked(true);
            }
            setConfirmBlock(false);
          }}
          onClose={() => setConfirmBlock(false)}
        />
      </>
    );
  }

  if (done) {
    return (
      <Dialog
        open
        title={t("report.sent")}
        eyebrow={t("report.eyebrow")}
        onClose={onClose}
        size="sm"
        footer={
          <Button onClick={onClose}>
            {t("report.done")}
          </Button>
        }
      >
        <div className="space-y-3 px-5 py-4 text-sm text-paper-muted">
          <p>
            {t("report.thanks")}
          </p>
          <p>
            {t("report.blockHint")}
          </p>
        </div>
      </Dialog>
    );
  }

  const subject =
    target.subjectName ??
    (target.kind === "community"
      ? t("report.thisCommunity")
      : t("report.thisAccount"));

  return (
    <Dialog
      open
      title={
        target.kind === "community"
          ? t("communities.reportTitle")
          : t(
              target.kind === "message"
                ? "report.title.message"
                : "report.title.user",
            )
      }
      eyebrow={t("report.eyebrow")}
      description={
        target.kind === "community"
          ? t("communities.reportBody")
          : t(
              target.kind === "message"
                ? "report.body.message"
                : "report.body.user",
            )
      }
      onClose={onClose}
      size="sm"
      // A half-written report should not vanish on a stray click outside it.
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" disabled={submitting} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!reason || submitting} onClick={() => void submit()}>
            {submitting ? t("report.sending") : t("report.send")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 px-5 py-4">
        <p className="text-sm text-paper">
          {t("report.targeting", { name: subject })}
        </p>

        <fieldset className="space-y-1.5">
          <legend className="mb-2 font-display text-sm font-bold uppercase tracking-wider text-paper-muted">
            {t("report.reasonLegend")}
          </legend>
          {REPORT_REASONS.map((value) => (
            <label
              key={value}
              className="flex cursor-pointer items-center gap-2.5 rounded-md border border-ink-4 bg-ink-3/40 px-3 py-2 text-sm text-paper transition-colors hover:border-signal/50"
            >
              <input
                type="radio"
                name="report-reason"
                value={value}
                checked={reason === value}
                disabled={submitting}
                onChange={() => setReason(value)}
                className="h-4 w-4 accent-[var(--color-signal)]"
              />
              {redesign ? t(reportReasonKey(value)) : REPORT_REASON_LABELS[value]}
            </label>
          ))}
        </fieldset>

        <label className="block text-sm text-paper">
          {t("report.detailsLabel")}
          <textarea
            value={details}
            maxLength={REPORT_DETAILS_MAX_LENGTH}
            rows={3}
            disabled={submitting}
            onChange={(e) => setDetails(e.target.value)}
            className="mt-2 w-full resize-none rounded-md border border-ink-4 bg-ink px-3 py-2 text-sm text-paper placeholder:text-paper-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/50 disabled:opacity-50"
            placeholder={t("report.placeholder")}
          />
        </label>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
