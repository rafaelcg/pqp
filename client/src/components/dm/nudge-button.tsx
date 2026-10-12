import { Vibrate } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { useTranslation } from "@/lib/i18n";
import {
  sendNudge,
  setNudgeTarget,
  useNudgeChannelState,
  useNudgeEnabled,
  type NudgeSendOptions,
  type NudgeSendOutcome,
} from "@/lib/nudge";
import { cn } from "@/lib/utils";

export interface NudgeButtonProps {
  /** The 1:1 conversation. The caller decides it is a 1:1 with a friend. */
  channelId: string;
  /** `transport.sendChat`. */
  send: NudgeSendOptions["send"];
  /** Read on click: a nudge is only worth sending while the socket is up. */
  isConnected: () => boolean;
  className?: string;
}

/**
 * "Chamar a atenção" in a DM header. Self-contained on purpose: everything it
 * shows comes from `lib/nudge.ts`, so it can move with whatever header the
 * conversation ends up with. It also registers itself as the target of the
 * `/nudge` command while it is on screen, which is what makes the command
 * exist exactly where the button does.
 *
 * Feedback, all transform/opacity:
 *  - press: the tile dips (scale) under the pointer;
 *  - in flight: the phone breathes (opacity) until the server answers;
 *  - landed: the phone rattles once, then the cooldown bar under it empties
 *    over the ten seconds the server will refuse another;
 *  - refused: the tile stays usable; the reason is a line under the log.
 */
/**
 * The send for one conversation, and its registration as the `/nudge` target
 * while it is mounted. Null while the flag is off or there is no eligible
 * conversation (the caller decides eligibility: a 1:1 with a friend, nobody
 * blocked). The header button uses it, and so does Modo 2005's window
 * toolbar, which replaces that header.
 */
export function useNudgeTrigger(
  channelId: string | null,
  send: NudgeSendOptions["send"],
  isConnected: () => boolean,
): (() => NudgeSendOutcome) | null {
  const enabled = useNudgeEnabled();
  const trigger = useCallback(
    () =>
      channelId
        ? sendNudge(channelId, { send, connected: isConnected() })
        : ("offline" as const),
    [channelId, send, isConnected],
  );
  useEffect(() => {
    if (!enabled || !channelId) {
      return;
    }
    setNudgeTarget({ channelId, trigger });
    return () => setNudgeTarget(null);
  }, [enabled, channelId, trigger]);
  return enabled && channelId ? trigger : null;
}

export function NudgeButton({ channelId, send, isConnected, className }: NudgeButtonProps) {
  const { t } = useTranslation();
  const enabled = useNudgeEnabled();
  const state = useNudgeChannelState(channelId);
  const [now, setNow] = useState(() => Date.now());
  const cooling = state.cooldownUntil > now;
  const remainingMs = Math.max(0, state.cooldownUntil - now);

  // A one-second tick only while cooling, for the tooltip's countdown and to
  // put the tile back the moment the wait is over.
  useEffect(() => {
    if (state.cooldownUntil <= Date.now()) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= state.cooldownUntil) {
        window.clearInterval(timer);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [state.cooldownUntil]);

  const trigger = useNudgeTrigger(channelId, send, isConnected);

  // The rattle plays once per landing since this button mounted: the icon is
  // keyed on the counter, so each landing remounts it and replays the
  // animation, and coming back to a conversation does not replay an old one.
  const [landedAtMount] = useState(state.landed);
  const wiggle = state.landed > landedAtMount;

  if (!enabled) {
    return null;
  }

  const seconds = Math.ceil(remainingMs / 1000);
  const label = cooling
    ? t("nudge.actionCooldown", { seconds })
    : t("nudge.action");

  return (
    <Tooltip label={label}>
      <button
        type="button"
        data-testid="nudge-button"
        data-state={state.pending ? "pending" : cooling ? "cooldown" : "ready"}
        aria-label={t("nudge.action")}
        aria-disabled={state.pending || cooling ? true : undefined}
        aria-busy={state.pending ? true : undefined}
        className={cn(
          "relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md text-paper-muted",
          "transition-[transform,opacity] duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
          "hover:bg-ink-3 hover:text-paper active:scale-90",
          "motion-reduce:transition-none motion-reduce:active:scale-100",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset",
          cooling && "opacity-60",
          className,
        )}
        onClick={() => {
          trigger?.();
        }}
      >
        <Vibrate
          key={state.landed}
          aria-hidden
          className={cn(
            "h-4 w-4",
            state.pending && "nudge-pending",
            wiggle && "nudge-wiggle",
          )}
        />
        {cooling ? (
          // Remounted per cooldown so the bar starts full each time.
          <CooldownBar key={state.cooldownUntil} until={state.cooldownUntil} />
        ) : null}
      </button>
    </Tooltip>
  );
}

/**
 * The wait, emptying. Its duration is read once, when this cooldown starts:
 * changing `animation-duration` on a running animation would make it jump.
 */
function CooldownBar({ until }: { until: number }) {
  const [durationMs] = useState(() => Math.max(0, until - Date.now()));
  return (
    <span
      aria-hidden
      data-testid="nudge-cooldown-bar"
      className="nudge-cooldown-bar pointer-events-none absolute inset-x-1.5 bottom-1 h-0.5 rounded-full bg-warning"
      style={{ animationDuration: `${durationMs}ms` }}
    />
  );
}
