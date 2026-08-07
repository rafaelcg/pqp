import { describe, expect, it } from "vitest";
import {
  nextVoiceStateDeclaration,
  type VoiceStateDeclaration,
} from "./voice-state-sync";

/**
 * The send-or-not decision behind `useVoiceStateSync`: when this client owes
 * the server a `set-voice-state` frame. The rules being pinned:
 *
 * - nothing is ever declared without a live peer;
 * - every *new* peer id gets a declaration (the server resets a peer's state
 *   on join, so "mute on join" and a rejoin's standing mute both depend on
 *   this — nothing else restores them);
 * - toggles re-declare, no-ops do not (each declaration fans a roster out to
 *   the whole channel audience, so silence is the default).
 */

function state(
  peerId: string | null,
  isMuted = false,
  isDeafened = false,
): { peerId: string | null; isMuted: boolean; isDeafened: boolean } {
  return { peerId, isMuted, isDeafened };
}

describe("nextVoiceStateDeclaration", () => {
  it("declares nothing without a peer", () => {
    expect(nextVoiceStateDeclaration(null, state(null, true, true))).toBeNull();
  });

  it("declares the initial state for a new peer — including mute-on-join", () => {
    expect(nextVoiceStateDeclaration(null, state("peer-1", true, false))).toEqual(
      { peerId: "peer-1", muted: true, deafened: false },
    );
  });

  it("stays silent while nothing changed", () => {
    const declared: VoiceStateDeclaration = {
      peerId: "peer-1",
      muted: false,
      deafened: false,
    };
    expect(nextVoiceStateDeclaration(declared, state("peer-1"))).toBeNull();
  });

  it("re-declares on a toggle", () => {
    const declared: VoiceStateDeclaration = {
      peerId: "peer-1",
      muted: false,
      deafened: false,
    };
    expect(
      nextVoiceStateDeclaration(declared, state("peer-1", true, false)),
    ).toEqual({ peerId: "peer-1", muted: true, deafened: false });
    expect(
      nextVoiceStateDeclaration(
        { peerId: "peer-1", muted: true, deafened: false },
        state("peer-1", true, true),
      ),
    ).toEqual({ peerId: "peer-1", muted: true, deafened: true });
  });

  it("re-declares a standing mute for a fresh peer id (reconnect/rejoin)", () => {
    // The server minted a new peer and reset it to unmuted; the old
    // declaration is about a peer that no longer exists.
    const declared: VoiceStateDeclaration = {
      peerId: "peer-1",
      muted: true,
      deafened: false,
    };
    expect(
      nextVoiceStateDeclaration(declared, state("peer-2", true, false)),
    ).toEqual({ peerId: "peer-2", muted: true, deafened: false });
  });
});
