import { Check, SlidersHorizontal } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Tooltip, useFullscreenPortalHost } from "@/components/ui/tooltip";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { InboundVideoReadout } from "@/components/voice/inbound-video-readout";
import { OutboundVideoReadout } from "@/components/voice/outbound-video-readout";
import {
  RECEIVE_QUALITIES,
  setReceiveQuality,
  useReceiveQuality,
  useReceiveQualityReason,
  type ReceiveQuality,
} from "@/lib/receive-quality";
import {
  availableVideoQualities,
  coerceVideoQuality,
  LARGE_ROOM_PARTICIPANTS,
  screenSimulcastPlan,
  type VideoQuality,
} from "@/lib/video-quality";
import {
  DEFAULT_SCREEN_FRAME_RATE,
  SCREEN_FRAME_RATES,
  type ScreenFrameRate,
} from "@/lib/hls-capture-rate";
import { cn } from "@/lib/utils";

/**
 * The camera's quality setting, on the call, next to the camera button.
 *
 * WHY IT IS HERE AND NOT ONLY IN SETTINGS. Bad video is noticed during a call
 * and nowhere else, and the readout that tells you what you are actually
 * sending is only alive during a call. Putting the one control that answers
 * "is my video OK" behind a dialog, under a tab named after audio, meant that
 * the person who most needed it had already left the surface where the
 * question occurred to them.
 *
 * IT DOES NOT WIDEN THE BAR BY FIVE BUTTONS. One round button in the bar's
 * own idiom, which opens a menu upward over the stage. The button carries the
 * bar's "active" tint whenever a size is pinned, so `auto` (everybody, by
 * default) looks like every other resting control and a deliberate 480p is
 * visible without opening anything.
 *
 * OPEN STATE IS THE PARENT'S. The stage fades its control bar after a few idle
 * seconds, and a bar that fades while this is open takes the menu with it, so
 * the stage has to know. See `video-quality-control.ts`.
 *
 * TWO HALVES, NAMED FOR THEIR DIRECTIONS, AND THAT IS THE WHOLE FIX. The menu
 * used to be one list of sizes under the heading "Camera and screen quality",
 * shown with identical wording to a presenter and to a watcher. Those are
 * opposite situations: the presenter's choice decides what everyone sees, and
 * on the mesh the watcher's decides nothing at all, because the sender encodes
 * the stream and `RTCRtpReceiver` has no size or rate parameter to answer with.
 * Somebody watching a soft share therefore reached for the only control the
 * product offered, moved it two rungs, and got nothing, twice, across a
 * rejoin. So the sizes now sit under "Video you send" and appear only while
 * this machine is actually sending; underneath them, "Video you receive" says
 * what is arriving and whose choice it was. Nothing here promises a mesh
 * viewer a knob that WebRTC does not have.
 *
 * ON THE SFU THE VIEWER DOES GET A KNOB, since 6 Sep 2026. The presenter
 * publishes simulcast layers (`livekit-session.ts`), so the server holds a
 * 360p and a 720p copy next to the top one, and "Video you receive" carries a
 * second list: Auto, 1080p, 720p, 360p. Auto lets the size of the picture on
 * this screen decide; a fixed choice is the largest layer this device will
 * accept. It is remembered per device (`receive-quality.ts`), which is why a
 * phone opens on 720p and a desktop on Auto. The mesh keeps the sentence and
 * hides the list, because there the sentence is still the truth.
 *
 * THE LARGE-ROOM NOTE. Past twenty people an SFU presenter's screen is held
 * to 720p unless they picked 1080p by name (`screenSimulcastPlan`). A cap
 * that acts silently reads as a broken setting, so while it is in effect the
 * sending half says so, and says how to override it.
 *
 * NO 1080P AT ALL past `HUGE_ROOM_1080P_LIMIT` people
 * (`availableVideoQualities`). A stored 1080p reads as Auto in here for as
 * long as that holds; the preference itself is kept. A live HLS egress used
 * to remove the rung too; it no longer does, because the ladder's top
 * rendition is transcoded from the published track and a 720p share caps
 * every viewer at 720p.
 */
const LABELS: Record<VideoQuality, MessageKey> = {
  auto: "settings.voice.videoQuality.auto",
  "1080p": "settings.voice.videoQuality.1080p",
  "720p": "settings.voice.videoQuality.720p",
  "480p": "settings.voice.videoQuality.480p",
  "360p": "settings.voice.videoQuality.360p",
};

