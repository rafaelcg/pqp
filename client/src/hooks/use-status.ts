import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_MANUAL_STATUS,
  IDLE_AFTER_MS,
  type ManualStatus,
  type UserStatus,
} from "@pqp/shared";
import { fetchMe, updatePreferences } from "@/lib/api";
import { translateMessage } from "@/lib/i18n";
import { setDoNotDisturb } from "@/lib/notifications";

/**
 * The account's own status: the manual choice it can make, and the idle signal
 * only a client can produce.
 *
 * WHY IDLE IS DETECTED HERE AND NOWHERE ELSE. The server sees a socket that
 * answers heartbeats. That is true of a laptop somebody is typing on and of one
 * that has been shut in a bag since lunch, so there is nothing server-side to
 * infer it from. Real input events exist only in this process, which makes the
 * browser the only honest source — and the reason `idle` is reported rather than
 * derived.
 */

/** Events that count as "somebody is at this machine". */
const ACTIVITY_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "touchstart",
  "focus",
] as const;

/**
 * Coalesce the raw event storm. `pointermove` alone fires hundreds of times a
 * second; without this the timer would be rescheduled on every one of them, for
 * no change in outcome.
 */
const ACTIVITY_SAMPLE_MS = 1_000;

export interface StatusControls {
  /** What this account chose. May be `invisible`, which only it ever sees. */
  manual: ManualStatus;
  /** What everybody else is being told right now, including derived idle. */
  effective: UserStatus;
  /** A write is in flight. The picker disables itself rather than lying. */
  saving: boolean;
  /** Set when the write failed and `manual` was rolled back to the truth. */
  error: string | null;
  setManual: (next: ManualStatus) => void;
  /**
   * Adopt a choice another tab or device of this account just made, as told by
   * the server's `own-status` frame. Never writes anything back.
   */
  adoptRemote: (next: ManualStatus) => void;
}

export interface UseUserStatusOptions {
  /**
   * The stored choice from `/api/me`, or null before bootstrap resolves. The
   * server's copy wins on read: another device may have changed it since.
   */
  stored: ManualStatus | null;
  /** Sends `set-idle` over the chat socket. */
  sendIdle: (idle: boolean) => void;
  /**
   * Whether the realtime link is up. Load-bearing, not cosmetic — see the
   * re-report effect below.
   */
  connected: boolean;
}

