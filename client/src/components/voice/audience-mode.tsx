import { useEffect, useState } from "react";
import { Megaphone, MicOff, TriangleAlert } from "lucide-react";
import type {
  SpeakReason,
  VoiceAudienceChange,
  VoiceAudienceEnforcement,
  VoiceAudienceState,
  VoiceParticipant,
} from "@pqp/shared";
import { Tooltip } from "@/components/ui/tooltip";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * AUDIENCE MODE ("Modo plateia") in the call, `docs/plans/AUDIENCE_MODE.md`.
 *
 * Two pieces, both drawn by `CallControls` so they exist on the slim bar
 * (most calls have no picture and never expand) as well as on the stage:
 *
 * - `AudienceModeToggle`: the host's one control. A toggle, no confirm, its
 *   pressed state is the visible ON.
 * - `AudienceModeStrip`: the persistent line everybody in the call reads while
 *   it is on (why the mic is locked, or who may talk), the host's list of the
 *   people they let talk with a one-tap "Silenciar" each, a warning when the
 *   media server has not confirmed somebody silenced, and the short notice of
 *   what just changed.
 *
 * Letting somebody talk lives on the raised-hand queue (`RaisedHandQueue`),
 * where the people asking already are.
 */

/** What a host may do, and what is in flight. Absent for everybody else. */
export interface AudienceModeHostControls {
  /** May turn it ON here (the operator's flag for this server). Off is always offered. */
  available: boolean;
  busy: boolean;
  onToggle: () => void;
  onAllow: (userId: string) => void;
  onSilence: (userId: string) => void;
  /** What the media server did with the host's last change, from the HTTP answer. */
  enforcement: VoiceAudienceEnforcement | null;
}

/** How long the "what just changed" line stays up. */
export const AUDIENCE_NOTICE_MS = 6_000;

export function AudienceModeToggle({
  on,
  busy,
  onToggle,
  size,
  iconSize,
}: {
  on: boolean;
  busy: boolean;
  onToggle: () => void;
  size: string;
  iconSize: string;
}) {
  const { t } = useTranslation();
  return (
    <Tooltip
      label={t("voice.audience.toggle")}
      detail={on ? t("voice.audience.toggleOffHint") : t("voice.audience.toggleOnHint")}
    >
      <button
        type="button"
        aria-pressed={on}
        aria-label={t("voice.audience.toggle")}
        aria-busy={busy || undefined}
        data-audience-toggle={on ? "on" : "off"}
        disabled={busy}
        className={cn(
          "relative flex items-center justify-center rounded-full disabled:cursor-wait",
          size,
          on ? "bg-accent/20 text-accent ring-1 ring-accent/60" : "bg-surface-2 text-text hover:bg-border",
        )}
        onClick={onToggle}
      >
        <Megaphone className={iconSize} />
      </button>
    </Tooltip>
  );
}

function nameOf(participants: VoiceParticipant[], userId: string | null | undefined, fallback: string) {
  if (!userId) {
    return fallback;
  }
  return participants.find((person) => person.userId === userId)?.displayName ?? fallback;
}

/** The sentence for a change, or null when it says nothing worth a line. */
export function audienceChangeLine(
  change: VoiceAudienceChange,
  participants: VoiceParticipant[],
  selfUserId: string | null,
  t: ReturnType<typeof useTranslation>["t"],
): string | null {
  const someone = t("voice.audience.someone");
  const by = nameOf(participants, change.byUserId, someone);
  switch (change.kind) {
    case "on":
      return t("voice.audience.notice.on", { name: by });
    case "off":
      if (change.reason === "no-host") {
        return t("voice.audience.notice.offNoHost");
      }
      if (change.reason === "flag-off" || !change.byUserId) {
        return t("voice.audience.notice.offAuto");
      }
      return t("voice.audience.notice.off", { name: by });
    case "speaker-added":
      return change.userId === selfUserId
        ? t("voice.audience.notice.speakerAddedSelf")
        : t("voice.audience.notice.speakerAdded", {
            name: nameOf(participants, change.userId, someone),
          });
    case "speaker-removed":
      return change.userId === selfUserId
        ? t("voice.audience.notice.speakerRemovedSelf")
        : t("voice.audience.notice.speakerRemoved", {
            name: nameOf(participants, change.userId, someone),
          });
    default:
      return null;
  }
}

