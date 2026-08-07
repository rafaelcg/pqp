import {
  REPORT_DETAILS_MAX_LENGTH,
  REPORT_REASONS,
  REPORT_REASON_LABELS,
  type CreateReportRequest,
  type ReportReason,
} from "@pqp/shared";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ApiError, createReport } from "@/lib/api";

/**
 * What is being reported, in the two shapes the API accepts.
 *
 * `subjectName` is display-only — it never travels to the server, which reads
 * the author and the context from the reported thing itself.
 */
export type ReportTarget =
  | { kind: "message"; messageId: string; subjectName: string | null }
  | {
      kind: "user";
      userId: string;
      subjectName: string | null;
      /** The server this is being reported from, when there is one. */
      serverId?: string | null;
    };

interface ReportDialogProps {
  target: ReportTarget | null;
  onClose: () => void;
}

/**
 * Every user-facing string in this file is a plain sentence held at the top
 * level of its element rather than assembled inside a branch, so the day this
 * app grows a string catalogue they can be lifted out without untangling
 * logic. `client/src/lib/locale.ts` exists but carries no app strings yet.
 */
const TITLES: Record<ReportTarget["kind"], string> = {
  message: "Report message",
  user: "Report user",
};

const DESCRIPTIONS: Record<ReportTarget["kind"], string> = {
  message:
    "Moderators will see a copy of this message, who sent it, and anything you add below.",
  user: "Moderators will see who you reported and anything you add below. No messages are attached.",
};

export function ReportDialog({ target, onClose }: ReportDialogProps) {
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
        : `user:${target.userId}`;

  useEffect(() => {
    setReason(null);
    setDetails("");
    setError(null);
    setDone(false);
    setSubmitting(false);
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
          : {
              subjectType: "user",
              userId: target.userId,
              serverId: target.serverId ?? null,
              reason,
              details: details.trim() || null,
            };
      await createReport(body);
      // A duplicate answers 200 rather than an error, so re-reporting the same
      // thing lands here too and is told the same thing. That is deliberate:
      // "we already have this" and "thank you" are the same fact to a reporter.
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not send this report. Try again in a moment.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <Dialog
        open
        title="Report sent"
        eyebrow="Safety"
        onClose={onClose}
        size="sm"
        footer={
          <Button onClick={onClose}>
            Done
          </Button>
        }
      >
        <div className="space-y-3 px-5 py-4 text-sm text-paper-muted">
          <p>
            Thanks — moderators have been notified. You will not be told who
            reviews it.
          </p>
          <p>
            If this person is bothering you directly, blocking them stops them
            reaching you while the report is looked at.
          </p>
        </div>
      </Dialog>
    );
  }

  const subject = target.subjectName ?? "this account";

  return (
    <Dialog
      open
      title={TITLES[target.kind]}
      eyebrow="Safety"
      description={DESCRIPTIONS[target.kind]}
      onClose={onClose}
      size="sm"
      // A half-written report should not vanish on a stray click outside it.
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!reason || submitting} onClick={() => void submit()}>
            {submitting ? "Sending…" : "Send report"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 px-5 py-4">
        <p className="text-sm text-paper">
          Reporting <span className="font-semibold">{subject}</span>.
        </p>

        <fieldset className="space-y-1.5">
          <legend className="mb-2 font-display text-sm font-bold uppercase tracking-wider text-paper-muted">
            What is wrong?
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
              {REPORT_REASON_LABELS[value]}
            </label>
          ))}
        </fieldset>

        <label className="block text-sm text-paper">
          Anything else moderators should know? (optional)
          <textarea
            value={details}
            maxLength={REPORT_DETAILS_MAX_LENGTH}
            rows={3}
            disabled={submitting}
            onChange={(e) => setDetails(e.target.value)}
            className="mt-2 w-full resize-none rounded-md border border-ink-4 bg-ink px-3 py-2 text-sm text-paper placeholder:text-paper-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/50 disabled:opacity-50"
            placeholder="Context, links, or what happened before this."
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
