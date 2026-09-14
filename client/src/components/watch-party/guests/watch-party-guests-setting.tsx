import {
  WATCH_PARTY_GUESTS_MODES,
  WATCH_PARTY_MAX_GUESTS,
  type WatchPartyGuestsMode,
} from "@pqp/shared";
import { useId } from "react";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * CONVIDADOS: the setting that replaced "Voz" (`docs/plans/
 * WATCH_PARTY_GUESTS.md` §2). First in the options list, above slow mode —
 * the owner's own placement, because every other control in the party
 * follows from this one being off.
 *
 * A NEW COMPONENT, MOUNTED WITH ONE LINE, deliberately: `watch-party-panel.tsx`
 * and `watch-party-transmission.tsx` are frozen ahead of PR 538's rewrite,
 * but `watch-party-options.tsx` (this component's host) is not one of those
 * two files, so the retired "Voz" select is removed from it directly rather
 * than left to fight this control for the same row.
 *
 * THREE RADIOS, STACKED, never a select: a draft has nobody to disturb by
 * showing all three at once (§2.4), and the live "Opções" dialog reuses the
 * exact same control rather than collapsing it — a host deciding whether
 * strangers can join their room is not a decision to bury in a dropdown.
 */
export function WatchPartyGuestsSetting({
  guests,
  disabled = false,
  onChange,
}: {
  guests: WatchPartyGuestsMode;
  disabled?: boolean;
  onChange: (mode: WatchPartyGuestsMode) => void;
}) {
  const { t } = useTranslation();
  const groupName = useId();

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5" data-watch-party-guests-setting>
      <div className="flex flex-col">
        <span className="text-sm text-text">{t("watchParty.guests.title")}</span>
        <span className="mt-0.5 text-xs text-text-tertiary">
          {t("watchParty.guests.body")}
        </span>
      </div>
      <div
        role="radiogroup"
        aria-label={t("watchParty.guests.title")}
        className="mt-1 flex flex-col gap-1"
      >
        {WATCH_PARTY_GUESTS_MODES.map((mode) => (
          <label
            key={mode}
            className={cn(
              "flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5",
              "hover:bg-surface-2",
              disabled && "cursor-not-allowed opacity-50",
            )}
            data-watch-party-guests-option={mode}
          >
            <input
              type="radio"
              name={groupName}
              className="mt-1 h-3.5 w-3.5 shrink-0 accent-accent"
              checked={guests === mode}
              disabled={disabled}
              onChange={() => onChange(mode)}
            />
            <span className="flex flex-col">
              <span className="text-sm text-text">{t(GUESTS_MODE_KEYS[mode])}</span>
              <span className="text-xs text-text-tertiary">
                {t(GUESTS_SUMMARY_KEYS[mode], { count: WATCH_PARTY_MAX_GUESTS })}
              </span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

const GUESTS_MODE_KEYS: Record<WatchPartyGuestsMode, MessageKey> = {
  off: "watchParty.guests.off",
  invite: "watchParty.guests.invite",
  request: "watchParty.guests.request",
};

const GUESTS_SUMMARY_KEYS: Record<WatchPartyGuestsMode, MessageKey> = {
  off: "watchParty.guests.offSummary",
  invite: "watchParty.guests.inviteSummary",
  request: "watchParty.guests.requestSummary",
};
