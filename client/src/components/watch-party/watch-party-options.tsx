import {
  SLOWMODE_SECONDS_PRESETS,
  WATCH_PARTY_STAGE_MODES,
  type WatchPartyOptions,
  type WatchPartyStageMode,
} from "@pqp/shared";
import { useTranslation, type MessageKey } from "@/lib/i18n";

/**
 * The host's controls, in the setup surface before going live and again as an
 * "Opções" panel while the party runs.
 *
 * ONE COMPONENT FOR BOTH, because the whole point is that the decisions are
 * the same ones and a host who changes their mind at minute forty gets the
 * panel they already learned at minute zero. `live` only changes the sentence
 * underneath, which promises that a change lands immediately for people
 * already watching.
 *
 * FOUR CONTROLS AND A SENTENCE, and the sentence is deliberate. Who may WATCH
 * is not a control here: it is the channel's own permissions, and layering a
 * second permission system over them would be two places to get a private
 * party wrong, both of which have to agree. The panel says so in words.
 *
 * QUALITY IS ABSENT ON PURPOSE. The HLS quality ladder is a separate branch
 * and owns what a host may pick; when it lands it adds one control here rather
 * than growing a parallel one. A dropdown that changes nothing would be worse
 * than its absence.
 *
 * NONE OF THIS IS ENFORCEMENT. Every option is applied by the server when the
 * party goes live and re-applied on every edit
 * (`services/watch-parties.ts`, `applyWatchPartyOptions`); a client that lies
 * about `stageMode` gets a room whose SPEAK bit says otherwise.
 */

const SLOWMODE_KEYS: Record<number, MessageKey> = {
  0: "channelMeta.slowMode.off",
  5: "channelMeta.slowMode.5s",
  10: "channelMeta.slowMode.10s",
  15: "channelMeta.slowMode.15s",
  30: "channelMeta.slowMode.30s",
  60: "channelMeta.slowMode.1m",
  120: "channelMeta.slowMode.2m",
  300: "channelMeta.slowMode.5m",
  600: "channelMeta.slowMode.10m",
  900: "channelMeta.slowMode.15m",
  3600: "channelMeta.slowMode.1h",
  21600: "channelMeta.slowMode.6h",
};

function slowModeKey(seconds: number): MessageKey {
  return SLOWMODE_KEYS[seconds] ?? "channelMeta.slowMode.custom";
}

const STAGE_KEYS: Record<WatchPartyStageMode, MessageKey> = {
  hosts_only: "watchParty.options.stage.hosts_only",
  invited: "watchParty.options.stage.invited",
  everyone: "watchParty.options.stage.everyone",
};

const fieldClass =
  "w-full rounded-md border border-ink-4 bg-ink-3 px-2 py-1.5 text-sm text-paper";

export function WatchPartyOptionsPanel({
  options,
  live,
  disabled = false,
  audienceCount,
  onChange,
}: {
  options: WatchPartyOptions;
  /** Changes land immediately for people already watching. */
  live: boolean;
  disabled?: boolean;
  /** Drives the "with a crowd, try 10 or 30 seconds" nudge. */
  audienceCount: number;
  onChange: (patch: Partial<WatchPartyOptions>) => void;
}) {
  const { t } = useTranslation();
  // "Big" is where an open floor and an unthrottled chat stop being fine. The
  // 2026-09-05 spike put 212 people in a room in twenty minutes, so the nudge
  // wants to appear well before that rather than at it.
  const busy = audienceCount >= 20;

  return (
    <div className="flex flex-col gap-3" data-watch-party-options>
      <label className="block text-xs text-paper-muted">
        <span className="mb-1 block">{t("watchParty.options.stageMode")}</span>
        <select
          className={fieldClass}
          value={options.stageMode}
          disabled={disabled}
          onChange={(event) =>
            onChange({ stageMode: event.target.value as WatchPartyStageMode })
          }
          data-watch-party-stage-mode
        >
          {WATCH_PARTY_STAGE_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {t(STAGE_KEYS[mode])}
            </option>
          ))}
        </select>
        {options.stageMode === "everyone" && busy && (
          <span className="mt-1 block text-[11px] text-warning">
            {t("watchParty.options.stageWarnEveryone")}
          </span>
        )}
      </label>

      {/* Only for the invitation mode. Meaningless when everyone may already
          speak, and pointless when only the hosts ever will. */}
      {options.stageMode === "invited" && (
        <label className="flex items-center gap-2 text-xs text-paper-muted">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-signal"
            checked={options.raiseHand}
            disabled={disabled}
            onChange={(event) => onChange({ raiseHand: event.target.checked })}
            data-watch-party-raise-hand
          />
          {t("watchParty.options.raiseHand")}
        </label>
      )}

      <label className="block text-xs text-paper-muted">
        <span className="mb-1 block">{t("watchParty.options.slowMode")}</span>
        <select
          className={fieldClass}
          value={String(options.slowModeSeconds)}
          disabled={disabled}
          onChange={(event) =>
            onChange({ slowModeSeconds: Number(event.target.value) })
          }
          data-watch-party-slow-mode
        >
          {SLOWMODE_SECONDS_PRESETS.map((seconds) => (
            <option key={seconds} value={seconds}>
              {t(slowModeKey(seconds), { seconds })}
            </option>
          ))}
        </select>
        {busy && options.slowModeSeconds === 0 && (
          <span className="mt-1 block text-[11px] text-paper-muted">
            {t("watchParty.options.slowModeBusy")}
          </span>
        )}
      </label>

      <label className="flex items-center gap-2 text-xs text-paper-muted">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 accent-signal"
          checked={options.reactionsEnabled}
          disabled={disabled}
          onChange={(event) =>
            onChange({ reactionsEnabled: event.target.checked })
          }
          data-watch-party-reactions
        />
        {t("watchParty.options.reactions")}
      </label>

      <div className="rounded-md bg-ink-3/60 px-2 py-1.5">
        <p className="text-[11px] font-semibold text-paper-muted">
          {t("watchParty.options.whoCanWatch")}
        </p>
        <p className="text-[11px] text-paper-muted">
          {t("watchParty.options.whoCanWatchBody")}
        </p>
      </div>

      {live && (
        <p className="text-[11px] text-paper-muted">
          {t("watchParty.options.liveNote")}
        </p>
      )}
    </div>
  );
}
