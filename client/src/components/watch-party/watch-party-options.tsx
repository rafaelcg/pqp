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
 * panel they already learned at minute zero. The promise that a change lands
 * immediately for people already watching is the dialog's own description
 * while the party runs, so this draws only controls.
 *
 * VOZ IS FIRST AND IS OFF BY DEFAULT. A watch party is a broadcast: the
 * audience is seatless, the transcode carries no microphone, and a room of
 * two hundred with open microphones is not a watch party. So the default is
 * no voice at all, and the whole of the stage machinery below hangs off this
 * one select. Turning it on is one click and the film night that wants it
 * pays exactly what it paid before.
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

/**
 * The "off" entry of the Voz select, which is not a stage mode and must not
 * collide with one. Kept as a constant so the mapping below reads as one
 * decision rather than a string comparison in three places.
 */
const VOICE_OFF = "off";

/**
 * The select's value, and the patch each value produces.
 *
 * ONE CONTROL FOR TWO FIELDS, and it is the shape the product wants rather
 * than the shape the data has. Two products share this feature: six friends
 * watching a film genuinely want to talk over it, and five hundred people
 * watching a presentation do not. Off is the default, so the broadcast costs
 * zero clicks; "Todo mundo" is one click, which is what the film night costs
 * today. Two separate switches would have made the film night cost two, and
 * would have left a stored `stageMode` sitting on a voice-off party looking
 * like a rule when it is a preference nobody has activated.
 */
function voiceValue(options: WatchPartyOptions): string {
  return options.voiceEnabled ? options.stageMode : VOICE_OFF;
}

function voicePatch(value: string): Partial<WatchPartyOptions> {
  if (value === VOICE_OFF) {
    // `stageMode` is left exactly as it was. A host who turns voice off and
    // on again gets back the floor they had chosen, and nothing is applied
    // while it is off: `watchPartyFloorIsClosed` is false either way.
    return { voiceEnabled: false };
  }
  return { voiceEnabled: true, stageMode: value as WatchPartyStageMode };
}

const fieldClass =
  "w-full rounded-md border border-ink-4 bg-ink-3 px-2 py-1.5 text-sm text-paper";

export function WatchPartyOptionsPanel({
  options,
  disabled = false,
  audienceCount,
  onChange,
}: {
  options: WatchPartyOptions;
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
      {/* VOICE IS OFF UNTIL A HOST SAYS OTHERWISE, and this is the control
          that says it. First in the panel because it is the decision the rest
          depend on: with voice off there is no floor, no queue and no
          microphone, and the server writes no permission rule on the channel
          at all (`watchPartyFloorIsClosed`). See docs/WATCH_PARTY.md. */}
      <label className="block text-xs text-paper-muted">
        <span className="mb-1 block">{t("watchParty.options.voice")}</span>
        <select
          className={fieldClass}
          value={voiceValue(options)}
          disabled={disabled}
          onChange={(event) => onChange(voicePatch(event.target.value))}
          data-watch-party-voice
        >
          <option value={VOICE_OFF}>{t("watchParty.options.voiceOff")}</option>
          {WATCH_PARTY_STAGE_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {t(STAGE_KEYS[mode])}
            </option>
          ))}
        </select>
        {!options.voiceEnabled && (
          <span className="mt-1 block text-[11px] text-paper-muted">
            {t("watchParty.options.voiceOffBody")}
          </span>
        )}
        {options.voiceEnabled && options.stageMode === "everyone" && busy && (
          <span className="mt-1 block text-[11px] text-warning">
            {t("watchParty.options.stageWarnEveryone")}
          </span>
        )}
      </label>

      {/* Only for the invitation mode, and only with voice on at all.
          Meaningless when everyone may already speak, pointless when only the
          hosts ever will, and nonsense when nobody speaks. */}
      {options.voiceEnabled && options.stageMode === "invited" && (
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

      {/* FREQUENCY IS NOT PROMINENCE. Everything above is a lever a host
          pulls mid-event; this is a fact they read once, ever, and it used to
          be a filled card with a heading, sitting between the controls and
          the co-host list at the same visual weight as the controls. It is a
          disclosure now: one quiet line, the answer one press away. */}
      <details className="text-[11px] text-paper-muted">
        <summary className="cursor-pointer select-none text-text-tertiary hover:text-text">
          {t("watchParty.options.whoCanWatch")}
        </summary>
        <p className="mt-1.5">{t("watchParty.options.whoCanWatchBody")}</p>
      </details>
    </div>
  );
}
