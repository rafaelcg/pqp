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
 *     party is not what this client thinks it is. Refetching
 *     (`deps.refresh`, `GET /api/servers/:id/watch-parties`) is the honest
 *     move rather than guessing — a party that already replaced this one in
 *     the same channel exists and must not be blown away by a stale card
 *     clearing itself. The room is left untouched: a request that never
 *     reached "ended" must not silently end the call as a side effect.
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
      // Already ended, or a stale id: ask the server what is actually true
      // rather than assuming this client's own guess (clearing the card, or
      // leaving it as is) is the right one.
      deps.refresh();
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
  // show — but ONLY on confirmed success; the two branches above return
  // before this so a failed or ambiguous end never ejects anyone as a side
  // effect.
  if (deps.isSharingScreen()) {
    deps.stopScreenShare();
  }
  if (deps.currentVoiceChannelId() === party.channelId) {
    deps.leaveVoice();
  }
}