export function AudienceModeStrip({
  audience,
  change,
  speakReason,
  participants,
  selfUserId,
  host,
  compact = false,
  now: nowOverride,
  className,
}: {
  audience: VoiceAudienceState | null;
  change: (VoiceAudienceChange & { at: number }) | null;
  speakReason: SpeakReason | null;
  /** The room as the roster describes it, for names. */
  participants: VoiceParticipant[];
  selfUserId: string | null;
  /** Present only for somebody who runs the stage. */
  host?: AudienceModeHostControls | null;
  compact?: boolean;
  /** Test seam for the notice's age. */
  now?: number;
  className?: string;
}) {
  const { t } = useTranslation();
  const [tick, setTick] = useState(0);
  const now = nowOverride ?? Date.now();
  const noticeAge = change ? now - change.at : Infinity;
  const showNotice = change !== null && noticeAge < AUDIENCE_NOTICE_MS;
  useEffect(() => {
    if (!change || nowOverride !== undefined) {
      return;
    }
    const remaining = AUDIENCE_NOTICE_MS - (Date.now() - change.at);
    if (remaining <= 0) {
      return;
    }
    const timer = window.setTimeout(() => setTick((value) => value + 1), remaining + 50);
    return () => window.clearTimeout(timer);
  }, [change, nowOverride, tick]);

  const notice =
    showNotice && change ? audienceChangeLine(change, participants, selfUserId, t) : null;
  if (!audience && !notice) {
    return null;
  }

  const locked = speakReason === "audience";
  const someone = t("voice.audience.someone");
  const speakers = audience?.speakerUserIds ?? [];
  const pending = (
    audience?.unenforcedUserIds?.length
      ? audience.unenforcedUserIds
      : (host?.enforcement?.pendingUserIds ?? [])
  ).filter((userId) => userId !== selfUserId);
  const unreachable = Boolean(audience && host?.enforcement?.unreachable);

  return (
    <div
      data-audience-strip={audience ? "on" : "notice"}
      className={cn(
        "pointer-events-auto flex flex-col gap-1 text-xs",
        compact
          ? "w-full"
          : "w-full max-w-md rounded-lg bg-surface-1/90 px-2.5 py-2 shadow-lg ring-1 ring-border/60 backdrop-blur",
        className,
      )}
    >
      {audience && (
        <p
          data-audience-line={locked ? "locked" : "open"}
          className="flex min-w-0 items-center gap-1.5"
        >
          <span className="inline-flex shrink-0 items-center gap-1 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
            <Megaphone className="h-3 w-3" aria-hidden="true" />
            {t("voice.audience.badge")}
          </span>
          <span className={cn("min-w-0 truncate", locked ? "text-text" : "text-text-tertiary")}>
            {locked ? t("voice.audience.lockedDetail") : t("voice.audience.hostLine")}
          </span>
        </p>
      )}
      {audience && host && speakers.length > 0 && (
        <div data-audience-speakers="" className="flex flex-wrap items-center gap-1.5">
          <span className="text-text-tertiary">{t("voice.audience.speakers")}</span>
          {speakers.map((userId) => {
            const name = nameOf(participants, userId, someone);
            return (
              <span
                key={userId}
                data-audience-speaker={userId}
                className="inline-flex items-center gap-1 rounded-full bg-surface-2 py-0.5 pl-2 pr-0.5 text-text"
              >
                <span className="max-w-[8rem] truncate">{name}</span>
                <button
                  type="button"
                  data-audience-silence={userId}
                  aria-label={t("voice.audience.silenceFor", { name })}
                  disabled={host.busy}
                  className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] text-text-tertiary hover:bg-border hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-wait"
                  onClick={() => host.onSilence(userId)}
                >
                  <MicOff className="h-3 w-3" aria-hidden="true" />
                  {t("voice.audience.silence")}
                </button>
              </span>
            );
          })}
        </div>
      )}
      {audience && host && (pending.length > 0 || unreachable) && (
        <p
          role="alert"
          data-audience-unenforced={pending.join(",")}
          className="flex items-start gap-1.5 text-warning"
        >
          <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            {pending.length > 0
              ? t("voice.audience.unenforced", {
                  names: pending.map((userId) => nameOf(participants, userId, someone)).join(", "),
                })
              : t("voice.audience.unreachable")}
          </span>
        </p>
      )}
      {notice && (
        <p
          role="status"
          aria-live="polite"
          data-audience-notice={change?.kind}
          className="text-text-tertiary"
        >
          {notice}
        </p>
      )}
    </div>
  );
}

/** The "Liberar o microfone" button on a raised hand. */
export function AudienceAllowButton({
  name,
  userId,
  busy,
  onAllow,
  short = false,
}: {
  name: string;
  userId: string;
  busy: boolean;
  onAllow: (userId: string) => void;
  short?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      data-audience-allow={userId}
      aria-label={t("voice.audience.allowFor", { name })}
      disabled={busy}
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-on-accent hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-wait disabled:opacity-60"
      onClick={() => onAllow(userId)}
    >
      {short ? t("voice.audience.allowShort") : t("voice.audience.allow")}
    </button>
  );
}
