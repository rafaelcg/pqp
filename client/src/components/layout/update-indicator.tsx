import {
  ArrowClockwise,
  ArrowsClockwise,
  CheckCircle,
  DownloadSimple,
  WarningCircle,
} from "@phosphor-icons/react";
import {
  CircleAlert,
  CircleCheck,
  Download,
  Info,
  RefreshCw,
  RotateCw,
  TriangleAlert,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { POPOVER_SURFACE } from "@/components/ui/popover";
import { useApplyUpdate } from "@/hooks/use-apply-update";
import { useInCall, useWatchingParty } from "@/lib/in-call-state";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import {
  fetchChanges,
  summarizeChanges,
  type ChangeEntry,
} from "@/lib/update-changes";
import { RUNNING_BUILD } from "@/lib/build-info";
import {
  desktopUpdateBridge,
  updatePhase,
  useDesktopUpdate,
  type UpdatePhase,
} from "@/lib/desktop-update";
import type { DesktopUpdateBridge } from "@/lib/desktop";
import {
  getBuildStaleness,
  setUpdateAsked,
  useBuildStaleness,
  useUpdateOffered,
} from "@/lib/update-prompt-state";
import { checkVersionNow } from "@/lib/version-watch";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/**
 * "A new version is ready", said quietly: a small round button with a dot, and
 * a popover when somebody clicks it. Nothing here opens by itself, blocks the
 * screen or reloads the page.
 *
 * It replaces the corner card and the lime strip across the top of a call. A
 * card is an interruption, and on 2026-10-13 a person was shown one every few
 * seconds (nineteen web deploys in a day, every one announced to every open
 * window, `lib/client-version.ts` for the new cadence). The pattern is the one a
 * desktop app uses for its own updates: an icon in the corner of the chrome, a
 * dot to say there is something, a compact "what's new" if you ask.
 *
 * Where it sits: at the foot of the server rail (`variant="rail"`), and on the
 * phone's "tu" screen and tab (`variant="row"`), where there is no rail. It is
 * there for exactly as long as there is something to take, so it is never
 * decoration. With `client_force_update` on (an operator pushing a fix) it is
 * drawn filled and its dot pulses (not under reduced motion); it still does not
 * open by itself.
 *
 * On the rail it is ALWAYS there (`always`), the way T3 Code's update pill is:
 * up to date (a click checks again), an update to download (desktop shell), a
 * download with its progress ring, ready (a click opens this popover, whose
 * button reloads the page or restarts the shell), or a failure to retry. The
 * shell's half comes from `lib/desktop-update.ts`; on the web there is no
 * download step, because the service worker has already fetched the new build
 * by the time the page knows of it. The daily gate still decides when a new
 * build is ANNOUNCED; somebody who presses "check again" is shown what is there.
 *
 * Applying it is the same ladder the card used (`useApplyUpdate`), so a failure
 * hands the button back with the reason. In a call, or while watching a live
 * party, the popover says the update waits and what updating NOW would cost (a
 * reload ends a call and a screen share, a browser cannot restore a capture
 * without the picker), and asks twice.
 */

const POPOVER_WIDTH = 320;
/** A check that answers at once still shows its spin for this long. */
const MIN_CHECK_MS = 700;
const EDGE = 8;
const GAP = 10;

export interface PopoverBox {
  left: number;
  top: number;
}

/**
 * Where the popover goes: beside the button on the side with room (right of a
 * rail, above or below a row), clamped inside the window. Pure, so the one
 * layout rule that has a failure mode (a popover half off the screen on a
 * phone) is pinned by a test.
 */
export function placePopover(
  anchor: { left: number; top: number; right: number; bottom: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  side: "right" | "below" | "above",
): PopoverBox {
  let left: number;
  let top: number;
  if (side === "right") {
    left = anchor.right + GAP;
    // The rail is at the bottom of the window: line the popover's bottom edge
    // up with the button so it grows upward, into the room there is.
    top = anchor.bottom - size.height;
  } else if (side === "above") {
    left = anchor.left;
    top = anchor.top - GAP - size.height;
  } else {
    left = anchor.left;
    top = anchor.bottom + GAP;
  }
  left = Math.max(EDGE, Math.min(left, viewport.width - size.width - EDGE));
  top = Math.max(EDGE, Math.min(top, viewport.height - size.height - EDGE));
  return { left, top };
}

/** "13 Oct, 09:12" in the person's own language and time zone. */
export function formatPublished(at: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(at));
  } catch {
    return new Date(at).toISOString();
  }
}

