import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, TriangleAlert } from "lucide-react";
import type { LiveHlsStream, VoiceRoomTransport } from "@pqp/shared";
import { OutboundVideoReadout } from "@/components/voice/outbound-video-readout";
import { endToEndDelaySeconds } from "@/lib/hls-live-edge";
import { useShareUplinkStrain } from "@/hooks/use-share-uplink-strain";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import type { VideoQuality } from "@/lib/video-quality";
import {
  WATCH_PARTY_STREAM_QUALITIES,
  readWatchPartyStreamQuality,
  writeWatchPartyStreamQuality,
  type WatchPartyStreamQuality,
} from "@/lib/watch-party-stream-quality";
import {
  DISPLAY_GAIN_RANGE,
  formatGainDb,
  MIC_GAIN_RANGE,
  readStreamMixLevels,
  resetStreamMixLevels,
  writeStreamMixLevels,
} from "@/lib/stream-mix-levels";
import { cn } from "@/lib/utils";

/**
 * What the host is actually transmitting, and what the room is actually
 * getting. For the host only.
 *
 * ASSEMBLED, NOT INVENTED. Every number here already existed somewhere and was
 * unreachable from the one surface that wants them all at once:
 *
 *  - what leaves this machine is `OutboundVideoReadout`, which polls
 *    `getStats()` and already knows how to tell a ceiling the ROOM imposed
 *    from one the LINK imposed (`expectedCeilingBps`);
 *  - what the room receives is `LiveHlsStream.topHeight`, the tallest rung the
 *    ladder actually started for this session (PR 376), and `delaySeconds`;
 *  - whether the uplink is losing is `useShareUplinkStrain` (mesh splits
 *    the room; LiveKit is one upload and reads `describeLimitation` on
 *    the SFU sender row);
 *  - the audience and the clock are the party's own.
 *
 * Nothing is recomputed here. A second opinion about a bitrate is a second
 * number to disagree with the first one.
 *
 * COLLAPSED BY DEFAULT, AND THE ONE LINE IS WHAT THE ROOM GETS. A host glances
 * at this to answer one question, "is what I am sending arriving", and the
 * honest single fact is the rung the audience is being served plus how many
 * people that is. The detail is one press away for when the answer is no.
 *
 * NEVER SHOWN TO VIEWERS. It is rendered only inside the host's own controls;
 * a viewer has no use for the presenter's encoder and no business knowing it.
 *
 * The strain line now speaks on LiveKit too. The SFU session registers its
 * own sender rows, and those carry the published plan as the ceiling, so
 * "bandwidth" there is the host's uplink, not a leftover mesh reading.
 */
