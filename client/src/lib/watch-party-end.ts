import type { WatchParty } from "@pqp/shared";
import { ApiError } from "./api";

/**
 * Encerrar, made idempotent and explicit (2026-09-12 postmortem, B8).
 *
 * THE BUG. `App.tsx`'s `handleWatchPartyEnd` had no `try`/`catch` at all: a
 * stale party id (a second party already created in the same channel while
 * this tab sat on the first one) or a session already ended server-side threw
 * straight out of the click handler, and the pre-existing "did it work" logic
 * never ran. The host on 2026-09-12 said it in as many words: "eu fico
 * tentando fechar por aqui NUNCA FECHA" — every attempt had actually
 * succeeded on the SERVER already; the tab was the thing that was stale, and
 * nothing on screen ever said so.
 *
 * THREE OUTCOMES, EXACTLY. This function is the whole decision, pulled out of
 * `App.tsx` so it is testable without mounting the app.
 *
 *  1. Success: unchanged from before. Apply the answer, stop a running share,
 *     leave the room — the "End + leave" coupling this codebase already
 *     relies on, kept ONLY here.
 *  2. 404 or 409 (already ended, or a stale id this tab was holding): the
 *     party is not what this client thinks it is. `deps.fetchCurrentParty`
 *     asks the channel directly what is actually true rather than guessing
 *     — a party that already replaced this one in the same channel exists
 *     and must not be blown away, or have ITS call ended, by a stale card
 *     clearing itself. Only when that fetch confirms nothing is active
 *     there any more does this run the same cleanup as branch 1: that is
 *     this exact end having actually landed, just without an answer this
 *     request could see (2026-09-13 addition, Farol review of #532 — the
 *     first cut of B8 refreshed and stopped there, so a confirmed
 *     server-side end whose response got lost left the presenter connected
 *     and transmitting to a party that no longer existed).
 *  3. Anything else (network blip, 500): say so. `deps.reportError`, not
 *     nothing — the whole bug above was "nothing" dressed as "it must have
 *     worked".
 *
 * DEPENDENCY-INJECTED, same reasoning as `createScreenMix`'s injectable
 * `AudioContext`: every side effect (the HTTP call, the two store writes, the
 * two voice actions) is a parameter, so the three branches above are testable
 * with plain async `it` blocks and no React, no fetch mock, no voice hook.
 */

export interface WatchPartyEndDeps {
  /** `setWatchPartyState(party.id, "ended")`. */
  setEnded: (partyId: string) => Promise<{ party: WatchParty | null }>;
  /** Apply the server's answer to the local store. */
  applyParty: (channelId: string, party: WatchParty | null) => void;
  /** Refetch this server's parties from `GET /api/servers/:id/watch-parties`. */
  refresh: () => void;
  /**
   * The channel's active party right now, from
   * `GET /api/channels/:id/watch-party` — `null` when nothing is active
   * there. The authoritative check behind branch 2: whether THIS exact
   * party actually ended, or something else (a replacement, a still-active
   * session) is what a 404/409 actually meant.
   */
  fetchCurrentParty: (channelId: string) => Promise<WatchParty | null>;
  /** The error toast. */
  reportError: (message: string) => void;
  isSharingScreen: () => boolean;
  stopScreenShare: () => void;
  currentVoiceChannelId: () => string | null;
  leaveVoice: () => void;
  /** Shown when the failure carries no message of its own. */
  fallbackErrorMessage: string;
}

export async function endWatchParty(
  party: WatchParty,
  deps: WatchPartyEndDeps,
): Promise<void> {
  let answer: { party: WatchParty | null };
  try {
    answer = await deps.setEnded(party.id);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
      // Already ended, or a stale id: ask the channel directly what is
      // actually true rather than assuming this client's own guess
      // (clearing the card, or leaving it as is) is the right one. A
      // failure here (this fetch has its own network to cross) means the
      // answer stays unknown, and unknown is not a confirmed end: fall back
      // to the old "leave it alone" behavior rather than guess.
      let current: WatchParty | null;
      try {
        current = await deps.fetchCurrentParty(party.channelId);
      } catch {
        deps.refresh();
        return;
      }
      deps.applyParty(party.channelId, current);
      deps.refresh();
      if (current !== null) {
        // Something is still active in this channel — this exact party
        // (the fetch and the failed request raced), or a replacement that
        // has nothing to do with the request that just failed. Either way
        // it is not this client's place to end a call or share it never
        // confirmed belongs to a dead session.
        return;
      }
      // Nothing is active here any more: this exact end DID land, this
      // request just never saw the answer. Finish the same cleanup the
      // success path below would have.
      endLocalPresence(party, deps);
      return;
    }
    deps.reportError(
      error instanceof Error && error.message
        ? error.message
        : deps.fallbackErrorMessage,
    );
    return;
  }
  deps.applyParty(party.channelId, answer.party ?? null);
  // Encerrar is the end of the LiveKit pipe, not "stay in the room without a
  // picture". Leave so the host does not keep leave-voice chrome after the
  // show — but ONLY on confirmed success (including the confirmed-by-fetch
  // case above); the network-failure branch returns before this so a failed
  // or ambiguous end never ejects anyone as a side effect.
  endLocalPresence(party, deps);
}

/** Stop presenting and leave the room — the "End + leave" coupling. */
function endLocalPresence(
  party: WatchParty,
  deps: Pick<
    WatchPartyEndDeps,
    "isSharingScreen" | "stopScreenShare" | "currentVoiceChannelId" | "leaveVoice"
  >,
): void {
  if (deps.isSharingScreen()) {
    deps.stopScreenShare();
  }
  if (deps.currentVoiceChannelId() === party.channelId) {
    deps.leaveVoice();
  }
}
