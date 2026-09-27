import { describe, expect, it } from "vitest";
import { VOICE_CLIENT_MESSAGE_TYPES } from "./signaling.js";

/**
 * The voice router in `server/src/ws/index.ts` dispatches on this list before
 * any frame is parsed. Its hand-kept predecessor dropped `set-raised-hand` and
 * then `voice-still-here`, which is what these two lines pin.
 */
describe("VOICE_CLIENT_MESSAGE_TYPES", () => {
  it("routes the frames a hand-kept list once dropped", () => {
    expect(VOICE_CLIENT_MESSAGE_TYPES).toContain("set-raised-hand");
    expect(VOICE_CLIENT_MESSAGE_TYPES).toContain("voice-still-here");
  });

  it("has no duplicates and no empty names", () => {
    expect(new Set(VOICE_CLIENT_MESSAGE_TYPES).size).toBe(
      VOICE_CLIENT_MESSAGE_TYPES.length,
    );
    expect(VOICE_CLIENT_MESSAGE_TYPES.every((t) => t.length > 0)).toBe(true);
  });
});