const FRAME_RATE_LABELS: Record<ScreenFrameRate, MessageKey> = {
  auto: "settings.voice.screenFrameRate.auto",
  "30": "settings.voice.screenFrameRate.30",
  "60": "settings.voice.screenFrameRate.60",
};

const RECEIVE_LABELS: Record<ReceiveQuality, MessageKey> = {
  auto: "settings.voice.videoQuality.auto",
  "1080p": "settings.voice.videoQuality.1080p",
  "720p": "settings.voice.videoQuality.720p",
  "360p": "settings.voice.videoQuality.360p",
};

const ITEM_CLASS =
  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm text-paper outline-none hover:bg-ink-3 focus-visible:bg-ink-3";

export function VideoQualityMenu({
  value: rawValue,
  open,
  onOpenChange,
  onChange,
  isSendingVideo,
  isSharingScreen = false,
  screenFrameRate = DEFAULT_SCREEN_FRAME_RATE,
  onScreenFrameRateChange,
  usingSfu = false,
  watchingHls = false,
  hlsLive = false,
  hlsDelaySeconds = 10,
  participantCount = 1,
  buttonClassName,
  iconClassName,
}: {
  value: VideoQuality;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (quality: VideoQuality) => void;
  /**
   * Whether this machine has a camera or a share on the wire.
   *
   * False hides the size list entirely rather than disabling it. A disabled
   * rung is still an offer, and the offer would be a lie: picking one while
   * you are only watching changes a stored number and nothing a person can
   * see. The button remains, because the receiving half below it is exactly
   * what a watcher opened this for.
   */
  isSendingVideo: boolean;
  /** Whether the share, specifically, is this machine's. The cap is about it. */
  isSharingScreen?: boolean;
  /** Capture cadence for the share. Auto follows the watch-party ladder. */
  screenFrameRate?: ScreenFrameRate;
  onScreenFrameRateChange?: (rate: ScreenFrameRate) => void;
  /** Media on the SFU: the receive list exists, the mesh sentence does not. */
  usingSfu?: boolean;
  /**
   * Viewer is on the HLS playlist. That encode is one size; the receive
   * list would change a paused WebRTC track and nothing on the picture.
   */
  watchingHls?: boolean;
  /** An HLS egress of this room's share is running: 1080p is off the list. */
  hlsLive?: boolean;
  hlsDelaySeconds?: number;
  /** Everybody in the room, this machine included. Decides the cap note. */
  participantCount?: number;
  buttonClassName?: string;
  iconClassName?: string;
}) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const portalHost = useFullscreenPortalHost();
  // Where the panel sits, in viewport pixels. It is portalled out of the bar:
  // in the composer's strip the stage above is a separate box whose own
  // layers (the people strip) drew over a panel hanging up into it, and took
  // the clicks meant for it.
  const [place, setPlace] = useState<{ left: number; top: number } | null>(
    null,
  );
  const receiveQuality = useReceiveQuality();
  const receiveReason = useReceiveQualityReason();
  const qualities = availableVideoQualities({ participantCount, hlsLive });
  const value = coerceVideoQuality(rawValue, qualities);

  // Same dismissal contract as the user-panel popover: a press anywhere else,
  // or Escape. Anchored on the wrapper rather than the panel so a press on the
  // button itself is the button's toggle rather than an outside-close followed
  // by a re-open.
  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !panelRef.current?.contains(target)
      ) {
        onOpenChange(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onOpenChange(false);
        // Back to the button the panel hung from, since the panel is
        // portalled to the end of the page.
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange]);

  // Above the button, centred on it, and kept inside the window. Measured
  // again on resize and scroll, since the bar can move under an open panel.
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    const measure = () => {
      const anchor = rootRef.current?.getBoundingClientRect();
      const panel = panelRef.current;
      if (!anchor || !panel) {
        return;
      }
      const width = panel.offsetWidth;
      const margin = 8;
      const centre = anchor.left + anchor.width / 2;
      const left = Math.min(
        Math.max(centre - width / 2, margin),
        window.innerWidth - width - margin,
      );
      const top = Math.max(anchor.top - panel.offsetHeight - margin, margin);
      setPlace((previous) =>
        previous && previous.left === left && previous.top === top
          ? previous
          : { left, top },
      );
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    // The panel grows after it opens (the live readout fills in), and it
    // must grow upward, never down over its own button.
    const grown =
      typeof ResizeObserver === "undefined" || !panelRef.current
        ? null
        : new ResizeObserver(measure);
    if (grown && panelRef.current) {
      grown.observe(panelRef.current);
    }
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      grown?.disconnect();
    };
  }, [open]);

  // Closed by a pick (the rows close it themselves) or by focus leaving:
  // focus was inside the panel, which is gone now, so it goes back to the
  // button rather than to the top of the page. A close caused by a press on
  // something else leaves focus with that something.
  const wasOpenRef = useRef(open);
  useEffect(() => {
    if (wasOpenRef.current && !open) {
      const active = document.activeElement;
      if (!active || active === document.body) {
        buttonRef.current?.focus();
      }
    }
    wasOpenRef.current = open;
  }, [open]);

  // Arrow keys, Home and End move between the rows, as in every other menu
  // here; Tab out of the panel closes it.
  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        '[role="menuitemradio"], [role="menuitem"]',
      ),
    );
    if (rows.length === 0) {
      return;
    }
    const at = rows.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (event.key === "ArrowDown") next = at < 0 ? 0 : (at + 1) % rows.length;
    else if (event.key === "ArrowUp") next = at <= 0 ? rows.length - 1 : at - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    if (next !== null) {
      event.preventDefault();
      rows[next]?.focus();
    }
  };
  const onPanelBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const to = event.relatedTarget as Node | null;
    if (
      to &&
      !event.currentTarget.contains(to) &&
      !rootRef.current?.contains(to)
    ) {
      onOpenChange(false);
    }
  };

  // Focus goes into the panel when it opens: it is portalled to the end of
  // the page, so Tab from the button would never reach it. The ticked row
  // first, else the panel's first control.
  useEffect(() => {
    if (!open) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      const target =
        panel?.querySelector<HTMLElement>('[aria-checked="true"]') ??
        panel?.querySelector<HTMLElement>("button");
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // The button's own name changes with the role, because it is the first
  // thing read and the last thing a screen-reader user hears before opening
  // something that, for a mesh viewer, contains no control at all.
  const label = isSendingVideo
    ? t("call.quality.open", { quality: t(LABELS[value]) })
    : t("call.quality.openReceiving");

  const largeRoomCap =
    usingSfu &&
    isSharingScreen &&
    screenSimulcastPlan(value, participantCount).capped;

  // The receiving half's honest line: why what arrives may be smaller than
  // the row that is ticked. Mobile data set the default (this device, no
  // choice made), or the room's size holds every presenter to 720p (the
  // sending half already says so to the presenter, so it is not said twice
  // to the one person who is both).
  const receiveCellularDefault = usingSfu && receiveReason === "cellular";
  const receiveLargeRoomCap =
    usingSfu && !isSharingScreen && participantCount > LARGE_ROOM_PARTICIPANTS;

  return (
    <div ref={rootRef} className="relative">
      {open && typeof document !== "undefined" && createPortal(
        <div
          ref={panelRef}
          role="menu"
          onKeyDown={onPanelKeyDown}
          onBlur={onPanelBlur}
          aria-label={label}
          className="fixed z-[100] w-64 max-w-[80vw] rounded-lg border border-ink-4 bg-ink-2 p-1 shadow-[var(--shadow-popover)] animate-fade-in"
          // Hidden for the one frame before it is measured, so it never
          // flashes at the window's corner.
          style={
            place
              ? { left: place.left, top: place.top }
              : { left: 0, top: 0, visibility: "hidden" }
          }
        >
          {isSendingVideo && (
            <p className="px-2.5 pb-1 pt-1.5 text-xs uppercase tracking-wide text-paper-muted">
              {t("settings.voice.videoQuality")}
            </p>
          )}
          {isSendingVideo &&
            qualities.map((quality) => {
              const selected = quality === value;
              return (
                <button
                  key={quality}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  className={ITEM_CLASS}
                  onClick={() => {
                    onChange(quality);
                    onOpenChange(false);
                  }}
                >
                  <Check
                    className={cn(
                      "h-3.5 w-3.5 shrink-0 text-signal",
                      !selected && "invisible",
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {t(LABELS[quality])}
                  </span>
                </button>
              );
            })}
          {/* The cap, said out loud while it acts. Without this line a
              presenter on Auto in a big room reads "1080p" nowhere and
              "720p" in the readout below and concludes the setting is broken. */}
          {largeRoomCap && (
            <p className="px-2.5 pb-1 pt-0.5 text-xs text-paper-muted">
              {t("call.quality.send.largeRoomCap")}
            </p>
          )}
          {isSharingScreen && onScreenFrameRateChange && (
            <>
              <p className="px-2.5 pb-1 pt-1.5 text-xs uppercase tracking-wide text-paper-muted">
                {t("call.quality.send.frameRate")}
              </p>
              {SCREEN_FRAME_RATES.map((rate) => {
                const selected = rate === screenFrameRate;
                return (
                  <button
                    key={rate}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className={ITEM_CLASS}
                    onClick={() => {
                      onScreenFrameRateChange(rate);
                      onOpenChange(false);
                    }}
                  >
                    <Check
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 text-signal",
                        !selected && "invisible",
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {t(FRAME_RATE_LABELS[rate])}
                    </span>
                  </button>
                );
              })}
              <p className="px-2.5 pb-1 pt-0.5 text-xs text-paper-muted">
                {t("call.quality.send.frameRateHint")}
              </p>
            </>
          )}
          {/* The reason the control is on the call rather than only in a
              dialog: the size actually leaving this machine, updating while
              you look at it. Changing the choice above re-shapes the track
              that is already on the wire, so this number moves within a
              couple of seconds without the camera blinking. */}
          {isSendingVideo && (
            <div className="mt-1 border-t border-ink-4/60 px-2.5 pb-1.5 pt-1">
              <OutboundVideoReadout
                idleKey="call.quality.unmeasured"
                quality={value}
                viewers={Math.max(0, participantCount - 1)}
              />
            </div>
          )}
          {/* The other direction, and for a viewer the only thing in here.
              Always present, including for a presenter who is also watching
              somebody else: "mine is fine and theirs is 360p" is a diagnosis,
              and it is unavailable from any other surface in the product. */}
          <div className="mt-1 border-t border-ink-4/60 pb-1.5 pt-1">
            <p className="px-2.5 pb-0.5 text-xs uppercase tracking-wide text-paper-muted">
              {t("call.quality.receiving")}
            </p>
            {usingSfu &&
              !watchingHls &&
              RECEIVE_QUALITIES.map((quality) => {
                const selected = quality === receiveQuality;
                return (
                  <button
                    key={quality}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className={ITEM_CLASS}
                    onClick={() => {
                      setReceiveQuality(quality);
                    }}
                  >
                    <Check
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 text-signal",
                        !selected && "invisible",
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {t(RECEIVE_LABELS[quality])}
                    </span>
                  </button>
                );
              })}
            {watchingHls && (
              <p
                data-testid="receive-reason-hls"
                className="px-2.5 pb-0.5 pt-1 text-xs text-paper-muted"
              >
                {t("call.quality.receive.hls", { seconds: hlsDelaySeconds })}
              </p>
            )}
            {receiveCellularDefault && !watchingHls && (
              <p
                data-testid="receive-reason-cellular"
                className="px-2.5 pb-0.5 pt-1 text-xs text-paper-muted"
              >
                {t("call.quality.receive.cellularDefault")}
              </p>
            )}
            {receiveLargeRoomCap && !watchingHls && (
              <p
                data-testid="receive-reason-large-room"
                className="px-2.5 pb-0.5 pt-1 text-xs text-paper-muted"
              >
                {t("call.quality.receive.largeRoomCap")}
              </p>
            )}
            {usingSfu && !watchingHls && (
              <p className="px-2.5 pb-0.5 pt-1 text-xs text-paper-muted">
                {t("call.quality.receive.hint")}
              </p>
            )}
            <div className="px-2.5">
              <InboundVideoReadout
                usingSfu={usingSfu}
                watchingHls={watchingHls}
              />
            </div>
          </div>
        </div>,
        portalHost ?? document.body,
      )}
      {/* The tooltip carries the same sentence the old `title` did, minus the
          one-second wait and plus keyboard focus. It closes on the press that
          opens the menu, so the two never stack on top of each other. */}
      <Tooltip label={label}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "flex items-center justify-center rounded-full",
          buttonClassName,
          // Pinned reads as "on", exactly like the camera and share buttons.
          // Auto is the default everybody has, so it stays a resting control.
          // A viewer's button is never tinted: the stored size is not governing
          // anything they can see, and tinting it would be the same claim the
          // old label made.
          isSendingVideo &&
          (value !== "auto" || screenFrameRate !== "auto")
            ? "bg-signal/20 text-signal"
            : "bg-ink-3 text-paper hover:bg-ink-4",
        )}
        onClick={() => onOpenChange(!open)}
      >
        <SlidersHorizontal className={iconClassName} />
      </button>
      </Tooltip>
    </div>
  );
}