export function WatchPartyTransmission({
  stream,
  wentLiveAt,
  audienceCount,
  isPresenting,
  quality,
  roomViewers,
  micInStream = false,
  transport,
  now,
  className,
  onMicGainChange,
  onDisplayGainChange,
  micLevelDb,
}: {
  /** The channel's live stream, or null while nothing is being transcoded. */
  stream: LiveHlsStream | null;
  wentLiveAt: string | null;
  audienceCount: number;
  /** This person's screen is the one on the stage. */
  isPresenting: boolean;
  quality: VideoQuality;
  /** People in the room, for the outbound readout's room-vs-link reasoning. */
  roomViewers: number;
  /** The share's audio track carries the host's microphone (`screen-mix`). */
  micInStream?: boolean;
  transport: VoiceRoomTransport | null;
  /** Injected so the minutes tick on the caller's clock and a test can fix it. */
  now: Date;
  className?: string;
  /**
   * Apply a mic-gain choice to the RUNNING mix at once (`ScreenMix.setMicGain`,
   * a `GainNode.gain.value` write — no republish). Omitted, the control still
   * persists the choice for the next mix. See `StreamMixControl` below.
   */
  onMicGainChange?: (value: number) => void;
  /** Same as `onMicGainChange`, for the display (tab-audio) branch. */
  onDisplayGainChange?: (value: number) => void;
  /**
   * The mic branch's live level in the running mix, in dBFS, for the
   * mixer's meter. Polled at 10 Hz while `StreamMixControl` is mounted (this
   * panel is open) — see `ScreenMix.micLevelDb` / `use-voice.ts`.
   */
  micLevelDb?: () => number | null;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const strained = useShareUplinkStrain(
    isPresenting,
    quality,
    roomViewers,
    transport,
  );

  const height = stream?.topHeight ?? null;
  /**
   * THE ONE THING THE HOST CANNOT CHECK FOR THEMSELVES, and the reason this
   * component grew past a readout.
   *
   * The transcode carries the shared window and that window's OWN audio, and
   * nothing else: no microphone, no camera, from anybody. A host who shared a
   * whole screen or a window, or a tab without ticking its audio box, is
   * broadcasting a silent film while hearing it perfectly out of their own
   * speakers and talking to a seated room that hears them perfectly over
   * WebRTC. Nothing in either of those two experiences contains the fact.
   *
   * `unknown` is "the server did not say" (an older API, or a session adopted
   * across a deploy) and draws no warning: a false alarm during a film that is
   * playing fine is worse than no alarm.
   */
  const audioState = streamAudioState(stream);
  const silent = audioState === "none";
  const minutes = wentLiveAt
    ? Math.max(
        0,
        Math.floor((now.getTime() - Date.parse(wentLiveAt)) / 60_000),
      )
    : 0;

  const summary = !stream
    ? isPresenting
      ? t("watchParty.tx.collapsedPreparing")
      : t("watchParty.tx.collapsedIdle")
    : height === null
      ? t("watchParty.tx.collapsedPreparing")
      : audienceCount > 0
        ? t("watchParty.tx.collapsedRung", {
            height,
            count: audienceCount,
          })
        : t("watchParty.tx.collapsedRungZero", { height });

  return (
    <div
      data-testid="watch-party-transmission"
      data-tx-open={open ? "" : undefined}
      className={cn(
        "shrink-0 border-b border-ink-4/60 bg-ink-2/60 px-3 py-1.5",
        className,
      )}
    >
      <button
        type="button"
        data-testid="watch-party-tx-toggle"
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left text-[11px] text-paper-muted hover:text-paper"
        onClick={() => setOpen((was) => !was)}
        title={open ? t("watchParty.tx.collapse") : t("watchParty.tx.expand")}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />
        )}
        <span className="shrink-0 font-semibold uppercase tracking-wider">
          {t("watchParty.tx.title")}
        </span>
        <span data-testid="watch-party-tx-summary" className="truncate">
          {summary}
        </span>
        {/* IN THE COLLAPSED ROW, because the panel is collapsed by default and
            a warning only a host who expanded it can see is a warning nobody
            gets. It is the one line worth stealing the summary's space for. */}
        {silent && (
          <span
            data-testid="watch-party-tx-silent-pill"
            className="ml-auto flex shrink-0 items-center gap-1 text-warning"
          >
            <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden />
            <span className="hidden sm:inline">
              {t("watchParty.tx.silentPill")}
            </span>
          </span>
        )}
        {strained && !silent && (
          <TriangleAlert
            className="ml-auto h-3 w-3 shrink-0 text-warning"
            aria-hidden
          />
        )}
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-2">
          {/* STAT TILES, NOT A DEFINITION LIST. The rows read as a form's
              output, and "this server does not report it" three times over
              is a paragraph nobody should have to read. Each tile is a
              label and one value; a value the server did not give is a
              quiet n/d, not a sentence. Twitch's Stream Health and YouTube's
              stream stats are this shape. */}
          <dl className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
            <TxTile label={t("watchParty.tx.sending")}>
              {/* The component that already knows how to say this, including
                  which of the room and the link is holding it back.
                  `call.quality.unmeasured` rather than the Settings default:
                  a host reading this is mid-share. */}
              <OutboundVideoReadout
                idleKey="call.quality.unmeasured"
                quality={quality}
                viewers={roomViewers}
              />
            </TxTile>
            <TxTile
              label={t("watchParty.tx.receiving")}
              muted={height === null}
            >
              {height === null
                ? t("watchParty.tx.na")
                : t("watchParty.tx.receivingRung", {
                    height,
                    // Pipeline delay the server reports PLUS the player's own
                    // ~20 s cushion: the wire value alone under-reported how
                    // far behind the audience actually sits.
                    seconds: endToEndDelaySeconds(stream?.delaySeconds),
                  })}
            </TxTile>
            {/* The audio the AUDIENCE gets, which is a different question from
                the audio the room gets and has a different answer. */}
            <TxTile
              label={t("watchParty.tx.audio")}
              muted={audioState === "unknown"}
              tone={silent ? "warning" : undefined}
              testId="watch-party-tx-audio"
            >
              {audioState === "unknown"
                ? t("watchParty.tx.na")
                : audioState === "none"
                  ? t("watchParty.tx.audioNone")
                  : micInStream
                    ? t("watchParty.tx.audioScreenAndMic")
                    : t("watchParty.tx.audioScreen")}
            </TxTile>
            <TxTile label={t("watchParty.tx.audience")}>{audienceCount}</TxTile>
            <TxTile label={t("watchParty.tx.uptime")}>
              {t("watchParty.tx.uptimeValue", { minutes })}
            </TxTile>
          </dl>
          {strained && (
            <p
              data-testid="watch-party-tx-strained"
              className="flex items-start gap-1.5 text-[11px] text-warning"
            >
              <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              {t("watchParty.tx.strained")}
            </p>
          )}
          {silent && (
            <p
              data-testid="watch-party-tx-silent"
              className="flex items-start gap-1.5 text-[11px] text-warning"
            >
              <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              {t("watchParty.tx.silentFix")}
            </p>
          )}
          {/* THE HOST'S ONE ENCODER LEVER, and why it is here rather than on
              the crowded live bar: it belongs beside the numbers it changes.
              720p by default because a 1080p share over a lossy path corrupts
              for everyone (the egress always takes the top published layer);
              1080p is the opt-in for a host who knows their uplink is fat.
              Reads and writes its own `localStorage`, applied at the next
              share start — the running egress binds its source at the start
              and cannot be re-pointed in place. See
              `lib/watch-party-stream-quality.ts`. */}
          <StreamQualityControl />
          {/* THE STREAM'S OWN MIXER, next to the picture's other numbers.
              Unlike the quality picker above, both sliders change the
              RUNNING mix: the gain nodes they write are already in the
              graph, so there is nothing to rebind and no republish. See
              `screen-mix.ts` for why unity gain under-served a processed
              mic next to a film at near-full scale, and
              `stream-mix-levels.ts` for the ranges. */}
          <StreamMixControl
            onMicGainChange={onMicGainChange}
            onDisplayGainChange={onDisplayGainChange}
            micLevelDb={micLevelDb}
          />
          {/* One footnote, stated whether or not anything is wrong: the two
              audiences are on two different paths and the seated one is
              strictly richer. A host who never learns that assumes the
              stream carries whatever they can hear. */}
          <p
            data-testid="watch-party-tx-carries"
            className="text-[11px] text-text-tertiary"
          >
            {micInStream
              ? t("watchParty.tx.carriesWithMic")
              : t("watchParty.tx.carries")}{" "}
            {t("watchParty.tx.behind", {
              seconds: endToEndDelaySeconds(stream?.delaySeconds),
            })}
          </p>
        </div>
      )}
    </div>
  );
}

