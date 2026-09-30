import { describe, expect, it } from "vitest";
import {
  joinWatchPartyWaitlistSchema,
  normalizeStreamChannel,
} from "./watch-party-waitlist.js";

const SERVER = "33333333-3333-4333-8333-333333333333";

describe("normalizeStreamChannel", () => {
  it("reads a Twitch or Kick channel however it is pasted", () => {
    expect(normalizeStreamChannel("https://www.twitch.tv/SodTZ/")).toBe("twitch.tv/sodtz");
    expect(normalizeStreamChannel("kick.com/moonkase")).toBe("kick.com/moonkase");
    expect(normalizeStreamChannel("m.twitch.tv/abc_12")).toBe("twitch.tv/abc_12");
    expect(normalizeStreamChannel("@cinemoon")).toBe("cinemoon");
  });

  it("refuses anything that is not one channel on one of the two", () => {
    expect(normalizeStreamChannel("youtube.com/foo")).toBeNull();
    expect(normalizeStreamChannel("twitch.tv/foo/videos")).toBeNull();
    expect(normalizeStreamChannel("two words")).toBeNull();
    expect(normalizeStreamChannel("x")).toBeNull();
    expect(normalizeStreamChannel("")).toBeNull();
  });
});

describe("joinWatchPartyWaitlistSchema", () => {
  it("normalises, and turns empty optionals into null", () => {
    expect(
      joinWatchPartyWaitlistSchema.parse({
        serverId: SERVER,
        audienceBucket: "50-150",
        note: "  ",
        streamChannel: "Twitch.tv/Foo",
      }),
    ).toEqual({
      serverId: SERVER,
      audienceBucket: "50-150",
      note: null,
      streamChannel: "twitch.tv/foo",
    });
  });

  it("refuses an unknown range, a long note, and a bad channel", () => {
    expect(joinWatchPartyWaitlistSchema.safeParse({ serverId: SERVER, audienceBucket: "lots" }).success).toBe(false);
    expect(joinWatchPartyWaitlistSchema.safeParse({ serverId: SERVER, note: "x".repeat(141) }).success).toBe(false);
    expect(joinWatchPartyWaitlistSchema.safeParse({ serverId: SERVER, streamChannel: "youtube.com/x" }).success).toBe(false);
    expect(joinWatchPartyWaitlistSchema.safeParse({ serverId: "nope" }).success).toBe(false);
  });

  it("takes a serverless row", () => {
    expect(joinWatchPartyWaitlistSchema.parse({ serverId: null })).toMatchObject({ serverId: null, note: null, streamChannel: null });
  });
});
