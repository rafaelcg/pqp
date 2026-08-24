import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Maximize2, Minimize2, ScreenShareOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  detectFullscreenMode,
  type FullscreenMode,
} from "@/components/voice/capabilities";
import { attemptElementFullscreen } from "@/components/voice/element-fullscreen";
import { desktopContext } from "@/lib/desktop";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The Fullscreen API, spelled both ways.
 *
 * Safari only shipped the unprefixed names in 16.4; every Safari before that
 * has the whole thing under `webkit`, including the *event name*. Reading only
 * the standard names is what made the fullscreen button do nothing on a Mac:
 * `requestFullscreen` looked absent, so `detectFullscreenMode` fell through to
 * the iOS video-only path, and `webkitEnterFullscreen()` on a MediaStream-backed
 * <video> throws — into a `catch` that said nothing.
 *
 * iOS Safari has no Element.requestFullscreen under either name; the only
 * fullscreen it offers is the video element's own webkit method, which is what
 * the `video` mode below is for.
 */
interface WebkitFullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

interface WebkitFullscreenDocument extends Document {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}

function fullscreenDocument(): WebkitFullscreenDocument {
  return document as WebkitFullscreenDocument;
}

/** Whatever is fullscreen right now, under either spelling. */
function currentFullscreenElement(): Element | null {
  const doc = fullscreenDocument();
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/**
 * Ask for fullscreen and *report the answer*.
 *
 * Both spellings return a promise that rejects when the browser refuses —
 * permissions policy, an iframe without `allowfullscreen`, a gesture the
 * browser did not count. The previous version threw that promise away with
 * `void`, which is the difference between "fullscreen is blocked here" and a
 * button that appears broken.
 */
async function requestElementFullscreen(element: HTMLElement): Promise<void> {
  const webkit = element as WebkitFullscreenElement;
  if (typeof element.requestFullscreen === "function") {
    await element.requestFullscreen();
    return;
  }
  if (typeof webkit.webkitRequestFullscreen === "function") {
    await webkit.webkitRequestFullscreen();
    return;
  }
  throw new Error("no element fullscreen API");
}

async function exitDocumentFullscreen(): Promise<void> {
  const doc = fullscreenDocument();
  if (typeof doc.exitFullscreen === "function") {
    await doc.exitFullscreen();
    return;
  }
  await doc.webkitExitFullscreen?.();
}

interface ScreenShareViewProps {
  stream: MediaStream | null;
  presenterName: string;
  isSelf: boolean;
  onStopSharing?: () => void;
  /**
   * `panel` is the standalone stage (today's chrome). `tile` sits inside
   * ScreenStage, which already owns the outer height.
   */
  variant?: "panel" | "tile";
  /**
   * In-page expansion, lifted to the parent so two shares cannot both cover the
   * viewport. Without this, expanding both tiles stacked one `fixed inset-0`
   * over the other and buried the lower one's exit control, which on an iPhone
   * (the only place `expand` is the mode) is a fullscreen you cannot leave.
   *
   * Omit both to keep the old uncontrolled behaviour.
   */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

export function ScreenShareView({
  stream,
  presenterName,
  isSelf,
  onStopSharing,
  variant = "panel",
  expanded,
  onExpandedChange,
}: ScreenShareViewProps) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Two separate truths. `elementFullscreen` belongs to the browser and only
  // ever arrives as an event; `expanded` is the in-page fallback and is the
  // parent's when the parent asked to own it.
  const [elementFullscreen, setElementFullscreen] = useState(false);
  const [localExpanded, setLocalExpanded] = useState(false);
  const controlledExpansion = onExpandedChange !== undefined;
  const isExpanded = controlledExpansion ? (expanded ?? false) : localExpanded;
  // `expand` until the refs exist, because it is the mode that needs no
  // platform support: the control is always safe to render, and the detector
  // below only ever upgrades it to real element fullscreen.
  const [fullscreenMode, setFullscreenMode] = useState<FullscreenMode>("expand");
  const [blocked, setBlocked] = useState(false);
  // One name for "this share fills the viewport", whichever route got it there.
  const isFullscreen =
    fullscreenMode === "element" ? elementFullscreen : isExpanded;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.srcObject = stream;
    if (stream) {
      void video.play().catch(() => {
        // Autoplay can be blocked until the page has been interacted with;
        // sharing/joining is itself an interaction, so this is rare.
      });
    }
  }, [stream]);

  useEffect(() => {
    const doc = fullscreenDocument();
    setFullscreenMode(
      detectFullscreenMode({
        // Safari before 16.4 answers only to the prefixed name; `undefined`
        // here means "unknown", which the probe treats as permitted.
        documentFullscreenEnabled:
          typeof document === "undefined"
            ? undefined
            : (doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled),
        requestFullscreen: containerRef.current?.requestFullscreen,
        webkitRequestFullscreen: (
          containerRef.current as WebkitFullscreenElement | null
        )?.webkitRequestFullscreen,
      }),
    );
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    const onFullscreenChange = () => {
      setElementFullscreen(currentFullscreenElement() === containerRef.current);
    };
    const onBegin = () => setElementFullscreen(true);
    const onEnd = () => {
      setElementFullscreen(false);
      // iOS's native player detaches a MediaStream on the way out, leaving the
      // inline element rendering nothing — the reported "blank video after
      // coming back from fullscreen". Reattaching the same stream and playing
      // again is the documented recovery, and both calls are no-ops anywhere
      // the detach did not happen, so this is safe to run unconditionally.
      const video = videoRef.current;
      if (video && video.srcObject) {
        const current = video.srcObject;
        video.srcObject = null;
        video.srcObject = current;
        void video.play().catch(() => {
          // The user can tap the frame; the stream itself is intact.
        });
      }
    };

    document.addEventListener("fullscreenchange", onFullscreenChange);
    // Safari before 16.4 fires only the prefixed event. Without this the
    // component never learns it is fullscreen, so the button keeps offering to
    // enter and the second click re-requests instead of exiting.
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
    video?.addEventListener("webkitbeginfullscreen", onBegin);
    video?.addEventListener("webkitendfullscreen", onEnd);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener(
        "webkitfullscreenchange",
        onFullscreenChange,
      );
      video?.removeEventListener("webkitbeginfullscreen", onBegin);
      video?.removeEventListener("webkitendfullscreen", onEnd);
    };
  }, []);

  // A refusal is an answer, and the user has to get one. Cleared on the next
  // attempt so a browser that recovers stops apologising.
  useEffect(() => {
    if (!blocked) {
      return;
    }
    const timer = setTimeout(() => setBlocked(false), 6000);
    return () => clearTimeout(timer);
  }, [blocked]);

  const toggleFullscreen = useCallback(() => {
    setBlocked(false);
    const setExpanded = (next: boolean) => {
      if (controlledExpansion) {
        onExpandedChange?.(next);
        return;
      }
      setLocalExpanded(next);
    };
    if (fullscreenMode === "element") {
      const container = containerRef.current;
      if (!container) {
        return;
      }
      const refused = (err: unknown) => {
        // The whole point of the change: a refused request used to be silent,
        // and "I clicked it and nothing happened" is not a report anyone can
        // act on.
        console.warn("[voice] fullscreen refused", err);
        setBlocked(true);
      };
      /**
       * Ask, then *check*, then fall back.
       *
       * An Electron shell whose embedder denies the `fullscreen` permission
       * never settles the promise at all, so a refusal arrives there as
       * silence rather than as an error — see `element-fullscreen.ts`. The
       * in-page expansion is the honest answer to a platform that will not do
       * the real thing, and it is the path an iPhone has always taken.
       */
      const enter = () => {
        void attemptElementFullscreen({
          request: () => requestElementFullscreen(container),
          isActive: () => currentFullscreenElement() === container,
          onRefusal: (err) =>
            console.warn("[voice] fullscreen refused", err),
        }).then((entered) => {
          if (entered) {
            return;
          }
          // Pinned for the session, not just for this press: with the mode
          // left on `element` the exit press would call `exitFullscreen` on a
          // document that is not fullscreen, and the panel would never come
          // back down.
          console.warn(
            "[voice] element fullscreen unavailable; expanding in page",
          );
          setFullscreenMode("expand");
          setExpanded(true);
        });
      };
      const active = currentFullscreenElement();
      if (active === container) {
        void exitDocumentFullscreen().catch(refused);
        return;
      }
      if (active) {
        // Another share owns the screen. Hand it over. The old test was "is
        // *anything* fullscreen?", which meant pressing the other tile's
        // button only ever dropped out of fullscreen instead of switching to
        // the screen the person actually asked for.
        void exitDocumentFullscreen().then(enter).catch(refused);
        return;
      }
      enter();
      return;
    }
    // `expand`: no platform call at all, so nothing can refuse it. The panel
    // grows to fill the viewport in the page. This is what an iPhone gets, and
    // it replaces handing the element to the OS media player, which cannot
    // render a MediaStream and showed a black rectangle instead.
    setExpanded(!isExpanded);
  }, [fullscreenMode, controlledExpansion, onExpandedChange, isExpanded]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex min-h-0 flex-col bg-ink",
        variant === "panel" && "shrink-0 border-b border-panel-hover",
        variant === "tile" && "h-full min-h-0",
        isFullscreen &&
          (fullscreenMode === "element"
            ? "h-screen max-h-none w-screen"
            : // In-page fullscreen. `fixed inset-0` rather than 100vh because
              // on an iPhone 100vh is taller than the visible area and puts the
              // exit control under Safari's toolbar, which is how a person gets
              // stuck in a fullscreen they cannot leave.
              "fixed inset-0 z-50 h-auto max-h-none w-auto"),
        !isFullscreen && variant === "panel" && "max-h-[45%] min-h-[160px]",
      )}
    >
      <div className="flex shrink-0 items-center justify-between px-3 py-1.5">
        <span className="truncate text-xs text-paper-muted">
          {isSelf
            ? t("voice.share.youPresenting")
            : t("voice.share.peerPresenting", { name: presenterName })}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {blocked && (
            <span role="status" className="truncate text-[11px] text-paper-muted">
              {t("voice.share.fullscreenBlocked", desktopContext())}
            </span>
          )}
          {isSelf && onStopSharing && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-[10px]"
              onClick={onStopSharing}
            >
              <ScreenShareOff className="h-3 w-3" aria-hidden="true" />
              {t("voice.share.stop")}
            </Button>
          )}
          {/* Always rendered: `expand` needs no platform support, so there is
              no browser left where this button would do nothing. */}
          {(
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={
                isFullscreen
                  ? t("voice.share.exitFullscreen")
                  : t("voice.share.fullscreen")
              }
              aria-pressed={isFullscreen}
              onClick={toggleFullscreen}
            >
              {isFullscreen ? (
                <Minimize2 className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" />
              )}
            </Button>
          )}
        </div>
      </div>
      <div className="relative min-h-0 flex-1 bg-black">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          onDoubleClick={toggleFullscreen}
          className="h-full w-full object-contain"
        />
        {!stream && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-paper-muted">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            <span className="text-xs">{t("voice.share.waiting")}</span>
          </div>
        )}
      </div>
    </div>
  );
}