const STREAM_QUALITY_KEYS: Record<WatchPartyStreamQuality, MessageKey> = {
  "720p": "watchParty.tx.streamQuality720",
  "1080p": "watchParty.tx.streamQuality1080",
};

/**
 * The host's "Qualidade da transmissão" selector.
 *
 * SELF-CONTAINED on purpose. The choice is a per-browser preference that
 * `use-voice.ts` reads straight from `localStorage` the moment a share starts,
 * so this control needs no prop threaded from the call hook through the panel:
 * it reads and writes the same key. That also means a change lands on the NEXT
 * share, not the running one — the HLS egress binds its source when the
 * session begins and cannot be re-pointed at a different layer in place. The
 * hint says so.
 *
 * Rendered for the host only (the whole panel is), whether or not they are
 * presenting this instant, so the choice can be made before going live.
 */
export function StreamQualityControl() {
  const { t } = useTranslation();
  const selectId = useId();
  const [quality, setQuality] = useState<WatchPartyStreamQuality>(() =>
    readWatchPartyStreamQuality(),
  );
  return (
    <div
      data-testid="watch-party-tx-stream-quality"
      className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-0 px-2.5 py-1.5"
    >
      <label
        htmlFor={selectId}
        className="min-w-0 flex flex-col text-[11px] text-paper-muted"
      >
        <span className="font-semibold uppercase tracking-wider text-text-tertiary">
          {t("watchParty.tx.streamQuality")}
        </span>
        <span className="text-text-tertiary">
          {t("watchParty.tx.streamQualityHint")}
        </span>
      </label>
      <select
        id={selectId}
        data-testid="watch-party-tx-stream-quality-select"
        className="h-[var(--control-sm)] shrink-0 rounded-[var(--radius-control)] border border-border bg-surface-2 pl-2.5 pr-7 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring"
        value={quality}
        onChange={(event) => {
          const next = event.target.value as WatchPartyStreamQuality;
          setQuality(next);
          writeWatchPartyStreamQuality(next);
        }}
      >
        {WATCH_PARTY_STREAM_QUALITIES.map((value) => (
          <option key={value} value={value}>
            {t(STREAM_QUALITY_KEYS[value])}
          </option>
        ))}
      </select>
    </div>
  );
}

