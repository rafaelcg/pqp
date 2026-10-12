import { afterEach, describe, expect, it, vi } from "vitest";
import { trackDmOpen, trackDmStart } from "@/lib/conversation-events";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("conversation events", () => {
  it("names the door and nothing about the person", () => {
    const umami = { track: vi.fn() };
    vi.stubGlobal("window", { umami });
    trackDmOpen("rail-unread");
    trackDmStart("new-conversation", "group");
    trackDmStart("member-row");
    expect(umami.track.mock.calls).toEqual([
      ["dm_open", { source: "rail-unread" }],
      ["dm_start", { source: "new-conversation", kind: "group" }],
      ["dm_start", { source: "member-row", kind: "dm" }],
    ]);
  });

  it("is a no-op where the tag was not injected (every self-host)", () => {
    vi.stubGlobal("window", {});
    expect(() => trackDmOpen("list")).not.toThrow();
  });
});
