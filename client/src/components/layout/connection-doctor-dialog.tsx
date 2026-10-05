import { CircleCheck, CircleX, Copy, Loader2, Minus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { SETTINGS_BUSY } from "@/components/settings/kit";
import { Dialog } from "@/components/ui/dialog";
import {
  formatReport,
  runConnectionChecks,
  type CheckId,
  type CheckResult,
  type DoctorReport,
} from "@/lib/connection-doctor";
import { doctorLine } from "@/components/layout/connection-doctor-lines";
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
  // The checks that have answered so far, so each row leaves its spinner as
  // soon as its own check lands rather than all together at the end.
  const [landed, setLanded] = useState<CheckResult[]>([]);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [run, setRun] = useState(0);
  // Read when a run starts, not watched. A parent that hands in a new arrow on
  // every render used to restart the checks on each one, and a run is a few
  // seconds of probing the network, announced from the top every time.
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    setRunning(true);
    setReport(null);
    setLanded([]);
    setCopied(false);
    void runConnectionChecks({
      transport: transportRef.current,
      getToken: () => getTokenRef.current(),
      onResult: (result) => {
        if (!cancelled) {
          setLanded((list) => [...list, result]);
        }
      },
    }).then((result) => {
      if (!cancelled) {
        setReport(result);
        setRunning(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, run]);

  if (!open) {
    return null;
  }

  const rows: CheckId[] = ["api", "token", "socket", "stun", "turn"];
  const by = new Map((report?.results ?? landed).map((r) => [r.id, r] as const));
  const firstPending = rows.find((id) => !by.has(id));

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
          <Button
            // Busy but focusable: a disabled button drops the keyboard on the
            // page the moment it is pressed.
            aria-disabled={running || undefined}
            className={running ? SETTINGS_BUSY : undefined}
            onClick={() => {
              if (!running) {
                setRun((n) => n + 1);
              }
            }}
          >
            {running ? t("connection.doctor.running") : t("connection.doctor.run")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 px-5 py-4" data-connection-doctor>
        <ul className="divide-y divide-border overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface-card">
          {rows.map((id) => {
            const result = by.get(id);
            const Icon = !result
              ? Loader2
              : result.verdict === "ok"
                ? CircleCheck
                : result.verdict === "fail"
                  ? CircleX
                  : Minus;
            const line = doctorLine(id, result, id === firstPending);
            return (
              <li
                key={id}
                className="flex items-center gap-3 px-4 py-3 text-sm"
                data-doctor-check={id}
                data-verdict={result?.verdict ?? "pending"}
              >
                <Icon
                  aria-hidden="true"
                  className={cn(
                    "h-[18px] w-[18px] shrink-0",
                    !result && "text-text-tertiary motion-safe:animate-spin",
                    result?.verdict === "ok" && "text-success",
                    result?.verdict === "fail" && "text-danger",
                    result?.verdict === "skip" && "text-text-tertiary",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-text">{t(CHECK_LABEL[id])}</span>
                  <span className="mt-0.5 block text-xs text-text-tertiary">
                    {t(line.key, line.params)}
                  </span>
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
        <p className="text-xs text-text-tertiary">
          {t("settings.voice.doctor.footnote")}
        </p>
      </div>
    </Dialog>
  );
}