/** How often the meter reads `micLevelDb` while the mixer is mounted. */
const MIC_LEVEL_POLL_MS = 100;
/** The meter's floor (silence) and the level above which it turns amber. */
const MIC_LEVEL_FLOOR_DBFS = -60;
const MIC_LEVEL_WARN_DBFS = -12;

/**
 * "Mixer do stream": the host's microphone and the display's own audio,
 * relative to each other, in the mixed audio track the egress carries.
 * `screen-mix.ts` sums the two into a limiter, and a processed mic sits well
 * below a film playing in a tab at near-full scale — these are the two
 * levers back, plus the one number a host has no other way to see: how loud
 * their own mic is actually landing in that mix.
 *
 * BOTH SLIDERS ARE LIVE, unlike `StreamQualityControl` beside them. The gain
 * nodes they write are already in the running mix's graph
 * (`ScreenMix.setMicGain` / `setDisplayGain`), so a change takes effect on
 * the CURRENT share, mid-sentence, with nothing to rebind and no republish.
 * `onMicGainChange` / `onDisplayGainChange` are how the panel reaches the
 * running `ScreenMix` — see `use-voice.ts`'s `setStreamMicGain` /
 * `setStreamDisplayGain`, which are also where each choice is persisted
 * (`stream-mix-levels.ts`) so it survives the next share.
 *
 * THE METER reads `micLevelDb` at 10 Hz for as long as this control is
 * mounted, which is exactly as long as the host has the panel open — no
 * separate open/close plumbing needed, the interval's own cleanup handles
 * it. Green below -12 dBFS; amber at or above it, which is where the mix's
 * own compressor (threshold -6 dB, see `screen-mix.ts`) starts working.
 */
