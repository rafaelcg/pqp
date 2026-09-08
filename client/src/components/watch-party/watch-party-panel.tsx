import { useEffect, useRef, useState } from "react";
import {
  Clapperboard,
  Crown,
  MonitorPlay,
  Phone,
  Radio,
  Square,
  Undo2,
} from "lucide-react";
import {
  canPerformWatchPartyAction,
  SLOWMODE_SECONDS_PRESETS,
  type WatchParty,
  type WatchPartyOptions,
} from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { UserAvatar } from "@/components/user/user-avatar";
import { FeatureHint } from "@/components/layout/feature-hint";
import { formatSessionRelativeTime } from "@/lib/channel-session-schedule";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The watch party surface inside a `watch_party` channel: everything between
 * "there is no party" and "there is one and it is on air".
 *
 * WHY THIS IS ONE COMPONENT AND NOT FOUR. The four things it draws (an empty
 * stage, a host setting one up, a scheduled card, a live bar) are four states
 * of ONE object, and the whole complaint that produced this work was that the
 * feature was a set of unrelated controls rather than a journey. Splitting
 * them by file would have put the transitions between them in `App.tsx`,
 * which is exactly where a journey goes to die.
 *
 * IT DOES NOT DRAW THE PICTURE. `WatchChannelStage` owns the HLS player and
 * has since the morning this shipped. When a party is live and a stream
 * exists, this renders a slim bar above it and nothing else. When a party is
 * live and no stream exists yet, this is the thing that says so, which is the
 * gap that made a second browser look broken: the old code rendered `null`
 * and a viewer got a blank pane with no explanation.
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

export interface WatchPartyPanelProps {
  party: WatchParty | null;
  channelId: string;
  channelName: string;
  /** START_WATCH_PARTY on this channel: may create one, may take the stage. */
  canStart: boolean;
  /** True while this person holds a seat in this channel's voice room. */
  inCall: boolean;
  /** True while `WatchChannelStage` has a playable stream for this channel. */
  hasStream: boolean;
  /** True while this person is the one whose screen is on the stage. */
  isPresenting: boolean;
  /** Everyone watching, seated or not, presenter excluded. */
  audienceCount: number;
  onCreate: () => void;
  onGoLive: (stream: MediaStream | null) => Promise<void>;
  onEnd: () => Promise<void>;
  onDiscard: () => Promise<void>;
  onOptionsChange: (options: Partial<WatchPartyOptions>) => Promise<void>;
  onRename: (name: string) => Promise<void>;
  onClaimHost: () => Promise<void>;
  onJoinCall: () => void;
  onShapeChange?: (shape: "expanded" | "none") => void;
  /** First time this host has reached a setup surface. */
  showHostHint?: boolean;
  /** First time this person has watched a live party. */
  showViewerHint?: boolean;
}

export function WatchPartyPanel(props: WatchPartyPanelProps) {
  const { party } = props;
  const state = party?.state ?? null;

  // Only the surfaces that fill the stage declare a shape. The live bar is
  // furniture above whatever `WatchChannelStage` is doing and must not fight
  // it for the split, the same rule `WatchChannelStage` follows about
  // `CallStage`.
  const fills =
    state === "draft" ||
    state === "scheduled" ||
    (state === "live" && !props.hasStream && !props.inCall) ||
    (state === null && props.canStart);
  const wasFilling = useRef(false);
  const { onShapeChange } = props;
  useEffect(() => {
    if (fills) {
      wasFilling.current = true;
      onShapeChange?.("expanded");
      return;
    }
    if (wasFilling.current) {
      wasFilling.current = false;
      onShapeChange?.("none");
    }
  }, [fills, onShapeChange]);
  useEffect(
    () => () => {
      if (wasFilling.current) {
        wasFilling.current = false;
        onShapeChange?.("none");
      }
    },
    [onShapeChange],
  );

  if (!party) {
    return props.canStart ? <EmptyStage {...props} /> : null;
  }
  if (party.state === "draft") {
    return <SetupStage {...props} party={party} />;
  }
  if (party.state === "scheduled") {
    return <ScheduledStage {...props} party={party} />;
  }
  if (party.state === "live") {
    return <LiveSurface {...props} party={party} />;
  }
  return null;
}

