import { useEffect, useRef } from "react";
import type { VoiceState } from "@/hooks/use-voice";
import type { RealtimeTransport } from "@/lib/realtime";

/**
 * Declares this client's mute/deafen state to the server, so the roster can
 * carry it to people *outside* the call (channel-list badges, voice tiles).
 *
 * Lives beside the UI rather than inside the voice controller on purpose: the
 * controller owns what the microphone actually does; this only mirrors the
 * outcome onto the wire, and dropping every one of these frames changes
 * nothing about the call itself. Display state, never enforcement.
 *
 * Re-declares on every new peer id, not only on toggles — the server resets a
 * peer's state to unmuted on (re)join, so a standing mute has to be restated
 * after a reconnect or a channel switch, and "mute on join" has to be stated
 * at all.
 */

export interface VoiceStateDeclaration {
  peerId: string;
  muted: boolean;
  deafened: boolean;
}

type DeclarableState = Pick<VoiceState, "peerId" | "isMuted" | "isDeafened">;

/**
 * The next declaration owed to the server, or null when the wire is already
 * up to date. Pure, so the send-or-not decision is testable without React.
 */
export function nextVoiceStateDeclaration(
  declared: VoiceStateDeclaration | null,
  state: DeclarableState,
): VoiceStateDeclaration | null {
  // No peer, nothing to declare about — and any previous declaration died
  // with the peer, which the caller records by passing null next time.
  if (!state.peerId) {
    return null;
  }
  if (
    declared &&
    declared.peerId === state.peerId &&
    declared.muted === state.isMuted &&
    declared.deafened === state.isDeafened
  ) {
    return null;
  }
  return {
    peerId: state.peerId,
    muted: state.isMuted,
    deafened: state.isDeafened,
  };
}

export function useVoiceStateSync(
  transport: Pick<RealtimeTransport, "sendVoice">,
  state: DeclarableState,
): void {
  const declaredRef = useRef<VoiceStateDeclaration | null>(null);
  const { peerId, isMuted, isDeafened } = state;

  useEffect(() => {
    if (!peerId) {
      // Left the call (or the socket dropped): the peer this declaration was
      // about no longer exists, so the next join starts from scratch.
      declaredRef.current = null;
      return;
    }
    const next = nextVoiceStateDeclaration(declaredRef.current, {
      peerId,
      isMuted,
      isDeafened,
    });
    if (!next) {
      return;
    }
    declaredRef.current = next;
    transport.sendVoice({
      type: "set-voice-state",
      muted: next.muted,
      deafened: next.deafened,
    });
  }, [transport, peerId, isMuted, isDeafened]);
}