export function StreamMixControl({
  onMicGainChange,
  onDisplayGainChange,
  micLevelDb,
}: {
  onMicGainChange?: (value: number) => void;
  onDisplayGainChange?: (value: number) => void;
  micLevelDb?: () => number | null;
}) {
  const { t } = useTranslation();
  const micId = useId();
  const displayId = useId();
  const [micGain, setMicGain] = useState(
    () => readStreamMixLevels().micGain,
  );
  const [displayGain, setDisplayGain] = useState(
    () => readStreamMixLevels().displayGain,
  );
  const [levelDb, setLevelDb] = useState<number | null>(null);

  useEffect(() => {
    if (!micLevelDb) {
      return;
    }
    const interval = setInterval(() => {
      setLevelDb(micLevelDb());
    }, MIC_LEVEL_POLL_MS);
    return () => clearInterval(interval);
  }, [micLevelDb]);

  return (
    <div
      data-testid="watch-party-tx-mixer"
      className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface-0 px-2.5 py-2"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
          {t("watchParty.tx.mixer")}
        </span>
        <button
          type="button"
          data-testid="watch-party-tx-mixer-reset"
          className="text-[11px] text-signal hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring"
          onClick={() => {
            const defaults = resetStreamMixLevels();
            setMicGain(defaults.micGain);
            setDisplayGain(defaults.displayGain);
            onMicGainChange?.(defaults.micGain);
            onDisplayGainChange?.(defaults.displayGain);
          }}
        >
          {t("watchParty.tx.mixerReset")}
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2 text-[11px] text-paper-muted">
          <label htmlFor={micId}>{t("watchParty.tx.micGain")}</label>
          <span data-testid="watch-party-tx-mic-gain-db">
            {formatGainDb(micGain)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            id={micId}
            type="range"
            data-testid="watch-party-tx-mic-gain-slider"
            min={MIC_GAIN_RANGE.min}
            max={MIC_GAIN_RANGE.max}
            step={0.1}
            value={micGain}
            className="h-1.5 flex-1 cursor-pointer accent-[var(--color-signal)]"
            onChange={(event) => {
              const next = Number(event.target.value);
              setMicGain(next);
              writeStreamMixLevels({ micGain: next });
              onMicGainChange?.(next);
            }}
          />
          <MicLevelMeterBar db={levelDb} />
        </div>
        <span className="text-[11px] text-text-tertiary">
          {t("watchParty.tx.micGainHint")}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2 text-[11px] text-paper-muted">
          <label htmlFor={displayId}>{t("watchParty.tx.displayGain")}</label>
          <span data-testid="watch-party-tx-display-gain-db">
            {formatGainDb(displayGain)}
          </span>
        </div>
        <input
          id={displayId}
          type="range"
          data-testid="watch-party-tx-display-gain-slider"
          min={DISPLAY_GAIN_RANGE.min}
          max={DISPLAY_GAIN_RANGE.max}
          step={0.05}
          value={displayGain}
          className="h-1.5 w-full cursor-pointer accent-[var(--color-signal)]"
          onChange={(event) => {
            const next = Number(event.target.value);
            setDisplayGain(next);
            writeStreamMixLevels({ displayGain: next });
            onDisplayGainChange?.(next);
          }}
        />
      </div>
    </div>
  );
}

/**
 * The mic's live level next to its slider. Green below -12 dBFS (comfortable
 * headroom under the mix's own compressor, which sits at -6 dB); amber at or
 * above, so a host sees they are pushing the limiter before the audience
 * hears it clip. `null` (nothing mixed yet) draws an empty bar, not a
 * warning.
 */
function MicLevelMeterBar({ db }: { db: number | null }) {
  const pct =
    db === null || !Number.isFinite(db)
      ? 0
      : Math.min(
          100,
          Math.max(0, ((db - MIC_LEVEL_FLOOR_DBFS) / -MIC_LEVEL_FLOOR_DBFS) * 100),
        );
  const loud = db !== null && db >= MIC_LEVEL_WARN_DBFS;
  return (
    <div
      data-testid="watch-party-tx-mic-level"
      className="h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-surface-2"
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width]",
          loud ? "bg-warning" : "bg-success",
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/**
 * What the SEATLESS audience is hearing, which is a different question from
 * what the room is hearing and often has a different answer.
 *
 * `"screen"`  the share went up with its own audio and the egress is carrying
 *             it. A film shared as a Chrome tab with the audio box ticked.
 * `"none"`    there is no audio track in the transcode at all. Every
 *             whole-screen and window capture (macOS Chrome cannot capture
 *             system audio), and any tab share where the box was left
 *             unticked. The audience is watching a silent film.
 * `"unknown"` the server did not say: an API older than `hasAudio`, or a
 *             session this process adopted across a restart rather than
 *             started, where the row carries the video track sid and not the
 *             audio one. Draws no warning on purpose.
 *
 * A function rather than an inline ternary because it is the whole of what
 * this panel exists to say, and the unit suite runs in `node` through
 * `react-dom/server`: the detail rows are behind a click nothing here can
 * make, so without this the only testable half would be the collapsed line.
 */
export function streamAudioState(
  stream: LiveHlsStream | null,
): "screen" | "none" | "unknown" {
  if (!stream || stream.hasAudio === undefined) {
    return "unknown";
  }
  return stream.hasAudio ? "screen" : "none";
}

/** One stat: a small label over one value. */
function TxTile({
  label,
  children,
  muted = false,
  tone,
  testId,
}: {
  label: string;
  children: ReactNode;
  /** The server did not give this one; draw it quiet, not as a warning. */
  muted?: boolean;
  tone?: "warning";
  testId?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface-0 px-2.5 py-1.5">
      <dt className="truncate text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
        {label}
      </dt>
      <dd
        data-testid={testId}
        className={cn(
          "mt-0.5 truncate text-xs",
          tone === "warning"
            ? "text-warning"
            : muted
              ? "text-text-tertiary"
              : "text-text",
        )}
      >
        {children}
      </dd>
    </div>
  );
}
