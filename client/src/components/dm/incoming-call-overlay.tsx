import { Phone, PhoneOff, X } from "lucide-react";
import { useEffect } from "react";
import type { IncomingCall } from "@/hooks/use-voice";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation } from "@/lib/i18n";
import { startSoundLoop, stopSoundLoop } from "@/lib/sounds";
import {
  Phone as PhoneFill,
  PhoneDisconnect,
  X as XBold,
} from "@phosphor-icons/react";
import { IconSwap } from "@/components/ui/icon";
import { CALL_CONTROL_REDESIGN } from "@/components/voice/call-control-classes";
import { cn } from "@/lib/utils";

/** Under the redesign: answer and decline are the call bar's 44px circles. */
const ANSWER = cn(
  CALL_CONTROL_REDESIGN.base,
  "redesign:flex redesign:h-11 redesign:w-11 redesign:items-center redesign:justify-center redesign:p-0 redesign:text-on-danger",
);

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
  useEffect(() => {
    if (calls.length > 0) {
      startSoundLoop("incomingCall");
    } else {
      stopSoundLoop("incomingCall");
    }
    return () => stopSoundLoop("incomingCall");
  }, [calls.length]);
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
          className="pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-[var(--radius-card)] border border-border/60 bg-surface-1 p-3 shadow-[var(--shadow-2)] redesign:rounded-[var(--popover-radius)] redesign:border-[color:var(--popover-border)] redesign:bg-[color:var(--popover-surface)] redesign:py-3 redesign:pl-3 redesign:pr-2 redesign:shadow-[var(--popover-shadow)]"
        >
          <UserAvatar
            name={call.caller.displayName}
            avatarUrl={call.caller.avatarUrl}
            rounded="full"
            className="h-10 w-10 redesign:h-11 redesign:w-11 redesign:ring-2 redesign:ring-[color:var(--call-speaking)] redesign:ring-offset-2 redesign:ring-offset-[color:var(--popover-surface)] redesign:motion-safe:animate-pulse"
            fallbackClassName="bg-border text-sm text-text"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-text">
              {call.caller.displayName}
            </p>
            <p className="animate-pulse truncate text-xs text-text-tertiary redesign:animate-none redesign:text-text-secondary">
              {call.kind === "group"
                ? t("call.incoming.groupTitle")
                : t("call.incoming.title")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 redesign:gap-2">
            <button
              type="button"
              title={t("call.incoming.accept")}
              aria-label={t("call.incoming.accept")}
              className={cn("rounded-full bg-success/90 p-2 text-surface-0 hover:bg-success", ANSWER, "redesign:bg-success redesign:text-surface-0 redesign:hover:bg-[color:color-mix(in_oklab,var(--color-success)_85%,var(--color-text))]")}
              onClick={() => onAccept(call.conversationId)}
            >
              <IconSwap off={Phone} on={PhoneFill} offClassName="h-4 w-4" className="h-5 w-5" />
            </button>
            <button
              type="button"
              title={t("call.incoming.decline")}
              aria-label={t("call.incoming.decline")}
              className={cn("rounded-full bg-danger/90 p-2 text-text hover:bg-danger", ANSWER, CALL_CONTROL_REDESIGN.leave)}
              onClick={() => onDecline(call.conversationId)}
            >
              <IconSwap off={PhoneOff} on={PhoneDisconnect} offClassName="h-4 w-4" className="h-5 w-5" />
            </button>
            <button
              type="button"
              title={t("call.incoming.ignore")}
              aria-label={t("call.incoming.ignore")}
              className="rounded-md p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-text redesign:flex redesign:h-8 redesign:w-8 redesign:items-center redesign:justify-center redesign:rounded-full redesign:p-0 redesign:hover:bg-[color:var(--menu-row-hover)] redesign:focus-visible:outline-none redesign:focus-visible:ring-2 redesign:focus-visible:ring-[color:var(--color-focus-ring)]"
              onClick={() => onDismiss(call.conversationId)}
            >
              <IconSwap off={X} on={XBold} kind="symbol" offClassName="h-4 w-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
