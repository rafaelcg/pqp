import type { PostedOutcome } from "@/lib/jam-mix";

/**
 * What the studio's "done" screen says, as the two catalogue keys. It used to say
 * "It is up. Your recording already plays with the band." after EVERY send, and
 * that was false in three of the five things a send can do (jam persona QA,
 * 2026-11-19):
 *
 *   - a second take of an instrument already in the mix is stored as another
 *     version and stays OUT of the mix;
 *   - an outside take on a public jam is a request until the starter accepts it;
 *   - a first take has no band to play with.
 *
 * So the screen is chosen from what the server actually did (`PostedOutcome`,
 * read from its reply), never from what the page hoped.
 */
export interface DoneCopyInput {
  /** The take went into an existing song (false: a new song was just made with it). */
  existingSong: boolean;
  /** An outside take on somebody else's public jam: a request, not a part. */
  outsideTake: boolean;
  /** The song's starter lets outside takes in by themselves (changes what an outside take is told). */
  autoAcceptOutside: boolean;
  /** "Replace my earlier take" was asked and did not go through. */
  swapFailed: boolean;
  outcome: PostedOutcome | null;
  /** The poster may turn takes on and off (the song's author or a moderator). */
  canSwitchMix: boolean;
}

export interface DoneCopy {
  titleKey: string;
  bodyKey: string;
}

export function doneCopy(input: DoneCopyInput): DoneCopy {
  const { outsideTake, swapFailed, outcome } = input;
  // Sent, not "up": it is stored, and something else decides when it is heard.
  const sentOnly = outsideTake || swapFailed || outcome === "version";
  const titleKey = !input.existingSong
    ? "jam.post.doneNewTitle"
    : sentOnly
      ? "jam.post.doneSentTitle"
      : outcome === "alone"
        ? "jam.post.doneAloneTitle"
        : "jam.post.doneTitle";
  const bodyKey = swapFailed
    ? "jam.post.swapFailed"
    : outsideTake
      ? input.autoAcceptOutside
        ? "jam.public.studio.doneOutsideAuto"
        : "jam.public.studio.doneOutside"
      : outcome === "alone"
        ? "jam.post.doneAlone"
        : outcome === "unknown"
          ? "jam.post.doneInMix"
          : outcome === "version"
            ? input.canSwitchMix
              ? "jam.post.doneVersionOwner"
              : "jam.post.doneVersion"
            : outcome === "swapped"
              ? "jam.post.doneSwapped"
              : "jam.post.doneBody";
  return { titleKey, bodyKey };
}
