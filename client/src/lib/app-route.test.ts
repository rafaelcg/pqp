import { describe, expect, it } from "vitest";
import {
  channelRoutePath,
  messageRoutePath,
  parseAppRoute,
} from "./app-route";

describe("parseAppRoute", () => {
  it("reads a server without a channel", () => {
    expect(parseAppRoute("/app/server/s1")).toEqual({
      kind: "channel",
      serverId: "s1",
      channelId: null,
      messageId: null,
    });
  });

  it("reads a channel", () => {
    expect(parseAppRoute("/app/server/s1/channel/c1")).toEqual({
      kind: "channel",
      serverId: "s1",
      channelId: "c1",
      messageId: null,
    });
  });

  it("reads a message permalink", () => {
    expect(parseAppRoute("/app/server/s1/channel/c1/message/m1")).toEqual({
      kind: "channel",
      serverId: "s1",
      channelId: "c1",
      messageId: "m1",
    });
  });

  it("ignores a message segment with no channel to open it in", () => {
    expect(parseAppRoute("/app/server/s1/message/m1")).toEqual({
      kind: "channel",
      serverId: "s1",
      channelId: null,
      messageId: null,
    });
  });

  it("still reads invites and unknown paths as before", () => {
    expect(parseAppRoute("/app/invite/abc")).toEqual({
      kind: "invite",
      code: "abc",
    });
    expect(parseAppRoute("/app")).toBeNull();
    expect(parseAppRoute("/login")).toBeNull();
  });

  it("round-trips what the permalink helper emits", () => {
    const path = messageRoutePath("s1", "c1", "m1");
    expect(path).toBe("/app/server/s1/channel/c1/message/m1");
    expect(parseAppRoute(path)).toEqual({
      kind: "channel",
      serverId: "s1",
      channelId: "c1",
      messageId: "m1",
    });
  });

  it("round-trips ids that need escaping", () => {
    const path = channelRoutePath("a/b", "c d");
    expect(parseAppRoute(path)).toEqual({
      kind: "channel",
      // The slash is encoded on the way out, so it survives the split.
      serverId: "a/b",
      channelId: "c d",
      messageId: null,
    });
  });
});