export function useUserStatus({
  stored,
  sendIdle,
  connected,
}: UseUserStatusOptions): StatusControls {
  const [manual, setManualState] = useState<ManualStatus>(
    DEFAULT_MANUAL_STATUS,
  );
  const [idle, setIdle] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Adopt the stored value once it lands. Only when nothing is in flight: a
  // person who opened the app and immediately picked "invisible" must not have
  // that overwritten by the `/api/me` response that was already on its way.
  const savingRef = useRef(false);
  useEffect(() => {
    if (stored && !savingRef.current) {
      setManualState(stored);
    }
  }, [stored]);

  // The half of DND the person who set it actually feels. Driven off `manual`
  // rather than off the picker's click handler so it is equally true when the
  // value arrived from another device via `/api/me`, and so a rolled-back write
  // takes the suppression back with it.
  useEffect(() => {
    setDoNotDisturb(manual === "dnd");
    return () => setDoNotDisturb(false);
  }, [manual]);

  // ------------------------------------------------------------ idle
  const sendIdleRef = useRef(sendIdle);
  sendIdleRef.current = sendIdle;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSeen = 0;

    const goIdle = () => {
      timer = null;
      setIdle(true);
      sendIdleRef.current(true);
    };

    const arm = () => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(goIdle, IDLE_AFTER_MS);
    };

    const onActivity = () => {
      const now = Date.now();
      if (now - lastSeen < ACTIVITY_SAMPLE_MS) {
        return;
      }
      lastSeen = now;
      setIdle((wasIdle) => {
        if (wasIdle) {
          // Only a transition is announced. A frame per event, or per timer
          // tick, would put a stream of no-ops on a socket shared with chat.
          sendIdleRef.current(false);
        }
        return false;
      });
      arm();
    };

    // A tab the user switched away from is not activity, but it is not idle
    // either — plenty of people leave the app in a background tab and are very
    // much at their desk. Only the inactivity timer decides, so hiding the tab
    // just stops resetting it.
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, onActivity, { passive: true });
    }
    arm();

    return () => {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, onActivity);
      }
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, []);

  /**
   * Re-report idle after a reconnect.
   *
   * The server deliberately scopes idle to the socket that reported it, so a
   * dropped connection forgets it — which is right (a socket that is gone proves
   * nothing) and means a client that was already idle when the link flapped
   * would come back reading as online, and stay that way until the next time
   * somebody touched the machine. Which, being idle, they are not about to do.
   */
  useEffect(() => {
    if (connected && idle) {
      sendIdle(true);
    }
    // `sendIdle` is intentionally out of the deps: it is re-created per render
    // in the caller, and including it would re-fire this on every render. The
    // pair that actually means "re-announce" is (connected, idle).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, idle]);

  // ----------------------------------------------------------- manual
  /**
   * `own-status` frames that arrived while this tab's own write was in flight.
   *
   * Not applied on arrival: the server sends the frame to every socket of the
   * account, this one included, so one of them is usually the echo of the very
   * write in flight, and adopting it mid-save would fight the optimistic value.
   * Not dropped either: one of them may be another device's choice, and nothing
   * would ever correct this tab if it were thrown away. They are reconciled
   * once the write settles, in `reconcileAfterSave`.
   */
  const heldRemoteRef = useRef<ManualStatus[]>([]);
  /**
   * Bumped on every remote adoption and every local save, so an older refetch
   * can tell it lost to either.
   */
  const choiceGenerationRef = useRef(0);

  const adoptRemote = useCallback((next: ManualStatus) => {
    if (savingRef.current) {
      heldRemoteRef.current.push(next);
      return;
    }
    choiceGenerationRef.current += 1;
    setManualState(next);
  }, []);

  /**
   * Settle a finished write against whatever the other devices said meanwhile.
   *
   * Frames that all agree with the value this tab settled on are the echo of
   * its own write (or another device picking the same thing): nothing to do,
   * and no request. A frame that disagrees means two devices wrote at once, and
   * which one Postgres kept cannot be read off arrival order here, because the
   * echo of this tab's write and the other device's frame can reach this socket
   * in either order. So the stored value is read back and wins. If that read
   * fails, the newest frame this socket was sent is the best evidence left.
   */
  const reconcileAfterSave = useCallback((settled: ManualStatus) => {
    const held = heldRemoteRef.current;
    heldRemoteRef.current = [];
    if (held.every((value) => value === settled)) {
      return;
    }
    const latestHeld = held[held.length - 1]!;
    const generation = choiceGenerationRef.current;
    // A newer frame or a newer save of this tab's own has a fresher answer
    // than this read, which was issued before either of them. Checking that no
    // save is in flight is not enough: a save can start and settle while this
    // read is still on the wire, and then nothing would be in flight.
    const stillCurrent = () => choiceGenerationRef.current === generation;
    void fetchMe()
      .then((me) => {
        if (stillCurrent()) {
          setManualState(me.preferences?.status ?? DEFAULT_MANUAL_STATUS);
        }
      })
      .catch(() => {
        if (stillCurrent()) {
          setManualState(latestHeld);
        }
      });
  }, []);

  const setManual = useCallback(
    (next: ManualStatus) => {
      setError(null);
      if (next === manual) {
        return;
      }
      const previous = manual;
      // Optimistic, then rolled back — but the write is awaited and its failure
      // is *shown*. This is the one preference in the app that must not be
      // fire-and-forget: "I clicked invisible, the request failed, nobody told
      // me" is somebody believing they are hidden while they are not, which is
      // worse than never having offered the control.
      setManualState(next);
      setSaving(true);
      savingRef.current = true;
      choiceGenerationRef.current += 1;
      heldRemoteRef.current = [];
      let settled: ManualStatus = previous;
      void updatePreferences({ status: next })
        .then((response) => {
          // Trust the server's merged copy over what was sent, so a value it
          // rejected or normalised never lingers on screen.
          settled = response.preferences.status ?? DEFAULT_MANUAL_STATUS;
          setManualState(settled);
        })
        .catch(() => {
          settled = previous;
          setManualState(previous);
          setError(translateMessage("status.saveFailed"));
        })
        .finally(() => {
          setSaving(false);
          savingRef.current = false;
          reconcileAfterSave(settled);
        });
    },
    [manual, reconcileAfterSave],
  );

  return {
    manual,
    effective: resolveOwnStatus(manual, idle),
    saving,
    error,
    setManual,
    adoptRemote,
  };
}

/**
 * The client's copy of the server's resolution rule, for the dot next to your
 * own name. It has to agree with `externalStatus` in server/src/ws/status.ts:
 * `invisible` reads as `offline`, a manual choice beats the inactivity timer,
 * and only the absence of a connection is really offline.
 *
 * Exported for the test that pins it against the server's table.
 */
export function resolveOwnStatus(
  manual: ManualStatus,
  idle: boolean,
): UserStatus {
  if (manual === "invisible") {
    return "offline";
  }
  if (manual === "dnd") {
    return "dnd";
  }
  // A declaration, not a measurement: stays idle whether or not the timer
  // would have cleared it. See `packages/shared/src/status.ts` for why this
  // is a fourth manual value rather than a manual idle.
  if (manual === "away") {
    return "idle";
  }
  return idle ? "idle" : "online";
}
