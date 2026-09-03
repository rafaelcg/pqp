import { describe, expect, it } from "vitest";
import {
  COMMUNITY_HOME_MAX_BYTES,
  formatHomeBytes,
  parseYoutubeVideoId,
  youtubeEmbedSrc,
} from "./media";

describe("community home media helpers", () => {
  it("parses watch, youtu.be, and shorts URLs", () => {
    expect(
      parseYoutubeVideoId("https://www.youtube.com/watch?v=jNQXAC9IVRw"),
    ).toBe("jNQXAC9IVRw");
    expect(parseYoutubeVideoId("https://youtu.be/jNQXAC9IVRw")).toBe(
      "jNQXAC9IVRw",
    );
    expect(
      parseYoutubeVideoId("https://www.youtube.com/shorts/jNQXAC9IVRw"),
    ).toBe("jNQXAC9IVRw");
    expect(parseYoutubeVideoId("https://example.com/watch?v=nope")).toBeNull();
  });

  it("builds a nocookie embed only from a valid URL", () => {
    expect(youtubeEmbedSrc("https://youtu.be/jNQXAC9IVRw")).toBe(
      "https://www.youtube-nocookie.com/embed/jNQXAC9IVRw",
    );
    expect(youtubeEmbedSrc("not-a-url")).toBeNull();
  });

  it("formats bytes and keeps the 100 MiB ceiling", () => {
    expect(formatHomeBytes(420 * 1024)).toBe("420 KiB");
    expect(COMMUNITY_HOME_MAX_BYTES).toBe(100 * 1024 * 1024);
  });
});
