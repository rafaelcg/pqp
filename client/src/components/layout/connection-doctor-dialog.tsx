import { Check, Copy, Loader2, Minus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  formatReport,
  runConnectionChecks,
  type CheckId,
  type DoctorReport,
} from "@/lib/connection-doctor";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import type { RealtimeTransport } from "@/lib/realtime";
import { cn } from "@/lib/utils";

const CHECK_LABEL: Record<CheckId, MessageKey> = {
  api: "connection.doctor.check.api",
  token: "connection.doctor.check.token",
  socket: "connection.doctor.check.socket",
  stun: "connection.doctor.check.stun",
  turn: "connection.doctor.check.turn",
};

const ADVICE_LABEL: Record<DoctorReport["advice"], MessageKey> = {
  none: "connection.doctor.advice.none",
  apiUnreachable: "connection.doctor.advice.apiUnreachable",
  tokenStuck: "connection.doctor.advice.tokenStuck",
  signInAgain: "connection.doctor.advice.signInAgain",
  socketBlocked: "connection.doctor.advice.socketBlocked",
  relayBlocked: "connection.doctor.advice.relayBlocked",
  noUdp: "connection.doctor.advice.noUdp",
};

/**
 * The connection check, as a dialog. Runs on open, shows each check as it
 * lands, ends with the one thing to do first and a copyable report for the
 * QG. See `lib/connection-doctor.ts` for what is checked and why.
 */
export function ConnectionDoctorDialog({
  open,
  onClose,
  transport,
  getToken,
  onSignInAgain,
  appVersion,
}: {
  open: boolean;
  onClose: () => void;
  transport: RealtimeTransport;
  getToken: () => Promise<string | null>;
  onSignInAgain: () => void;
  appVersion: string;
}) {
  const { t } = useTranslation();
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [run, setRun] = useState(0);

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    setRunning(true);
    setReport(null);
    setCopied(false);
    void runConnectionChecks({ transport, getToken }).then((result) => {
      if (!cancelled) {
        setReport(result);
        setRunning(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, run, transport, getToken]);

  if (!open) {
    return null;
  }

  const rows: CheckId[] = ["api", "token", "socket", "stun", "turn"];
  const by = new Map(report?.results.map((r) => [r.id, r] as const) ?? []);

  return (
    <Dialog
      open
      eyebrow={t("settings.section.voice")}
      title={t("connection.doctor.title")}
      description={t("connection.doctor.description")}
      size="sm"
      onClose={onClose}
      footer={
        <>
          {report?.advice === "signInAgain" && (
            <Button variant="secondary" onClick={onSignInAgain} data-doctor-sign-in>
              {t("connection.signInAgain")}
            </Button>
          )}
          <Button
            variant="ghost"
            disabled={!report}
            onClick={() => {
              if (!report) {
                return;
              }
              void navigator.clipboard
                ?.writeText(formatReport(report, appVersion))
                .then(() => setCopied(true))
                .catch(() => {});
            }}
          >
            <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {copied ? t("connection.doctor.copied") : t("connection.doctor.copy")}
          </Button>
          <Button disabled={running} onClick={() => setRun((n) => n + 1)}>
            {running ? t("connection.doctor.running") : t("connection.doctor.run")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 px-5 py-4" data-connection-doctor>
        <ul className="space-y-2">
          {rows.map((id) => {
            const result = by.get(id);
            const Icon = !result
              ? Loader2
              : result.verdict === "ok"
                ? Check
                : result.verdict === "fail"
                  ? X
                  : Minus;
            return (
              <li key={id} className="flex items-center gap-3 text-sm" data-doctor-check={id} data-verdict={result?.verdict ?? "pending"}>
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
                    !result && "border-ink-4 text-paper-muted",
                    result?.verdict === "ok" && "border-success/40 bg-success/15 text-success",
                    result?.verdict === "fail" && "border-danger/40 bg-danger/15 text-danger",
                    result?.verdict === "skip" && "border-ink-4 text-paper-muted",
                  )}
                >
                  <Icon className={cn("h-3.5 w-3.5", !result && "animate-spin")} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block">{t(CHECK_LABEL[id])}</span>
                  {result && (
                    <span className="block truncate font-mono text-[11px] text-paper-muted">
                      {result.detail}
                      {result.ms ? ` · ${result.ms} ms` : ""}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        {report && (
          <p
            className={cn(
              "rounded-lg border px-3 py-2 text-sm",
              report.advice === "none"
                ? "border-success/40 bg-success/10 text-paper"
                : "border-warning/40 bg-warning/10 text-paper",
            )}
            role="status"
            data-doctor-advice={report.advice}
          >
            {t(ADVICE_LABEL[report.advice])}
          </p>
        )}
      </div>
    </Dialog>
  );
}
