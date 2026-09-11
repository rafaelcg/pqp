import {
  SLOWMODE_SECONDS_PRESETS,
  WATCH_PARTY_STAGE_MODES,
  type WatchPartyOptions,
  type WatchPartyStageMode,
} from "@pqp/shared";
import { useId, type ReactNode } from "react";
import { Switch } from "@/components/ui/switch";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

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

export function slowModeKey(seconds: number): MessageKey {
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

/**
 * A settings row: the name and its one-line reason on the left, the control
 * on the right, in a grouped list. The shape every settings screen on a phone
 * or in Discord uses, and the one this dialog did not: it was a stack of
 * form fields with helper text under each, which reads as a form to fill in
 * rather than switches to flip.
 */
export function OptionRow({
  label,
  description,
  tone = "muted",
  htmlFor,
  children,
  className,
  ...rest
}: {
  label: string;
  description?: string;
  tone?: "muted" | "warning";
  htmlFor?: string;
  children?: ReactNode;
  className?: string;
} & Record<`data-${string}`, string | number | boolean | undefined>) {
  const Label = htmlFor ? "label" : "span";
  return (
    <div
      className={cn("flex items-center justify-between gap-4 px-3 py-2.5", className)}
      {...rest}
    >
      <Label htmlFor={htmlFor} className="min-w-0">
        <span className="block text-sm text-text">{label}</span>
        {description && (
          <span
            className={cn(
              "mt-0.5 block text-xs",
              tone === "warning" ? "text-warning" : "text-text-tertiary",
            )}
          >
            {description}
          </span>
        )}
      </Label>
      {children && <span className="shrink-0">{children}</span>}
    </div>
  );
}

/** The grouped list a settings screen is made of. */
export function OptionGroup({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      {title && (
        <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
          {title}
        </p>
      )}
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-0">
        {children}
      </div>
    </section>
  );
}

const selectClass =
  "h-[var(--control-sm)] max-w-[11rem] rounded-[var(--radius-control)] border border-border bg-surface-2 pl-2.5 pr-7 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50";

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
  const voiceId = useId();
  const slowId = useId();

  const voiceNote = !options.voiceEnabled
    ? t("watchParty.options.voiceOffBody")
    : options.stageMode === "everyone" && busy
      ? t("watchParty.options.stageWarnEveryone")
      : undefined;

  return (
    <div className="flex flex-col gap-4" data-watch-party-options>
      <OptionGroup>
        {/* VOICE IS OFF UNTIL A HOST SAYS OTHERWISE, and this is the control
            that says it. First because it is the decision the rest depend
            on: with voice off there is no floor, no queue and no microphone,
            and the server writes no permission rule on the channel at all
            (`watchPartyFloorIsClosed`). See docs/WATCH_PARTY.md. */}
        <OptionRow
          label={t("watchParty.options.voice")}
          description={voiceNote}
          tone={options.voiceEnabled && busy ? "warning" : "muted"}
          htmlFor={voiceId}
        >
          <select
            id={voiceId}
            className={selectClass}
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
        </OptionRow>

        {/* Only for the invitation mode, and only with voice on at all.
            Meaningless when everyone may already speak, pointless when only
            the hosts ever will, and nonsense when nobody speaks. */}
        {options.voiceEnabled && options.stageMode === "invited" && (
          <div data-watch-party-raise-hand className="px-1 py-0.5">
            <Switch
              label={t("watchParty.options.raiseHand")}
              checked={options.raiseHand}
              disabled={disabled}
              onCheckedChange={(checked) => onChange({ raiseHand: checked })}
            />
          </div>
        )}

        <OptionRow
          label={t("watchParty.options.slowMode")}
          description={
            busy && options.slowModeSeconds === 0
              ? t("watchParty.options.slowModeBusy")
              : undefined
          }
          htmlFor={slowId}
        >
          <select
            id={slowId}
            className={selectClass}
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
        </OptionRow>

        <div data-watch-party-reactions className="px-1 py-0.5">
          <Switch
            label={t("watchParty.options.reactions")}
            checked={options.reactionsEnabled}
            disabled={disabled}
            onCheckedChange={(checked) => onChange({ reactionsEnabled: checked })}
          />
        </div>

        {/* A fact, not a lever: who can watch follows the channel. One quiet
            row at the end of the group, with the answer under the name. */}
        <OptionRow
          label={t("watchParty.options.whoCanWatch")}
          description={t("watchParty.options.whoCanWatchBody")}
        />
      </OptionGroup>
    </div>
  );
}
