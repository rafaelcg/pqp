import { Phone, PhoneOff, X } from "lucide-react";
import type { IncomingCall } from "@/hooks/use-voice";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation } from "@/lib/i18n";

/**
 * The ringing surface: one card per conversation currently calling this
 * account, stacked over whatever the user is doing.
 *
 * Mounted at the app root rather than in any conversation view because a call
 * arrives wherever you are — a server channel, another conversation, the
 * settings dialog. Three answers, mirroring a phone:
 *
 * - Accept joins the call (there is no separate accept frame — joining IS the
 *   answer, and the server stops ringing our other devices).
 * - Decline tells the caller no and stops our other devices.
 * - Dismiss (the ×) is silence: no frame leaves this device, the caller keeps
 *   ringing until timeout, and the call stays joinable from the conversation.
 */
export function IncomingCallOverlay({
  calls,
  onAccept,
  onDecline,
  onDismiss,
}: {
  calls: IncomingCall[];
  onAccept: (conversationId: string) => void;
  onDecline: (conversationId: string) => void;
  onDismiss: (conversationId: string) => void;
}) {
  const { t } = useTranslation();
  if (calls.length === 0) {
    return null;
  }
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[max(0.5rem,env(safe-area-inset-top))] z-50 flex flex-col items-center gap-2 px-2 sm:inset-x-auto sm:right-4 sm:top-[max(1rem,env(safe-area-inset-top))] sm:items-end">
      {calls.map((call) => (
        <div
          key={call.conversationId}
          role="dialog"
          aria-label={`${call.caller.displayName}: ${
            call.kind === "group"
              ? t("call.incoming.groupTitle")
              : t("call.incoming.title")
          }`}
          className="pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-lg border border-ink-4/60 bg-ink-2 p-3 shadow-lg"
        >
          <UserAvatar
            name={call.caller.displayName}
            avatarUrl={call.caller.avatarUrl}
            rounded="full"
            className="h-10 w-10"
            fallbackClassName="bg-ink-4 text-sm text-paper"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-paper">
              {call.caller.displayName}
            </p>
            <p className="animate-pulse truncate text-xs text-paper-muted">
              {call.kind === "group"
                ? t("call.incoming.groupTitle")
                : t("call.incoming.title")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              title={t("call.incoming.accept")}
              aria-label={t("call.incoming.accept")}
              className="rounded-full bg-success/90 p-2 text-ink hover:bg-success"
              onClick={() => onAccept(call.conversationId)}
            >
              <Phone className="h-4 w-4" />
            </button>
            <button
              type="button"
              title={t("call.incoming.decline")}
              aria-label={t("call.incoming.decline")}
              className="rounded-full bg-danger/90 p-2 text-paper hover:bg-danger"
              onClick={() => onDecline(call.conversationId)}
            >
              <PhoneOff className="h-4 w-4" />
            </button>
            <button
              type="button"
              title={t("call.incoming.ignore")}
              aria-label={t("call.incoming.ignore")}
              className="rounded-md p-1.5 text-paper-muted hover:bg-ink-3 hover:text-paper"
              onClick={() => onDismiss(call.conversationId)}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