// ------------------------------------------------------------- no party yet

function EmptyStage(props: WatchPartyPanelProps) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="watch-party-empty"
      className="flex shrink-0 flex-col items-center justify-center gap-2 border-b border-ink-4/60 bg-ink px-6 py-8 text-center"
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-ink-3 text-paper-muted">
        <Clapperboard className="h-5 w-5" aria-hidden />
      </span>
      <p className="text-sm font-semibold text-paper">
        {t("watchParty.empty.title")}
      </p>
      <p className="max-w-sm text-xs text-paper-muted">
        {t("watchParty.empty.body")}
      </p>
      <Button
        type="button"
        className="mt-1"
        onClick={props.onCreate}
        data-watch-party-create
      >
        <Clapperboard className="mr-1.5 h-3.5 w-3.5" aria-hidden />
        {t("watchParty.create.button")}
      </Button>
    </div>
  );
}

// -------------------------------------------------------- the draft, setting up

/**
 * The step Rafael asked for and the one nothing in the app had: the host sees
 * exactly what the room will see, with the settings that matter beside it, and
 * NOTHING IS BROADCAST until they press the one button.
 *
 * THE PREVIEW IS THE REAL CAPTURE. `getDisplayMedia` runs here, during setup,
 * and the same `MediaStream` is handed to the call on go-live (see
 * `ScreenCaptureIntent.stream`). A preview that opened its own capture and then
 * made the host pick again at go-live would be a rehearsal, not a preview: the
 * thing they approved and the thing that went out would be two different
 * captures.
 */