export function UpdateIndicator({
  variant = "rail",
  always = false,
  onOpenWhatsNew,
  apply,
  shellBridge,
  className,
}: {
  /** `rail`: the server rail. `row`: the phone's screen headers. `corner`: a fixed corner, for pages with no rail (the landing page). */
  variant?: "rail" | "row" | "corner";
  /** Drawn with nothing to take too ("up to date", a click checks). The rail. */
  always?: boolean;
  /** The in-app release notes; without it the link goes to `/blog`. */
  onOpenWhatsNew?: () => void;
  /** Test seam: the real ladder navigates away. */
  apply?: (target: string | null) => Promise<unknown>;
  /** Test seam: the shell's updater bridge. Default: `window.pqpDesktop.update`. */
  shellBridge?: DesktopUpdateBridge | null;
  className?: string;
}) {
  const { t, locale } = useTranslation();
  const offered = useUpdateOffered();
  const build = useBuildStaleness();
  const inCall = useInCall();
  const watching = useWatchingParty();
  const { state: applying, start } = useApplyUpdate(apply);
  const [bridge] = useState(() =>
    shellBridge === undefined ? desktopUpdateBridge() : shellBridge,
  );
  const shell = useDesktopUpdate(bridge);
  const [checking, setChecking] = useState(false);
  const [restartFailed, setRestartFailed] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const phase: UpdatePhase = updatePhase({
    shell,
    webOffered: offered,
    webUrgent: build.forced || Boolean(build.critical),
    checking,
  });
  const ready = phase.kind === "ready";

  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [changes, setChanges] = useState<ChangeEntry[] | null>(null);
  const [box, setBox] = useState<PopoverBox | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    setConfirming(false);
    if (returnFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  // The list is read when somebody asks, never on a poll: most people who see
  // the dot never open it, and the file is small but it is not free.
  useEffect(() => {
    if (!open || changes !== null) {
      return;
    }
    let live = true;
    void fetchChanges().then((entries) => {
      if (live) {
        setChanges(entries);
      }
    });
    return () => {
      live = false;
    };
  }, [open, changes]);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const next = placePopover(
      rect,
      { width: panel.offsetWidth, height: panel.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      variant === "rail" ? "right" : variant === "corner" ? "above" : "below",
    );
    setBox((prev) =>
      prev && prev.left === next.left && prev.top === next.top ? prev : next,
    );
  }, [variant]);

  // Measured before paint, so the panel never shows at the wrong place first.
  // Again when its own height moves (the list arrives, a state line appears).
  useLayoutEffect(() => {
    if (!open) {
      setBox(null);
      return;
    }
    place();
    const panel = panelRef.current;
    const observer =
      typeof ResizeObserver === "undefined" || !panel
        ? null
        : new ResizeObserver(place);
    if (panel) {
      observer?.observe(panel);
    }
    window.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [open, place, changes, inCall, watching, confirming, applying.status]);

  // Escape and a press outside close it. A popover somebody opened is theirs to
  // put away, and neither an onboarding card nor a call may do it for them.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        (panelRef.current?.contains(target) || triggerRef.current?.contains(target))
      ) {
        return;
      }
      close(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open, close]);

  // Gone with the update: nothing left to take, so nothing to show.
  useEffect(() => {
    if (!ready) {
      setOpen(false);
      setConfirming(false);
    }
  }, [ready]);

  const checkNow = useCallback(() => {
    setChecking(true);
    const started = Date.now();
    void Promise.allSettled([
      checkVersionNow(),
      bridge ? bridge.check() : Promise.resolve(true),
    ]).then(() => {
      setUpdateAsked(getBuildStaleness().latestBuild);
      const left = MIN_CHECK_MS - (Date.now() - started);
      setTimeout(() => setChecking(false), Math.max(0, left));
    });
  }, [bridge]);

  if (!ready && !always) {
    return null;
  }

  const viaShell = phase.kind === "ready" && phase.via === "shell";

  const emphasised = ready && !viaShell && (build.forced || Boolean(build.critical));
  const busy = inCall || watching;
  const summary =
    changes === null
      ? null
      : summarizeChanges(changes, RUNNING_BUILD.builtAt, locale);
  const published = build.builtAt ?? build.since;
  const label =
    phase.kind === "ready"
      ? viaShell
        ? t("update.button.readyShell")
        : emphasised
          ? t("update.indicator.labelUrgent")
          : t("update.indicator.label")
      : phase.kind === "checking"
        ? t("update.button.checking")
        : phase.kind === "available"
          ? t("update.button.available", { version: phase.version })
          : phase.kind === "downloading"
            ? t("update.button.downloading", { percent: phase.percent })
            : phase.kind === "error"
              ? phase.context === "download"
                ? t("update.button.errorDownload")
                : t("update.button.errorCheck")
              : t("update.button.current");

  const busyKey: MessageKey = inCall
    ? viaShell
      ? "update.popover.inCallShell"
      : "update.popover.inCall"
    : viaShell
      ? "update.popover.watchingShell"
      : "update.popover.watching";
  const busyWarnKey: MessageKey = inCall
    ? viaShell
      ? "update.popover.inCallShellWarn"
      : "update.popover.inCallWarn"
    : viaShell
      ? "update.popover.watchingShellWarn"
      : "update.popover.watchingWarn";

  const updating = viaShell ? restarting : applying.status === "updating";
  const failed = viaShell ? restartFailed : applying.status === "error";
  const apply_ = () => {
    if (!viaShell) {
      start(build.latestBuild);
      return;
    }
    setRestartFailed(false);
    setRestarting(true);
    void Promise.resolve(bridge?.install()).then(
      (ok) => {
        if (ok !== true) {
          setRestarting(false);
          setRestartFailed(true);
        }
      },
      () => {
        setRestarting(false);
        setRestartFailed(true);
      },
    );
  };

  const onTrigger = () => {
    if (ready) {
      if (open) {
        close();
      } else {
        setOpen(true);
      }
      return;
    }
    if (phase.kind === "available" || (phase.kind === "error" && phase.context === "download")) {
      void bridge?.download();
      return;
    }
    if (phase.kind === "current" || phase.kind === "error") {
      checkNow();
    }
  };

  const dotted = ready || phase.kind === "available";
  const glyph = (() => {
    switch (phase.kind) {
      case "ready":
        return viaShell
          ? { off: RotateCw, on: ArrowClockwise, spin: false }
          : { off: Download, on: DownloadSimple, spin: false };
      case "available":
      case "downloading":
        return { off: Download, on: DownloadSimple, spin: false };
      case "checking":
        return { off: RefreshCw, on: ArrowsClockwise, spin: true };
      case "error":
        return { off: CircleAlert, on: WarningCircle, spin: false };
      default:
        return { off: CircleCheck, on: CheckCircle, spin: false };
    }
  })();
  const Off = glyph.off;

  return (
    <>
      <Tooltip label={label} side={variant === "rail" ? "right" : variant === "corner" ? "top" : "bottom"} tone="rail">
        <button
          ref={triggerRef}
          type="button"
          data-update-indicator=""
          data-update-phase={phase.kind}
          data-update-emphasis={emphasised ? "" : undefined}
          aria-label={label}
          aria-haspopup={ready ? "dialog" : undefined}
          aria-expanded={ready ? open : undefined}
          aria-busy={phase.kind === "checking" || phase.kind === "downloading" ? true : undefined}
          disabled={phase.kind === "checking" || phase.kind === "downloading"}
          onClick={onTrigger}
          className={cn(
            "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
            emphasised
              ? "bg-accent text-on-accent hover:bg-accent-hover"
              : "bg-surface-2 text-text-secondary hover:bg-border hover:text-text disabled:hover:bg-surface-2 disabled:hover:text-text-secondary",
            open && !emphasised && "bg-border text-text",
            // On the rail it is a small tile like the ones above it.
            variant === "rail" &&
              !emphasised &&
              "redesign:bg-[color:var(--rail-tile-bg)] redesign:hover:bg-[color:var(--rail-tile-hover)]",
            // The rail's focus ring, urgent or not: the text colour with a gap.
            variant === "rail" &&
              "redesign:focus-visible:ring-text redesign:focus-visible:ring-offset-2 redesign:focus-visible:ring-offset-canvas",
            // Every door on the rail is one tile size, this one too.
            variant === "rail" && "redesign:h-[var(--rail-tile)] redesign:w-[var(--rail-tile)]",
            variant === "rail" && open && !emphasised && "redesign:bg-[color:var(--rail-tile-hover)]",
            className,
          )}
        >
          <Off
            className={cn(
              "h-4 w-4 redesign:hidden",
              glyph.spin && "motion-safe:animate-spin",
            )}
            aria-hidden="true"
          />
          <Icon
            icon={glyph.on}
            kind="symbol"
            size="sm"
            className={cn("hidden redesign:block", glyph.spin && "motion-safe:animate-spin")}
          />
          {phase.kind === "downloading" && <ProgressRing percent={phase.percent} />}
          {dotted && (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5"
          >
            {emphasised && (
              <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-60 motion-safe:animate-ping redesign:motion-safe:animate-none" />
            )}
            <span
              className={cn(
                "relative inline-flex h-2.5 w-2.5 rounded-full ring-2",
                variant === "rail" ? "ring-rail redesign:ring-canvas" : "ring-surface-1",
                emphasised ? "bg-on-accent ring-accent" : "bg-accent",
              )}
            />
          </span>
          )}
        </button>
      </Tooltip>

      {open && ready &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-labelledby={titleId}
            data-update-popover=""
            style={{
              width: `min(${POPOVER_WIDTH}px, calc(100vw - ${EDGE * 2}px))`,
              left: box?.left ?? 0,
              top: box?.top ?? 0,
              visibility: box ? "visible" : "hidden",
            }}
            className={cn(POPOVER_SURFACE, "fixed z-[100] p-4 text-text animate-pop-in")}
          >
            <div className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-on-accent-soft"
              >
                <Download className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <h2 id={titleId} className="text-sm font-semibold leading-5">
                  {t("update.popover.title")}
                </h2>
                {published ? (
                  <p className="text-xs text-text-tertiary">
                    {t("update.popover.published", {
                      when: formatPublished(published, locale),
                    })}
                  </p>
                ) : null}
              </div>
            </div>

            <section className="mt-3" aria-label={t("update.popover.changes")}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">
                {t("update.popover.changes")}
              </h3>
              {summary === null ? (
                <p className="mt-1.5 text-sm text-text-tertiary">…</p>
              ) : (
                <>
                  {summary.lines.length > 0 && (
                    <ul className="mt-1.5 space-y-1.5 text-sm text-text-secondary">
                      {summary.lines.map((line) => (
                        <li key={line} className="flex gap-2">
                          <span
                            aria-hidden="true"
                            className="mt-2 h-1 w-1 shrink-0 rounded-full bg-text-tertiary"
                          />
                          <span className="min-w-0">{line}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {summary.lines.length === 0 ? (
                    // Nothing was written for this person in their language (or
                    // the list could not be read): say what is honestly true.
                    <p className="mt-1.5 text-sm text-text-tertiary">
                      {t("update.popover.onlySmall")}
                    </p>
                  ) : (
                    summary.more > 0 && (
                      <p className="mt-1.5 text-sm text-text-tertiary">
                        {t("update.popover.andMore", { count: summary.more })}
                      </p>
                    )
                  )}
                </>
              )}
              {onOpenWhatsNew ? (
                <button
                  type="button"
                  className="mt-2 text-sm text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  onClick={() => {
                    close(false);
                    onOpenWhatsNew();
                  }}
                >
                  {t("update.popover.more")}
                </button>
              ) : (
                <a
                  href="/blog"
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block text-sm text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  {t("update.popover.more")}
                </a>
              )}
            </section>

            <div className="mt-4 space-y-3">
              {busy && (
                <p
                  data-update-busy=""
                  className="flex gap-2 rounded-[var(--radius-control)] bg-surface-1 p-2.5 text-sm text-text-secondary"
                >
                  <Info
                    className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary"
                    aria-hidden="true"
                  />
                  <span>{t(busyKey)}</span>
                </p>
              )}

              {failed && (
                <p role="alert" className="text-sm text-danger">
                  {viaShell
                    ? t("update.error.restart")
                    : applying.status === "error" && applying.reason === "offline"
                      ? t("update.error.offline")
                      : t("update.error.failed")}
                </p>
              )}

              {!busy && (
                <Button
                  className="w-full"
                  disabled={updating}
                  data-testid="update-indicator-apply"
                  onClick={apply_}
                >
                  {updating ? (
                    <Spinner className="h-4 w-4 motion-safe:animate-spin" />
                  ) : null}
                  {updating
                    ? t("update.updating")
                    : failed
                      ? t("update.retry")
                      : viaShell
                        ? t("update.popover.restart")
                        : t("update.popover.apply")}
                </Button>
              )}

              {busy && !confirming && !updating && (
                <Button
                  variant="secondary"
                  className="w-full"
                  data-testid="update-indicator-now"
                  onClick={() => setConfirming(true)}
                >
                  {viaShell ? t("update.popover.restartNow") : t("update.popover.applyNow")}
                </Button>
              )}

              {busy && (confirming || updating) && (
                <div
                  data-update-confirm=""
                  className="space-y-2 rounded-[var(--radius-control)] border border-border p-2.5"
                >
                  <p className="flex gap-2 text-sm text-text">
                    <TriangleAlert
                      className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                      aria-hidden="true"
                    />
                    <span>{t(busyWarnKey)}</span>
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="danger"
                      size="sm"
                      className="flex-1"
                      disabled={updating}
                      data-testid="update-indicator-confirm"
                      onClick={apply_}
                    >
                      {updating
                        ? t("update.updating")
                        : failed
                          ? t("update.retry")
                          : viaShell
                            ? t("update.popover.confirmRestart")
                            : t("update.popover.confirm")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={updating}
                      onClick={() => setConfirming(false)}
                    >
                      {t("update.popover.keep")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/** The download's progress around the button, like T3 Code's pill. */
function ProgressRing({ percent }: { percent: number }) {
  const radius = 16;
  const length = 2 * Math.PI * radius;
  const shown = Math.max(0, Math.min(100, percent));
  return (
    <svg
      aria-hidden="true"
      data-update-progress={shown}
      viewBox="0 0 36 36"
      className="pointer-events-none absolute inset-0 h-full w-full -rotate-90"
    >
      <circle cx="18" cy="18" r={radius} fill="none" strokeWidth="2" className="stroke-border" />
      <circle
        cx="18"
        cy="18"
        r={radius}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={length}
        strokeDashoffset={length * (1 - shown / 100)}
        className="stroke-accent transition-[stroke-dashoffset] duration-[var(--duration-fast)] motion-reduce:transition-none"
      />
    </svg>
  );
}
