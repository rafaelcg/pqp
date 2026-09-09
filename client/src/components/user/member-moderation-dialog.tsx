import { useEffect, useState } from "react";
import { TIMEOUT_PRESET_MINUTES, TIMEOUT_REASON_MAX_LENGTH } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { ProfileModerationAction } from "@/components/user/profile-relations";
import { ApiError } from "@/lib/api";
import {
  applyMemberModeration,
  describeTimeoutMinutes,
  moderationActionLabel,
  DEFAULT_TIMEOUT_MINUTES,
} from "@/lib/member-moderation";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The ladder, as a dialog, for surfaces that cannot expand in place.
 *
 * The profile card composes a timeout inline, deliberately: a moderator is
 * looking at the message that prompted it and a modal would take the evidence
 * away. A row in the member list has no such evidence and no room to grow, so
 * the same three questions (how long, why, are you sure) are asked here.
 *
 * The ACTIONS themselves are not reimplemented: `applyMemberModeration` is the
 * one place that knows which endpoint a rung goes to and what it carries.
 * `endTimeout` never reaches this component; lifting a sentence takes nothing
 * away, so its caller runs it directly.
 */
export interface ModerationSubject {
  id: string;
  displayName: string;
}

interface MemberModerationDialogProps {
  /** Null closes it. `endTimeout` is not a dialog and must not be passed. */
  action: Exclude<ProfileModerationAction, "endTimeout"> | null;
  subject: ModerationSubject | null;
  serverId: string;
  /** Ran, and the shell should re-read what it holds. */
  onDone: (notice: string | null) => void;
  onClose: () => void;
}

export function MemberModerationDialog({
  action,
  subject,
  serverId,
  onDone,
  onClose,
}: MemberModerationDialogProps) {
  const { t } = useTranslation();
  const [minutes, setMinutes] = useState<number>(DEFAULT_TIMEOUT_MINUTES);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh dialog every time: a reason typed for the last person must never
  // ride along to the next one.
  useEffect(() => {
    if (action) {
      setMinutes(DEFAULT_TIMEOUT_MINUTES);
      setReason("");
      setError(null);
      setBusy(false);
    }
  }, [action, subject?.id]);

  if (!action || !subject) {
    return null;
  }

  const name = subject.displayName;
  const title =
    action === "timeout"
      ? t("profile.mod.timeout.title", { name })
      : action === "kick"
        ? t("profile.mod.kick.title", { name })
        : t("profile.mod.ban.title", { name });
  const body =
    action === "timeout"
      ? t("profile.mod.timeout.body")
      : action === "kick"
        ? t("profile.mod.kick.body")
        : t("profile.mod.ban.body");
  const confirmLabel =
    action === "timeout"
      ? t("profile.mod.timeout.apply")
      : moderationActionLabel(action, t);
  const wantsReason = action === "timeout" || action === "ban";

  function run() {
    setBusy(true);
    setError(null);
    void applyMemberModeration({
      action: action!,
      serverId,
      userId: subject!.id,
      minutes,
      reason,
    })
      .then((notice) => {
        setBusy(false);
        onDone(notice);
        onClose();
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(
          err instanceof ApiError || err instanceof Error
            ? err.message
            : t("member.moderationFailed"),
        );
      });
  }

  return (
    <Dialog
      open
      title={title}
      size="sm"
      closeOnBackdrop={false}
      onClose={onClose}
      footer={
        <div className="grid w-full min-w-0 grid-cols-2 gap-2">
          <Button
            type="button"
            variant="ghost"
            className="h-auto min-h-9 w-full min-w-0 whitespace-normal px-2 text-center"
            disabled={busy}
            onClick={onClose}
          >
            {t("profile.mod.cancel")}
          </Button>
          <Button
            type="button"
            variant="danger"
            className="h-auto min-h-9 w-full min-w-0 whitespace-normal px-2 text-center"
            disabled={busy}
            data-member-timeout-apply={action === "timeout" ? "" : undefined}
            data-member-mod-apply={action}
            onClick={run}
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <div
        className="px-5 py-4"
        data-member-timeout-composer={action === "timeout" ? "" : undefined}
        data-member-mod-confirm={action}
      >
        {action === "timeout" && (
          <div
            role="radiogroup"
            aria-label={t("profile.mod.timeout.duration")}
            className="grid grid-cols-2 gap-1.5"
          >
            {TIMEOUT_PRESET_MINUTES.map((preset) => (
              <button
                key={preset}
                type="button"
                role="radio"
                aria-checked={minutes === preset}
                data-timeout-minutes={preset}
                className={cn(
                  "rounded-md px-2 py-1.5 text-sm",
                  minutes === preset
                    ? "bg-signal font-semibold text-ink"
                    : "bg-ink-3 text-paper hover:bg-ink-4",
                )}
                onClick={() => setMinutes(preset)}
              >
                {describeTimeoutMinutes(preset, t)}
              </button>
            ))}
          </div>
        )}
        {wantsReason && (
          <input
            type="text"
            value={reason}
            maxLength={TIMEOUT_REASON_MAX_LENGTH}
            placeholder={t("profile.mod.reason.placeholder")}
            aria-label={t("profile.mod.reason")}
            className="mt-3 w-full rounded-md border border-ink-4 bg-ink px-2 py-2 text-base text-paper placeholder:text-paper-muted"
            onChange={(event) => setReason(event.target.value)}
          />
        )}
        <p className="mt-3 text-xs text-paper-muted">{body}</p>
        {error && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