function SetupStage(props: WatchPartyPanelProps & { party: WatchParty }) {
  const { t } = useTranslation();
  const { party } = props;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [name, setName] = useState(party.name);
  const [busy, setBusy] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => setName(party.name), [party.id, party.name]);

  // The preview stream belongs to this surface. Leaving the draft without
  // going live has to stop the capture, or the browser keeps showing "pqp is
  // sharing your screen" for a share that never happened.
  useEffect(
    () => () => {
      setStream((held) => {
        held?.getTracks().forEach((track) => track.stop());
        return null;
      });
    },
    [],
  );

  useEffect(() => {
    const video = videoRef.current;
    if (video && video.srcObject !== stream) {
      video.srcObject = stream;
    }
  }, [stream]);

  const pick = async () => {
    setPickError(null);
    try {
      const picked = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      stream?.getTracks().forEach((track) => track.stop());
      // The host stopping the share from the browser's own bar during setup
      // must clear the preview, not leave a frozen last frame that they then
      // go live with.
      picked.getVideoTracks()[0]?.addEventListener("ended", () => {
        setStream((held) => (held === picked ? null : held));
      });
      setStream(picked);
    } catch (error) {
      // Cancelling the picker is the common case and is not an error worth a
      // red line; only a genuine failure is.
      if (error instanceof Error && error.name === "NotAllowedError") {
        return;
      }
      setPickError(t("watchParty.setup.pickError"));
    }
  };

  const goLive = async () => {
    setBusy(true);
    try {
      const handing = stream;
      // Handed off, not stopped: the call now owns these tracks.
      setStream(null);
      await props.onGoLive(handing);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="watch-party-setup"
      className="relative flex h-[68svh] min-h-[320px] shrink-0 flex-col overflow-hidden border-b border-ink-4/60 bg-ink"
    >
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 bg-black">
          {stream ? (
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="h-full w-full object-contain"
              data-testid="watch-party-preview"
            />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center">
              <MonitorPlay
                className="h-7 w-7 text-paper-muted"
                aria-hidden
              />
              <p className="text-sm text-paper-muted">
                {t("watchParty.setup.noSource")}
              </p>
              <Button type="button" variant="secondary" onClick={() => void pick()}>
                {t("watchParty.setup.pick")}
              </Button>
              {pickError && (
                <p className="text-xs text-danger">{pickError}</p>
              )}
            </div>
          )}
          <span className="pointer-events-none absolute left-2 top-2 rounded bg-ink/80 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-paper-muted">
            {t("watchParty.setup.heading")}
          </span>
          {stream && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="absolute right-2 top-2"
              onClick={() => void pick()}
            >
              {t("watchParty.setup.repick")}
            </Button>
          )}
        </div>

        <aside className="hidden w-72 shrink-0 flex-col gap-3 overflow-y-auto border-l border-ink-4/60 p-3 sm:flex">
          <p className="text-xs text-paper-muted">{t("watchParty.setup.body")}</p>
          <label className="block text-xs text-paper-muted">
            <span className="mb-1 block">{t("watchParty.setup.nameLabel")}</span>
            <input
              type="text"
              maxLength={120}
              className="w-full rounded-md border border-ink-4 bg-ink-3 px-2 py-1.5 text-sm text-paper"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => {
                const next = name.trim();
                if (next.length > 0 && next !== party.name) {
                  void props.onRename(next);
                }
              }}
              data-watch-party-name
            />
          </label>

          <p className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-paper-muted">
            {t("watchParty.setup.optionsTitle")}
          </p>

          <label className="block text-xs text-paper-muted">
            <span className="mb-1 block">{t("watchParty.setup.slowMode")}</span>
            <select
              className="w-full rounded-md border border-ink-4 bg-ink-3 px-2 py-1.5 text-sm text-paper"
              value={String(party.options.slowModeSeconds)}
              onChange={(event) =>
                void props.onOptionsChange({
                  slowModeSeconds: Number(event.target.value),
                })
              }
              data-watch-party-slow-mode
            >
              {SLOWMODE_SECONDS_PRESETS.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {t(slowModeKey(seconds), { seconds })}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-xs text-paper-muted">
            <span className="mb-1 block">{t("watchParty.setup.stageMode")}</span>
            <select
              className="w-full rounded-md border border-ink-4 bg-ink-3 px-2 py-1.5 text-sm text-paper"
              value={party.options.stageMode}
              onChange={(event) =>
                void props.onOptionsChange({
                  stageMode:
                    event.target.value === "hosts_only" ? "hosts_only" : "open",
                })
              }
              data-watch-party-stage-mode
            >
              <option value="open">{t("watchParty.setup.stageOpen")}</option>
              <option value="hosts_only">
                {t("watchParty.setup.stageHosts")}
              </option>
            </select>
          </label>

          <label className="flex items-center gap-2 text-xs text-paper-muted">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-signal"
              checked={party.options.reactionsEnabled}
              onChange={(event) =>
                void props.onOptionsChange({
                  reactionsEnabled: event.target.checked,
                })
              }
              data-watch-party-reactions
            />
            {t("watchParty.setup.reactions")}
          </label>

          <p className="text-[11px] text-paper-muted">
            {t("watchParty.setup.stageHint")}
          </p>
        </aside>
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-ink-4/60 px-3 py-2.5 sm:flex-row sm:items-center">
        <p className="min-w-0 flex-1 text-[11px] text-paper-muted">
          {t("watchParty.setup.goLiveHint", {
            channel: `#${props.channelName}`,
          })}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setConfirmDiscard(true)}
            data-watch-party-discard
          >
            <Undo2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {t("watchParty.setup.discard")}
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={() => void goLive()}
            data-watch-party-go-live
            className="bg-danger text-paper hover:bg-danger/85"
          >
            <Radio className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {t("watchParty.setup.goLive")}
          </Button>
        </div>
      </div>

      {/* The one sentence a first-time host needs, on the surface where it
          is true. `lib/hints.ts` remembers it; `docs/ONBOARDING.md` has the
          row. */}
      <div className="pointer-events-none absolute bottom-16 right-3 z-10 [&>*]:pointer-events-auto">
        <FeatureHint
          id="watchPartyHost"
          enabled={props.showHostHint === true}
          title={t("watchParty.create.title")}
          body={t("featureHint.watchPartyHost.body")}
        />
      </div>

      <ConfirmDialog
        open={confirmDiscard}
        title={t("watchParty.setup.discardConfirmTitle")}
        description={t("watchParty.setup.discardConfirmBody", {
          name: party.name,
        })}
        confirmLabel={t("watchParty.setup.discard")}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={() => void props.onDiscard()}
      />
    </div>
  );
}

