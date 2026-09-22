import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { musicErrorKey } from "@/components/voice/music-search-picker";

/*
 * The mapping was written out twice, in the search handler and the paste
 * handler, and the two had drifted: neither knew 429, so the per-user
 * limiter told people the whole feature was unavailable. The field
 * searches as you type, so that is the refusal they actually meet.
 */
describe("what a failed lookup tells somebody", () => {
  const api = (status: number) => new ApiError(status, "x");

  it("says it is busy when the limiter refuses", () => {
    expect(musicErrorKey(api(429))).toBe("music.error.busy");
  });

  it("keeps the answers it already had right", () => {
    expect(musicErrorKey(api(404))).toBe("music.error.notFound");
    expect(musicErrorKey(api(400))).toBe("music.error.unsupported");
    expect(musicErrorKey(api(502))).toBe("music.error.upstream");
  });

  it("treats anything that is not an ApiError as upstream", () => {
    expect(musicErrorKey(new Error("offline"))).toBe("music.error.upstream");
    expect(musicErrorKey(undefined)).toBe("music.error.upstream");
  });
});
