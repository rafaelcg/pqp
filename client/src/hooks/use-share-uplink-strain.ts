import { useEffect, useRef, useState } from "react";
import {
  describeLimitationAgainst,
  sampleVoiceStats,
  type VideoSenderSample,
} from "@/lib/voice-stats-probe";
import { chosenScreenCeilingBps } from "@/lib/peer-connection-manager";
import { DEFAULT_SCREEN_UPLOAD_BUDGET_BPS } from "@/lib/screen-upload-budget";
import type { VideoQuality } from "@/lib/video-quality";

/**
 * Is this machine's own screen share being held back by its own uplink, for
 * long enough to be worth saying out loud?
 *
 * WHY THIS EXISTS. Every quality complaint this product gets is adjectival:
 * "a qualidade tá péssima". The app already knew the answer and kept it in a
 * drawer. `describeLimitation` has been able to say "your connection" versus
 * "your quality setting" versus "this computer" since 25 Aug, and
 * `OutboundVideoReadout` prints it, but only inside the video quality menu and
 * the Settings dialog. Nobody experiencing a bad share opens a menu to read a
 * diagnostic; they open the chat and say the app is bad. This is the same
 * lesson as PR #319, where per-peer volume had shipped months earlier and a
 * moderator still could not find it, because it was revealed by hover.
 *
 * So this hook is not new measurement. It is the existing measurement, made
 * to speak unprompted, at the one moment it is true.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *
 *  - It never blames the connection for a share sitting on the ceiling the
 *    user chose. That distinction is `describeLimitation`'s whole job: the
 *    encoder reports `qualityLimitationReason: "bandwidth"` whenever *any*
 *    rate limit binds, including our own `maxBitrate`, so the raw field says
 *    "your connection" to somebody on fibre who simply picked 480p. Only a
 *    reading of `bandwidth` (target well under the ceiling) counts here.
 *  - It does not fire on a blip. A share ramps up from nothing, an ICE restart
 *    re-probes, someone else's arrival re-splits the budget: all of those show
 *    one or two limited samples and recover. The streak below is what keeps
 *    this from becoming wallpaper, and wallpaper is the failure mode that
 *    makes a warning worth less than no warning at all.
 *  - It says nothing to viewers about the sharer's uplink. A viewer's own
 *    machine cannot see the sender's limitation (`VideoReceiverSample` has no
 *    counterpart to it, and the comment there explains why: there is nothing
 *    on the receiving side that can make the picture bigger). Telling a viewer
 *    "your connection is bad" when the cause is the presenter's uplink would
 *    be false, and false in the direction that reads as an app deflecting
 *    blame. Naming the presenter to the room needs their limitation on the
 *    wire, which is a roster field and a server change; it is not this.
 */

/** Matches `OutboundVideoReadout`, so the two readings cannot drift apart. */
const SAMPLE_INTERVAL_MS = 2000;

/**
 * How many consecutive bandwidth-limited samples before this is said.
 *
 * Five, so about ten seconds. Long enough that the ramp-up at the start of
 * every share has finished and a one-off re-probe has recovered, short enough
 * that it still arrives while the person is looking at the bad picture rather
 * than after they have given up and gone to the chat.
 */
export const SUSTAINED_SAMPLES = 5;

/**
 * How far under the expected ceiling counts as "the budget cut this".
 *
 * The same 0.9 the rest of this machinery draws its lines at, and for the same
 * reason: the two numbers pass through kbps rounding and a re-split on the way
 * here, and a rounding difference is not a measured link.
 */
const CEILING_SLACK = 0.9;

/**
 * The streak after one sample, and the whole of the decision.
 *
 * Pure and exported so the rules can be tested as rules, with no React and no
 * clock, the way `createIdleChrome` is: the binding below is one `useEffect`
 * around this.
 */
export function nextStrainStreak(
  streak: number,
  screens: readonly VideoSenderSample[],
  chosenCeilingBps: number,
): number {
  // No sender yet is the first second of a share, not a fault. It resets
  // rather than holds, so a share that stops and restarts starts counting
  // again instead of inheriting the old share's grievance.
  const screen = screens[0];
  if (!screen) {
    return 0;
  }

  // THE OBVIOUS SIGNAL, AND WHY IT IS NOT ENOUGH ON ITS OWN. "The encoder says
  // it is bandwidth-limited" is true while the link is being discovered, and
  // then stops being true: once the budget controller has cut the ceiling to
  // fit the link, the encoder is handed a target it can actually meet and
  // reports `none`. Measured on the 1 Mbps harness run, the reading oscillated
  // between `bandwidth` and `none` every few seconds, so a streak built on
  // this alone reset before it could ever be said out loud. The adaptation
  // working must not be what silences the explanation for it.
  if (describeLimitationAgainst(screen, chosenCeilingBps) === "bandwidth") {
    return streak + 1;
  }

  // THE DURABLE SIGNAL. A ceiling well under what this person asked for, that
  // the room's own size does not account for, means one thing: the budget
  // controller measured this uplink and found less than the 5 Mbps it starts
  // by assuming. That state persists for as long as the link is weak, which
  // is exactly as long as the sentence is true.
  //
  // The room-size term is what keeps this honest. A mesh uploads one copy per
  // viewer, so a five-way call on fibre is legitimately capped at a fifth of
  // the budget, and calling that "your connection" would accuse the healthiest
  // link in the room. Only a ceiling below what the *starting* budget would
  // have allowed for this many viewers counts.
  const expected = Math.min(
    chosenCeilingBps,
    DEFAULT_SCREEN_UPLOAD_BUDGET_BPS / Math.max(1, screens.length),
  );
  const ceilingBps = (screen.ceilingKbps ?? 0) * 1000;
  const cutByBudget = ceilingBps > 0 && ceilingBps < expected * CEILING_SLACK;
  return cutByBudget ? streak + 1 : 0;
}

/** Whether a streak has gone on long enough to be worth saying. */
export function isStrained(streak: number): boolean {
  return streak >= SUSTAINED_SAMPLES;
}

export function useShareUplinkStrain(
  isSharing: boolean,
  quality: VideoQuality,
): boolean {
  const [strained, setStrained] = useState(false);
  const streak = useRef(0);

  useEffect(() => {
    if (!isSharing) {
      streak.current = 0;
      setStrained(false);
      return;
    }
    let live = true;
    // Polled, like every other consumer of this sampler: `getStats()` has no
    // change event to subscribe to.
    const tick = () => {
      void sampleVoiceStats().then((snapshot) => {
        if (!live) {
          return;
        }
        // Every screen row, not the first: in a mesh there is one per peer,
        // they all carry the same ceiling, and the count of them is how many
        // viewers the budget is being split between.
        const screens = snapshot.senders.filter(
          (sender) => sender.role === "screen",
        );
        streak.current = nextStrainStreak(
          streak.current,
          screens,
          chosenScreenCeilingBps(quality),
        );
        setStrained(isStrained(streak.current));
      });
    };
    tick();
    const id = setInterval(tick, SAMPLE_INTERVAL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [isSharing, quality]);

  return strained;
}
