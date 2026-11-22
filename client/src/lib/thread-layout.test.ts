import { describe, expect, it } from "vitest";
import { threadTakesOver } from "@/lib/thread-layout";

const base = { redesign: true, mdUp: true, xlUp: false, voiceRoom: false };

describe("threadTakesOver", () => {
  it("takes the conversation's place between md and xl under the redesign", () => {
    expect(threadTakesOver(base)).toBe(true);
  });

  it("keeps the split from xl up", () => {
    expect(threadTakesOver({ ...base, xlUp: true })).toBe(false);
  });

  it("leaves the phone layout alone below md", () => {
    expect(threadTakesOver({ ...base, mdUp: false })).toBe(false);
  });

  it("never applies to the old look", () => {
    expect(threadTakesOver({ ...base, redesign: false })).toBe(false);
  });

  it("keeps the split in a voice room, so a call view is never hidden", () => {
    expect(threadTakesOver({ ...base, voiceRoom: true })).toBe(false);
  });
});
