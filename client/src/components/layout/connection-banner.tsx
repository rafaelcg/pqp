import { WifiOff } from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import type { RealtimeStatus } from "@/lib/realtime";

/**
 * The strip under the header while the live connection is down.
 *
 * It used to say "reconnecting…" and nothing else, forever, including when
 * the server was refusing the session and no amount of reconnecting would
 * help. Now it carries the two ways out: try now, and run the check that
 * says what is actually wrong. A refused session (twice in a row) swaps the
 * wording and offers to sign in again, since that is the only fix.
 */
export function ConnectionBanner({
  status,
  refusedRepeatedly,
  onRetry,
  onCheck,
  onSignInAgain,
}: {
  status: RealtimeStatus;
  refusedRepeatedly: boolean;
  onRetry: () => void;
  onCheck: () => void;
  onSignInAgain: () => void;
}) {
  const { t } = useTranslation();
  if (status !== "reconnecting" && status !== "unauthorized") {
    return null;
  }
  const refused = status === "unauthorized" && refusedRepeatedly;
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-warning/30 bg-warning/10 px-4 py-1.5 text-xs text-warning"
      role="status"
      data-connection-banner={status}
    >
      <span className="inline-flex items-center gap-2">
        <WifiOff className="h-3.5 w-3.5" aria-hidden />
        {refused
          ? t("connection.doctor.advice.signInAgain")
          : status === "unauthorized"
            ? t("connection.unauthorized")
            : t("connection.reconnecting")}
      </span>
      <span className="inline-flex items-center gap-1.5">
        {refused ? (
          <button
            type="button"
            className="rounded-md bg-warning/20 px-2 py-0.5 font-semibold hover:bg-warning/30"
            onClick={onSignInAgain}
            data-connection-sign-in
          >
            {t("connection.signInAgain")}
          </button>
        ) : (
          <button
            type="button"
            className="rounded-md bg-warning/20 px-2 py-0.5 font-semibold hover:bg-warning/30"
            onClick={onRetry}
            data-connection-retry
          >
            {t("connection.retryNow")}
          </button>
        )}
        <button
          type="button"
          className="rounded-md px-2 py-0.5 font-semibold underline-offset-2 hover:underline"
          onClick={onCheck}
          data-connection-check
        >
          {t("connection.check")}
        </button>
      </span>
    </div>
  );
}
