import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronRight, TriangleAlert } from "lucide-react";
import { Dialog, DialogBody } from "@/components/ui/dialog";
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
  INITIAL_OUTPUT_SILENCE_STATE,
  isOutputSilenceWarning,
  nextOutputSilenceState,
  type OutputSilenceState,
} from "@/lib/watch-party-output-silence";
import { presenterMicWarning } from "@/lib/watch-party-mic-warning";
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

/** How often the output meter is sampled for the sustained-silence warning. */
const OUTPUT_LEVEL_POLL_MS = 100;

/**
 * "Your broadcast has no sound", ten seconds after the mixed bus goes
 * digitally silent (postmortem B2). Runs for as long as this component is
 * mounted — which is as long as the host or a co-host is running the show —
 * NOT only while the panel is expanded, because a warning only visible
 * behind a click nobody has taken is a warning nobody gets (the same reason
 * the existing `silentPill` lives in the collapsed row).
 *
 * The timer itself is `nextOutputSilenceState` / `isOutputSilenceWarning`
 * (`watch-party-output-silence.ts`), pure and tested on their own; this is
 * only the polling loop around them, same shape as `useShareUplinkStrain`.
 */
function useOutputSilenceWarning(
  outputLevelDb: (() => number | null) | undefined,
  /**
   * The broadcast's own identity (`stream.startedAt`, or `null` while
   * nothing is live) — NOT the caller's, unlike `outputLevelDb` below.
   * Ten seconds of silence at the end of one show must not count toward
   * the next one just because this component never unmounted between
   * them (a host who ends a party and starts another without the panel
   * closing): the streak is about a broadcast, and a new broadcast starts
   * the count at zero, warning or not (Farol, 2026-09-13).
   */
  sessionKey: number | string | null,
): boolean {
  const [warning, setWarning] = useState(false);
  // A caller re-rendering (any unrelated app or voice-state update while a
  // party is live) can hand this a new function with the same behavior. The
  // streak lives in the effect below, so tracking `outputLevelDb` itself as
  // that effect's dependency would restart it — and reset a real silence
  // streak — on every such render. The ref reads the latest reading without
  // restarting anything; only whether a meter exists at all, or the session
  // underneath it changing, reopens the effect.
  const readerRef = useRef(outputLevelDb);
  readerRef.current = outputLevelDb;
  const hasReader = outputLevelDb !== undefined;

  // `useLayoutEffect`, not `useEffect`: an ordinary effect runs AFTER the
  // browser has already painted the render that triggered it, so clearing
  // `warning` there can still show one true frame of the OLD broadcast's
  // warning on top of the NEW session before the reset lands (Farol,
  // 2026-09-13, sharpening the earlier fix below). The layout effect runs
  // synchronously before paint, so the reset in the same commit that
  // changed `sessionKey` is what the audience ever sees — never a flash of
  // stale state in between.
  useLayoutEffect(() => {
    // Cleared on EVERY run of this effect (a new session included) rather
    // than only when there is no reader at all: the interval below has not
    // sampled anything yet on its first tick, up to `OUTPUT_LEVEL_POLL_MS`
    // away, and a stale `warning === true` from the broadcast this session
    // just replaced must not still be on screen for that gap.
    setWarning(false);
    if (!hasReader) {
      return;
    }
    let tracked: OutputSilenceState = INITIAL_OUTPUT_SILENCE_STATE;
    const interval = setInterval(() => {
      const now = Date.now();
      tracked = nextOutputSilenceState(
        tracked,
        readerRef.current?.() ?? null,
        now,
      );
      setWarning(isOutputSilenceWarning(tracked, now));
    }, OUTPUT_LEVEL_POLL_MS);
    return () => clearInterval(interval);
  }, [hasReader, sessionKey]);

  return warning;
}