// --------------------------------------------------------------- scheduled

function ScheduledStage(props: WatchPartyPanelProps & { party: WatchParty }) {
  const { t } = useTranslation();
  const { party } = props;
  const canGoLive = canPerformWatchPartyAction({
    action: "goLive",
    role: party.viewerRole,
    state: party.state,
  });
  return (
    <div
      data-testid="watch-party-scheduled"
      className="flex shrink-0 flex-col items-center justify-center gap-2 border-b border-ink-4/60 bg-ink px-6 py-8 text-center"
    >
      <PartyIdentity party={party} />
      <p className="text-xs text-paper-muted">
        {formatSessionRelativeTime(party.startsAt ?? "", new Date(), "pt-BR")}
      </p>
      {canGoLive && (
        <>
          <Button
            type="button"
            className="mt-1 bg-danger text-paper hover:bg-danger/85"
            onClick={() => void props.onGoLive(null)}
            data-watch-party-go-live
          >
            <Radio className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {t("watchParty.scheduled.goLiveNow")}
          </Button>
          <p className="text-[11px] text-paper-muted">
            {t("watchParty.scheduled.hostNote")}
          </p>
        </>
      )}
    </div>
  );
}

// --------------------------------------------------------------------- live

/**
 * A live party is two facts that are NOT the same fact: the show is on, and
 * there is a picture. The old code only had the second, so a viewer who
 * arrived before the host started sharing saw an empty pane with no words on
 * it and concluded the feature was broken. That was Rafael's second browser.
 */
