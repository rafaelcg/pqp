import { JAM_AUDIO_CONTENT_TYPES, JAM_VIDEO_CONTENT_TYPES } from "@pqp/shared";
import { describe, expect, it } from "vitest";

import { STEM_AUDIO_MIME } from "./upload";

/**
 * The engine and the server were built in parallel and each chose a stem
 * format on its own: the engine FLAC, the server everything MediaRecorder
 * emits. Nothing compared the two, so the first real take would have been
 * refused at the upload ticket. This is the comparison.
 */
describe("jam upload contract", () => {
  it("uploads audio in a type the server accepts", () => {
    expect(JAM_AUDIO_CONTENT_TYPES).toContain(STEM_AUDIO_MIME);
  });

  it("keeps the camera's two containers on the server's list", () => {
    // Chrome and Firefox record WebM, Safari MP4 (docs/JAM_ENGINE.md).
    expect(JAM_VIDEO_CONTENT_TYPES).toEqual(expect.arrayContaining(["video/webm", "video/mp4"]));
  });
});