export function WatchPartyTransmission({
  stream,
  wentLiveAt,
  audienceCount,
  isPresenting,
  recovering = false,
  quality,
  roomViewers,
  micInStream = false,
  transport,
  now,
  className,
  onMicGainChange,
  onDisplayGainChange,
  micLevelDb,
  outputLevelDb,
  micMuted = false,
  userId = null,
  onStreamQualityChange,
  onOpenMixer,
  detailsInDialog = false,
  trailing,
}: {
  /** The channel's live stream, or null while nothing is being transcoded. */
  stream: LiveHlsStream | null;
  wentLiveAt: string | null;
  audienceCount: number;
  /** This person's screen is the one on the stage. */
  isPresenting: boolean;
  /**
   * The presenter's own screen publish dropped and is being re-established.
   * Overrides the stream-derived health with a truthful "reconnecting" and
   * freezes the uptime, so the panel stops counting up over a dead broadcast
   * long before the server tears the (now sourceless) HLS stream down.
   */
  recovering?: boolean;
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
  /**
   * The MIXED BUS's live level, in dBFS, for the "your broadcast has no
   * sound" warning below (postmortem B2). A different question from
   * `micLevelDb`: this reads the whole mix post-limiter, the same point the
   * egress subscribes to, and is what caught -91 dB going out while the
   * panel still read "the window's + your mic". See `screen-mix.ts` and
   * `watch-party-output-silence.ts`.
   */
  outputLevelDb?: () => number | null;
  /**
   * The ROOM microphone (`micState === "muted"`), not `micInStream` above
   * (whether an OPEN mic is folded into the share's audio). Combined with
   * `isPresenting` via `presenterMicWarning` to fold "seu mic está mudo"
   * into the B2 silence warning when both are true at once: a persistent
   * banner already says this on its own in the party bar
   * (`watch-party-panel.tsx`), so this panel only needs to say it again
   * where the silence warning is already being read (postmortem, 2026-09-13).
   */
  micMuted?: boolean;
  /** For `StreamQualityControl`'s per-account preference (postmortem B7). */
  userId?: string | null;
  /**
   * THE MIXER LIVES IN ITS OWN DIALOG WHEN THIS IS GIVEN (2026-09-13). The
   * two sliders used to be inline here, inside a disclosure that defaults
   * closed and, opened, pushes the host's own preview below the fold. After
   * Moonkase's party asked for "volume controls for the streamer and the
   * film", the answer was already built and nobody had found it. So the
   * live bar gets an "Áudio" button (`watch-party-panel.tsx`) and this
   * section keeps a one-line readout with the same door. Omitted, the mixer
   * renders inline exactly as before, which is what the tests and any other
   * caller still get.
   */
  onOpenMixer?: () => void;
  /**
   * `StreamQualityControl` keeps its own `useState` and this panel is not
   * the only reader of the choice: the go-live checklist beside it also
   * shows a `quality` row (`watch-party-panel.tsx`'s `LiveSurface`), read
   * once from `localStorage` at mount. Without this callback a host who
   * switches to 1080p mid-show keeps seeing the checklist's stale 720p
   * "ok" row until something else remounts the panel (Farol, 2026-09-13).
   */
  onStreamQualityChange?: (quality: WatchPartyStreamQuality) => void;
  /**
   * THE HEADER IS FACTS (2026-09-13, `docs/plans/WATCH_PARTY_PRESENTER_UI.md`
   * §6.1). With this on, the collapsed row becomes the presenter's status
   * line, a health dot in front of it, and the details open in a `Dialog`
   * instead of unfolding in the column, so the picture never moves. Off,
   * the row unfolds inline exactly as it did, which is what the tests pin.
   */
  detailsInDialog?: boolean;
  /**
   * Drawn at the right end of the status row, outside the toggle (a button
   * cannot hold a button). The panel puts the mic warning and its Ativar
   * mic here, so the muted state is part of the same line as the health
   * dot instead of a red strip of its own (2026-09-13).
   */
  trailing?: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const strained = useShareUplinkStrain(
    isPresenting,
    quality,
    roomViewers,
    transport,
  );
  const outputSilentWarning = useOutputSilenceWarning(
    outputLevelDb,
    stream?.startedAt ?? null,
  );
  const micMutedWhilePresenting =
    presenterMicWarning(isPresenting, micMuted) === "warn";

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
  // Freeze the uptime while our publish is down: it is not accruing broadcast
  // time, and a timer ticking up over a dead stream is half of the incident's
  // lie. It resumes from the server's `wentLiveAt` once the picture is back.
  const minutes =
    wentLiveAt && !recovering
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

  /**
   * ONE COLOUR FOR THE WHOLE BROADCAST, the way Twitch's Stream Health and
   * YouTube's stream health panel do it: green until something is wrong,
   * and the something is the same three signals the collapsed row already
   * ranks (no audio track, ten seconds of silence, uplink strain). Grey is
   * "nothing is going out", which is not a fault.
   */
  const health: "idle" | "ok" | "warn" | "bad" = recovering
    ? "bad"
    : !stream
      ? "idle"
      : silent || outputSilentWarning
        ? "bad"
        : strained
          ? "warn"
          : "ok";
  const healthTitle = recovering
    ? t("watchParty.tx.healthReconnecting")
    : health === "idle"
      ? t("watchParty.tx.healthIdle")
      : health === "ok"
        ? t("watchParty.tx.healthOk")
        : health === "warn"
          ? t("watchParty.tx.healthWarn")
          : t("watchParty.tx.healthBad");
  const statusLine = recovering
    ? t("watchParty.tx.publishDropped")
    : detailsInDialog && stream && wentLiveAt
      ? `${summary} · ${t("watchParty.tx.uptimeValue", { minutes })}`
      : summary;

  const details = (
    <>
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
          {!silent && outputSilentWarning && (
            <p
              data-testid="watch-party-tx-output-silent"
              className="flex items-start gap-1.5 text-[11px] text-warning"
            >
              <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              {/* WHEN THE SILENCE AND A MUTED MIC COINCIDE, say the mic
                  fact too, in the same breath: a host reading "your
                  broadcast has no sound" who then finds their mic muted has
                  found the whole explanation, not half of it, and the
                  persistent bar banner (`watch-party-panel.tsx`) may not be
                  in view while this panel is open. */}
              {micMutedWhilePresenting
                ? `${t("watchParty.tx.outputSilentWarning")} ${t("watchParty.live.micMutedWarning")}`
                : t("watchParty.tx.outputSilentWarning")}
            </p>
          )}
          {/* THE FACE ON THE STREAM. Only drawn while the camera rung is
              actually running (`stream.cameraHlsUrl`): a host with no webcam
              on, or on a box that refused it for budget, or with
              `LIVE_HLS_CAMERA=false`, sees nothing here, the same as before
              this existed.
              TODO (PR 490's idea): fold in the presenter's camera cap (360p while
              presenting) if it turns out cheap — the egress already assumes
              it (`CAMERA_RUNG` matches 640x360@30 exactly) but nothing on the
              client holds the camera to that profile yet, so an uncapped
              camera can still crowd the share's own uplink. Leaving it as a
              TODO rather than adding a second quality control here. */}
          {cameraLiveOnStream(stream) && (
            <p
              data-testid="watch-party-tx-camera"
              className="text-[11px] text-text-tertiary"
            >
              {t("watchParty.tx.cameraLive")}
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
          <StreamQualityControl
            userId={userId}
            onQualityChange={onStreamQualityChange}
          />
          {/* THE STREAM'S OWN MIXER, next to the picture's other numbers.
              Unlike the quality picker above, both sliders change the
              RUNNING mix: the gain nodes they write are already in the
              graph, so there is nothing to rebind and no republish. See
              `screen-mix.ts` for why unity gain under-served a processed
              mic next to a film at near-full scale, and
              `stream-mix-levels.ts` for the ranges. */}
          {onOpenMixer ? (
            <StreamMixSummary onOpen={onOpenMixer} />
          ) : (
            <StreamMixControl
              onMicGainChange={onMicGainChange}
              onDisplayGainChange={onDisplayGainChange}
              micLevelDb={micLevelDb}
              outputLevelDb={outputLevelDb}
            />
          )}
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
    </>
  );

  return (
    <div
      data-testid="watch-party-transmission"
      data-tx-open={open ? "" : undefined}
      data-tx-health={health}
      className={cn(
        detailsInDialog
          ? "shrink-0 border-b border-ink-4/60 bg-ink-2 px-3 py-1"
          : "shrink-0 border-b border-ink-4/60 bg-ink-2/60 px-3 py-1.5",
        className,
      )}
    >
      <div className="flex items-center gap-2">
      <button
        type="button"
        data-testid="watch-party-tx-toggle"
        aria-expanded={open}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[11px] text-paper-muted hover:text-paper"
        onClick={() => setOpen((was) => !was)}
        title={
          detailsInDialog
            ? healthTitle
            : open
              ? t("watchParty.tx.collapse")
              : t("watchParty.tx.expand")
        }
      >
        {detailsInDialog ? (
          <span
            data-testid="watch-party-tx-health"
            aria-label={healthTitle}
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              health === "ok" && "bg-success",
              health === "warn" && "bg-warning",
              health === "bad" && "bg-danger motion-safe:animate-pulse",
              health === "idle" && "bg-paper-muted/40",
            )}
          />
        ) : open ? (
          <ChevronDown className="h-3 w-3 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />
        )}
        {!detailsInDialog && (
          <span className="shrink-0 font-semibold uppercase tracking-wider">
            {t("watchParty.tx.title")}
          </span>
        )}
        <span data-testid="watch-party-tx-summary" className="truncate">
          {statusLine}
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
        {/* A DIFFERENT SIGNAL FROM `silent` ABOVE, and shown only when that
            one is not already saying something: `silent` is the SERVER's
            "no audio track at all" (`hasAudio`); this is the live mixed-bus
            meter reading ten seconds of actual silence on a track that DOES
            exist (postmortem B2's -91 dB while the panel read "screen +
            mic"). Both mean the audience hears nothing; no reason to stack
            two pills saying so. */}
        {!silent && outputSilentWarning && (
          <span
            data-testid="watch-party-tx-output-silent-pill"
            className="ml-auto flex shrink-0 items-center gap-1 text-warning"
          >
            <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden />
            <span className="hidden sm:inline">
              {t("watchParty.tx.outputSilentPill")}
            </span>
          </span>
        )}
        {strained && !silent && !outputSilentWarning && (
          <TriangleAlert
            className="ml-auto h-3 w-3 shrink-0 text-warning"
            aria-hidden
          />
        )}
      </button>
      {trailing}
      </div>

      {open && detailsInDialog && (
        <Dialog
          open
          size="lg"
          title={t("watchParty.tx.title")}
          description={summary}
          onClose={() => setOpen(false)}
        >
          <DialogBody>
            <div className="flex flex-col gap-2">{details}</div>
          </DialogBody>
        </Dialog>
      )}
      {open && !detailsInDialog && (
        <div className="mt-2 flex flex-col gap-2">{details}</div>
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
 *
 * PER ACCOUNT (postmortem B7): `userId` scopes the storage key so a shared
 * browser's second host does not inherit the first host's opt-in. Optional
 * only because the two test files that render this control on its own
 * (`watch-party-transmission.test.tsx`) have no account to give it; the panel
 * always passes `props.currentUserId`.
 */
export function StreamQualityControl({
  userId = null,
  onQualityChange,
  stacked = false,
}: {
  userId?: string | null;
  /** Told on every change, including the one this control makes to itself. */
  onQualityChange?: (quality: WatchPartyStreamQuality) => void;
  /** Label above the select, no box of its own: for the setup card's column. */
  stacked?: boolean;
} = {}) {
  const { t } = useTranslation();
  const selectId = useId();
  const [quality, setQuality] = useState<WatchPartyStreamQuality>(() =>
    readWatchPartyStreamQuality(userId),
  );
  return (
    <div
      data-testid="watch-party-tx-stream-quality"
      className={cn(
        stacked
          ? "flex flex-col gap-1.5 px-3 py-2.5"
          : "flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-0 px-2.5 py-1.5",
      )}
    >
      <label
        htmlFor={selectId}
        className={cn(
          "min-w-0 flex flex-col",
          stacked ? "text-sm" : "text-[11px] text-paper-muted",
        )}
      >
        <span
          className={
            stacked
              ? "text-text"
              : "font-semibold uppercase tracking-wider text-text-tertiary"
          }
        >
          {t("watchParty.tx.streamQuality")}
        </span>
        <span className={cn("text-text-tertiary", stacked && "mt-0.5 text-xs")}>
          {t("watchParty.tx.streamQualityHint")}
        </span>
      </label>
      <select
        id={selectId}
        data-testid="watch-party-tx-stream-quality-select"
        className={cn(
          "h-[var(--control-sm)] shrink-0 rounded-[var(--radius-control)] border border-border bg-surface-2 pl-2.5 pr-7 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring",
          stacked && "w-full",
        )}
        value={quality}
        onChange={(event) => {
          const next = event.target.value as WatchPartyStreamQuality;
          setQuality(next);
          writeWatchPartyStreamQuality(next, userId);
          onQualityChange?.(next);
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

/**
 * The one-line stand-in for the mixer inside the transmission details: the
 * two levels as they are set right now, and the button that opens the real
 * thing. Reads storage on every render on purpose: the dialog writes the
 * same keys, and this row is only on screen while the details are open, so
 * a re-render after the dialog closes is what keeps the two in agreement
 * without a shared store.
 */
export function StreamMixSummary({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  const levels = readStreamMixLevels();
  return (
    <div
      data-testid="watch-party-tx-mixer-summary"
      className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface-0 px-2.5 py-2 text-[11px]"
    >
      <span className="min-w-0 truncate text-paper-muted">
        <span className="font-semibold uppercase tracking-wider text-text-tertiary">
          {t("watchParty.tx.mixer")}
        </span>{" "}
        {t("watchParty.tx.mixerSummary", {
          mic: formatGainDb(levels.micGain),
          display: formatGainDb(levels.displayGain),
        })}
      </span>
      <button
        type="button"
        data-testid="watch-party-tx-mixer-open"
        className="shrink-0 text-signal hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring"
        onClick={onOpen}
      >
        {t("watchParty.tx.mixerOpen")}
      </button>
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
  outputLevelDb,
}: {
  onMicGainChange?: (value: number) => void;
  onDisplayGainChange?: (value: number) => void;
  micLevelDb?: () => number | null;
  /** The mixed bus's live level, for the "Saída" row below. Postmortem B2. */
  outputLevelDb?: () => number | null;
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
  const [outputLevel, setOutputLevel] = useState<number | null>(null);

  useEffect(() => {
    if (!micLevelDb) {
      return;
    }
    const interval = setInterval(() => {
      setLevelDb(micLevelDb());
    }, MIC_LEVEL_POLL_MS);
    return () => clearInterval(interval);
  }, [micLevelDb]);

  useEffect(() => {
    if (!outputLevelDb) {
      return;
    }
    const interval = setInterval(() => {
      setOutputLevel(outputLevelDb());
    }, MIC_LEVEL_POLL_MS);
    return () => clearInterval(interval);
  }, [outputLevelDb]);

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

      {/* THE OUTPUT METER (postmortem B2): what is ACTUALLY leaving on the
          wire, post-limiter — not a lever, just the one number a host has no
          other way to see. No slider: there is nothing to adjust here, only
          something to notice. */}
      {outputLevelDb && (
        <div className="flex items-center justify-between gap-2 text-[11px] text-paper-muted">
          <span>{t("watchParty.tx.outputMeter")}</span>
          <div className="flex items-center gap-2">
            <span data-testid="watch-party-tx-output-level-db">
              {formatLevelDb(outputLevel)}
            </span>
            <MicLevelMeterBar
              db={outputLevel}
              testId="watch-party-tx-output-level"
            />
          </div>
        </div>
      )}

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
          <MicLevelMeterBar db={levelDb} testId="watch-party-tx-mic-level" />
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
 * A live level next to its slider (the mic gain), or on its own (the output
 * meter). Green below -12 dBFS (comfortable headroom under the mix's own
 * compressor, which sits at -6 dB); amber at or above, so a host sees they
 * are pushing the limiter before the audience hears it clip. `null` or
 * `-Infinity` (nothing mixed yet, or true digital silence) both draw an
 * empty bar rather than a warning — the warning text is a separate element
 * for the output case (`outputSilentWarning`), so this stays a plain meter.
 */
export function MicLevelMeterBar({
  db,
  testId,
}: {
  db: number | null;
  testId: string;
}) {
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
      data-testid={testId}
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

/** `-91 dB`, `-∞ dB` for true digital silence, or `--` while unmeasured. */
function formatLevelDb(db: number | null): string {
  if (db === null) {
    return "--";
  }
  return Number.isFinite(db) ? `${Math.round(db)} dB` : "-∞ dB";
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

/**
 * Whether the camera note belongs on this render.
 *
 * Exported for the same reason `streamAudioState` is: the note lives behind
 * the panel's own click, which `react-dom/server` cannot make, so the rule it
 * draws on is tested directly rather than through markup. `stream.cameraHlsUrl`
 * is absent for the ordinary film night (no webcam on), for a box that
 * refused the camera on budget, and for `LIVE_HLS_CAMERA=false` — all of which
 * must read exactly like a server that predates the feature.
 */
export function cameraLiveOnStream(stream: LiveHlsStream | null): boolean {
  return Boolean(stream?.cameraHlsUrl);
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