function LiveSurface(props: WatchPartyPanelProps & { party: WatchParty }) {
  const { t } = useTranslation();
  const { party } = props;
  const [confirmEnd, setConfirmEnd] = useState(false);
  const canEnd = canPerformWatchPartyAction({
    action: "end",
    role: party.viewerRole,
    state: party.state,
  });
  const canClaim =
    party.hostDisconnectedAt !== null &&
    canPerformWatchPartyAction({
      action: "claimHost",
      role: party.viewerRole,
      state: party.state,
      hostDisconnectedAt: Date.parse(party.hostDisconnectedAt),
      now: Date.now(),
    });
  const runningTheShow =
    party.viewerRole === "host" || party.viewerRole === "cohost";

  const viewerHint = (
    <div className="pointer-events-none absolute right-3 top-14 z-10 [&>*]:pointer-events-auto">
      <FeatureHint
        id="watchPartyViewer"
        enabled={props.showViewerHint === true}
        title={t("watchParty.live.watch")}
        body={t("featureHint.watchPartyViewer.body")}
      />
    </div>
  );

  const bar = (
    <div
      data-testid="watch-party-bar"
      className="flex shrink-0 items-center gap-3 border-b border-ink-4/60 bg-ink-2 px-3 py-2"
    >
      <PartyIdentity party={party} compact />
      <span className="ml-auto flex shrink-0 items-center gap-2">
        <span
          data-testid="watch-party-viewers"
          className="text-xs text-paper-muted"
        >
          {t("watchParty.live.viewers", { count: props.audienceCount })}
        </span>
        {!props.inCall && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            title={t("watchParty.live.watchHint")}
            onClick={props.onJoinCall}
            data-watch-party-join-call
          >
            <Phone className="mr-1.5 h-3 w-3" aria-hidden />
            {t("watchParty.live.joinCall")}
          </Button>
        )}
        {canClaim && (
          <Button
            type="button"
            size="sm"
            onClick={() => void props.onClaimHost()}
            data-watch-party-claim
          >
            <Crown className="mr-1.5 h-3 w-3" aria-hidden />
            {t("watchParty.live.claim")}
          </Button>
        )}
        {canEnd && (
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={() => setConfirmEnd(true)}
            data-watch-party-end
          >
            <Square className="mr-1.5 h-3 w-3" aria-hidden />
            {t("watchParty.live.end")}
          </Button>
        )}
      </span>
      <ConfirmDialog
        open={confirmEnd}
        title={t("watchParty.live.endConfirmTitle")}
        description={t("watchParty.live.endConfirmBody", { name: party.name })}
        confirmLabel={t("watchParty.live.end")}
        onClose={() => setConfirmEnd(false)}
        onConfirm={() => void props.onEnd()}
      />
    </div>
  );

  const hostGone = party.hostDisconnectedAt !== null && (
    <div
      data-testid="watch-party-host-gone"
      className="flex shrink-0 items-center gap-2 border-b border-ink-4/60 bg-warning/10 px-3 py-1.5 text-xs text-warning"
    >
      <span className="font-semibold">{t("watchParty.live.hostGone")}</span>
      <span className="text-paper-muted">
        {t("watchParty.live.hostGoneBody", { name: party.hostDisplayName })}
      </span>
    </div>
  );

  // Nothing on screen yet, and the person is not in the call: say so instead
  // of rendering nothing. The host gets the instruction, everyone else gets
  // the reassurance.
  if (!props.hasStream && !props.inCall) {
    return (
      <div className="relative flex h-[68svh] min-h-[280px] shrink-0 flex-col overflow-hidden border-b border-ink-4/60 bg-ink">
        {bar}
        {hostGone}
        {viewerHint}
        <div
          data-testid="watch-party-waiting"
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-black px-6 text-center"
        >
          <Radio
            className="h-7 w-7 text-danger motion-safe:animate-pulse"
            aria-hidden
          />
          <p className="text-sm font-semibold text-paper">
            {t("watchParty.live.waiting")}
          </p>
          <p className="max-w-sm text-xs text-paper-muted">
            {runningTheShow && props.canStart
              ? t("watchParty.live.waitingHost")
              : t("watchParty.live.waitingBody", {
                  name: party.hostDisplayName,
                })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative shrink-0">
      {bar}
      {hostGone}
      {viewerHint}
    </div>
  );
}

// -------------------------------------------------------------- the identity

/** The party's own name, the host's face, and the live pill. Never the channel. */
function PartyIdentity({
  party,
  compact = false,
}: {
  party: WatchParty;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const live = party.state === "live";
  return (
    <span className={cn("flex min-w-0 items-center gap-2.5")}>
      <UserAvatar
        name={party.hostDisplayName}
        avatarUrl={party.hostAvatarUrl}
        rounded="full"
        className={cn("shrink-0", compact ? "h-7 w-7" : "h-10 w-10")}
      />
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            data-watch-party-name-label
            className={cn(
              "truncate font-semibold text-paper",
              compact ? "text-sm" : "text-base",
            )}
          >
            {party.name}
          </span>
          {live && (
            <span
              data-watch-party-live-pill
              className="flex shrink-0 items-center gap-1 rounded-full bg-danger/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-danger"
            >
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full bg-danger motion-safe:animate-pulse"
              />
              {t("watchParty.live.badge")}
            </span>
          )}
        </span>
        <span className="truncate text-[11px] text-paper-muted">
          {t("watchParty.live.hostedBy", { name: party.hostDisplayName })}
        </span>
      </span>
    </span>
  );
}
