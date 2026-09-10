import { useEffect, useRef, useState } from "react";
import {
  describeLimitation,
  describeLimitationAgainst,
  sampleVoiceStats,
  type VideoSenderSample,
} from "@/lib/voice-stats-probe";
import {
  chosenScreenCeilingBps,
  splitShare,
} from "@/lib/peer-connection-manager";
import { DEFAULT_SCREEN_UPLOAD_BUDGET_BPS } from "@/lib/screen-upload-budget";
import type { VideoQuality } from "@/lib/video-quality";
import type { VoiceRoomTransport } from "@pqp/shared";

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
 * lesson as PR 319, where per-peer volume had shipped months earlier and a
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
  viewers: number,
  /** What a camera on the same uplink asked for, in bps. 0 when it is off. */
  cameraChosenBps = 0,
): number {
  // No sender yet is the first second of a share, not a fault. It resets
  // rather than holds, so a share that stops and restarts starts counting
  // again instead of inheriting the old share's grievance.
  const screen = screens[0];
  if (!screen) {
    return 0;
  }

  // WHAT THIS ROOM MAY LEGITIMATELY SPEND ON THE SCREEN, before any link
  // trouble. A mesh sends one copy per viewer, and a camera on the same uplink
  // takes its own slice, so the honest expectation is neither the rung the
  // person picked nor the whole budget.
  //
  // BOTH BRANCHES BELOW ARE MEASURED AGAINST IT. An earlier cut applied the
  // camera term to the second branch only and left the first comparing against
  // the raw chosen rung, so a five-way call on Auto sharing a film with the
  // camera on sat pinned at a perfectly legitimate 2.67 Mbps ceiling and was
  // told its connection was the problem, on fibre, for the whole call. Found
  // in review; a ceiling the room and the camera explain is not a link fault
  // whichever branch notices it.
  // `splitShare`, not a second copy of its arithmetic. The two were written
  // out separately at first and had already drifted: this one lacked the 1:1
  // exemption, so a 1:1 call with a camera expected 3.08 Mbps where the
  // manager applied 4. Harmless in that direction, but two copies of one
  // formula is how the screen controller got four different models in a day.
  const expected = splitShare(
    viewers,
    chosenCeilingBps,
    cameraChosenBps,
    DEFAULT_SCREEN_UPLOAD_BUDGET_BPS,
  );

  // THE OBVIOUS SIGNAL, AND WHY IT IS NOT ENOUGH ON ITS OWN. "The encoder says
  // it is bandwidth-limited" is true while the link is being discovered, and
  // then stops being true: once the budget controller has cut the ceiling to
  // fit the link, the encoder is handed a target it can actually meet and
  // reports `none`. Measured on the 1 Mbps harness run, the reading oscillated
  // between `bandwidth` and `none` every few seconds, so a streak built on
  // this alone reset before it could ever be said out loud. The adaptation
  // working must not be what silences the explanation for it.
  if (describeLimitationAgainst(screen, expected) === "bandwidth") {
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
  // `viewers` is the room's own count, not `screens.length`. The two look
  // interchangeable and are not: the manager splits the budget by `peers.size`,
  // which counts a peer still negotiating, one sitting in `failed` waiting for
  // its ICE restart, and one whose `getStats()` threw — none of which produce a
  // sender row. A four-person call with one joiner stuck on ICE has a ceiling
  // of 5000/3 and only two rows to divide by, which read as a weak link and
  // fired this warning at somebody on fibre. Found in review.
  const ceilingBps = (screen.ceilingKbps ?? 0) * 1000;
  const cutByBudget = ceilingBps > 0 && ceilingBps < expected * CEILING_SLACK;
  return cutByBudget ? streak + 1 : 0;
}

/** Whether a streak has gone on long enough to be worth saying. */
export function isStrained(streak: number): boolean {
  return streak >= SUSTAINED_SAMPLES;
}

/**
 * Whether there is anything here worth measuring at all.
 *
 * A rule rather than a condition inline in the effect, because it is the seam
 * between this warning and room promotion (`docs/voice-backends.md`, "The one
 * time a live room changes transport") and a seam nobody can see is a seam
 * somebody deletes.
 *
 * MESH AND SFU. A watch party big enough to matter is on LiveKit, and the
 * SFU session registers its own sender rows (`registerVoiceStatsSource` in
 * `livekit-session.ts`). Those rows carry the published plan as
 * `ceilingKbps`, so `describeLimitation` is honest there: fibre sitting on
 * 4 Mbps is "setting", a starving uplink is "bandwidth". The mesh path
 * still splits the room; the SFU path does not, because there is one
 * upload.
 *
 * The earlier "mesh only" rule was written before the SFU sampler existed.
 * On that day, enabling this on LiveKit would have read mesh leftovers
 * after a promotion and blamed fibre. That sampler is gone with the mesh.
 *
 * Two independent things then have to be true, and both are:
 *
 *  - the numbers stop meaning what this rule reads them as. On the SFU, above
 *    `LARGE_ROOM_PARTICIPANTS` the published top layer is capped while the
 *    stats row still reports the uncapped rung as its ceiling, so every tick
 *    would read as "bandwidth" and tell the presenter of a large room on fibre
 *    that their connection is the problem, forever.
 *  - there is nothing left to sample. `PeerConnectionManager.dispose()`
 *    unregisters every connection from the stats probe, so the sampler would
 *    find no screen rows and the streak would reset anyway. That is a second
 *    line of defence, not the reason: a reading that is *absent* is luck, and
 *    this rule is the part that does not depend on it.
 */
export function nextSfuStrainStreak(
  streak: number,
  screens: readonly VideoSenderSample[],
): number {
  const screen = screens[0];
  if (!screen) {
    return 0;
  }
  return describeLimitation(screen) === "bandwidth" ? streak + 1 : 0;
}

export function shouldMeasureUplink(
  isSharing: boolean,
  transport: VoiceRoomTransport | null,
): boolean {
  return isSharing;
}

export function useShareUplinkStrain(
  isSharing: boolean,
  quality: VideoQuality,
  viewers: number,
  transport: VoiceRoomTransport | null,
  /** What the camera asked for, in bps, or 0 when it is off. */
  cameraChosenBps = 0,
): boolean {
  const [strained, setStrained] = useState(false);
  const streak = useRef(0);

  useEffect(() => {
    // The rule is on `shouldMeasureUplink`. A room promoted to the SFU
    // mid-share keeps measuring: the tick below switches to the SFU streak.
    if (!shouldMeasureUplink(isSharing, transport)) {
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
        streak.current =
          transport === "livekit"
            ? nextSfuStrainStreak(streak.current, screens)
            : nextStrainStreak(
                streak.current,
                screens,
                chosenScreenCeilingBps(quality),
                viewers,
                cameraChosenBps,
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
  }, [isSharing, quality, viewers, transport, cameraChosenBps]);

  return strained;
}
