import { describe, expect, it } from "vitest";
import { resolvePeerPlaybackVolume } from "./voice-audio-sinks";

/**
 * The one decision the voice sink makes on its own: what level to play a
 * peer at. A moderator's mute has to win over the listener's slider without
 * touching the slider's stored value, so the person comes back at the level
 * they were set to the moment the flag clears. On a mesh room this IS the
 * server mute; nothing upstream stops the packets.
 */
describe("resolvePeerPlaybackVolume", () => {
  it("plays a server-muted peer at zero whatever the slider says", () => {
    expect(resolvePeerPlaybackVolume(1, true)).toBe(0);
    expect(resolvePeerPlaybackVolume(0.4, true)).toBe(0);
    expect(resolvePeerPlaybackVolume(undefined, true)).toBe(0);
  });

  it("restores the stored level once the flag clears", () => {
    const stored = 0.4;
    expect(resolvePeerPlaybackVolume(stored, true)).toBe(0);
    expect(resolvePeerPlaybackVolume(stored, false)).toBe(stored);
  });

  it("defaults an unset slider to unity", () => {
    expect(resolvePeerPlaybackVolume(undefined, false)).toBe(1);
  });
});
