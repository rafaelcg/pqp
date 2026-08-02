import { describe, expect, it } from "vitest";
import {
  channelRoutePath,
  conversationRoutePath,
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

describe("parseAppRoute — conversations", () => {
  it("reads the conversation list with nothing open", () => {
    expect(parseAppRoute("/app/dm")).toEqual({
      kind: "conversation",
      channelId: null,
      messageId: null,
    });
  });

  it("reads one conversation", () => {
    expect(parseAppRoute("/app/dm/c1")).toEqual({
      kind: "conversation",
      channelId: "c1",
      messageId: null,
    });
  });

  it("reads a conversation permalink", () => {
    expect(parseAppRoute("/app/dm/c1/message/m1")).toEqual({
      kind: "conversation",
      channelId: "c1",
      messageId: "m1",
    });
  });

  it("ignores a message segment with no conversation to open it in", () => {
    expect(parseAppRoute("/app/dm/message/m1")).toEqual({
      kind: "conversation",
      // `message` is read as the channel id here, which is a dead link rather
      // than a link into somebody else's conversation — the id resolves to
      // nothing and the view falls back to the list.
      channelId: "message",
      messageId: null,
    });
  });

  it("never reports a conversation as a server channel", () => {
    // The two shapes drive different access checks and different sidebars, so a
    // conversation that parsed as `kind: "channel"` would be asked for from a
    // server it does not belong to.
    const target = parseAppRoute("/app/dm/c1");
    expect(target).not.toBeNull();
    expect(target!.kind).toBe("conversation");
  });

  it("round-trips what the conversation helpers emit", () => {
    expect(conversationRoutePath()).toBe("/app/dm");
    expect(conversationRoutePath(null)).toBe("/app/dm");
    expect(parseAppRoute(conversationRoutePath("c1"))).toEqual({
      kind: "conversation",
      channelId: "c1",
      messageId: null,
    });

    const permalink = messageRoutePath(null, "c1", "m1");
    expect(permalink).toBe("/app/dm/c1/message/m1");
    expect(parseAppRoute(permalink)).toEqual({
      kind: "conversation",
      channelId: "c1",
      messageId: "m1",
    });
  });

  it("still sends a message permalink with a server through the server form", () => {
    expect(messageRoutePath("s1", "c1", "m1")).toBe(
      "/app/server/s1/channel/c1/message/m1",
    );
  });
});
