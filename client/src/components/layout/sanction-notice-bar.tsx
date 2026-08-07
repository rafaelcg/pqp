import { Clock } from "lucide-react";
import type { SanctionNotice } from "@pqp/shared";
import { useTranslation } from "@/lib/i18n";

/**
 * One line above the composer explaining why a message did not send.
 *
 * A timed-out member's send is refused by the server, which answers with a
 * `sanction-notice`. Before this existed the client dropped that frame, so the
 * only evidence was a message that failed — the person had to open the members
 * panel and work out from a moderator badge that they had been silenced. That
 * is the failure this is here to close, and closing it needs exactly one
 * sentence, which the server has already written.
 *
 * DELIBERATELY NOT A TOAST SYSTEM. The notice is about the composer directly
 * below it, so it belongs against that composer rather than floating in a
 * corner shared with unrelated events. It is dismissible because a person who
 * has read it should be able to put it away; the next refused send brings it
 * back, which is the right amount of insistence.
 *
 * `notice.message` is rendered verbatim. `describeTimeout` in
 * `packages/shared/src/sanctions.ts` is the single author of that sentence, on
 * the HTTP 403 body and here, so a client that re-words it is a client that has
 * started a second, drifting explanation of the same state.
 */
export function SanctionNoticeBar({
  notice,
  onDismiss,
}: {
  notice: SanctionNotice;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div
      role="status"
      className="flex shrink-0 items-start gap-2 border-t border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
    >
      <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1 break-words">{notice.message}</p>
      <button
        type="button"
        className="shrink-0 underline underline-offset-2"
        onClick={onDismiss}
      >
        {t("connection.dismiss")}
      </button>
    </div>
  );
}
