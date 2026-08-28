import { describe, expect, it } from "vitest";
import {
  channelRoutePath,
  conversationRoutePath,
  messageRoutePath,
  parseAppRoute,
  pickOpenableServer,
  signedOutRedirectPath,
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

  it("reads a Steam / Battle.net / Twitch callback and nothing else", () => {
    expect(parseAppRoute("/app/connections/callback/steam")).toEqual({
      kind: "connection-callback",
      provider: "steam",
    });
    expect(parseAppRoute("/app/connections/callback/twitch")).toEqual({
      kind: "connection-callback",
      provider: "twitch",
    });
    expect(parseAppRoute("/app/connections/callback/xbox")).toBeNull();
    expect(parseAppRoute("/app/connections/callback/steam/extra")).toBeNull();
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

describe("signedOutRedirectPath", () => {
  it("carries an invite through the sign-up round trip", () => {
    // THE BUG THIS PINS. The gate handed Clerk a hardcoded "/app", so the only
    // journey that brings new people into the product — click a friend's invite
    // link, have no account — signed up and landed on an empty hub with the code
    // thrown away. Every invite to a non-user died here.
    expect(signedOutRedirectPath("/app/invite/abc123")).toBe(
      "/app/invite/abc123",
    );
  });

  it("keeps an invite code that needed escaping", () => {
    expect(signedOutRedirectPath("/app/invite/a%2Fb")).toBe("/app/invite/a%2Fb");
  });

  it("sends a bare /app back to /app", () => {
    expect(signedOutRedirectPath("/app")).toBe("/app");
    expect(signedOutRedirectPath("/app/")).toBe("/app");
  });

  it("keeps a connection callback so the OAuth hop can finish after sign-in", () => {
    expect(signedOutRedirectPath("/app/connections/callback/steam")).toBe(
      "/app/connections/callback/steam",
    );
    expect(signedOutRedirectPath("/app/connections/callback/xbox")).toBe(
      "/app",
    );
  });

  it("carries a shared channel link", () => {
    expect(signedOutRedirectPath("/app/server/s1/channel/c1")).toBe(
      "/app/server/s1/channel/c1",
    );
    expect(signedOutRedirectPath("/app/server/s1")).toBe("/app/server/s1");
  });

  it("carries a message permalink, which is how people share one line", () => {
    expect(signedOutRedirectPath("/app/server/s1/channel/c1/message/m1")).toBe(
      "/app/server/s1/channel/c1/message/m1",
    );
    expect(signedOutRedirectPath("/app/dm/c1/message/m1")).toBe(
      "/app/dm/c1/message/m1",
    );
  });

  it("carries a conversation link", () => {
    expect(signedOutRedirectPath("/app/dm")).toBe("/app/dm");
    expect(signedOutRedirectPath("/app/dm/c1")).toBe("/app/dm/c1");
  });

  it("refuses to echo anything that is not a route this build knows", () => {
    // The argument comes off the address bar and is interpolated into an auth
    // redirect, so an unrecognised string must not be reflected back.
    const elsewhere = ["/", "/appendix/invite/x", "/app/../../etc/passwd"];
    for (const input of elsewhere) {
      expect(signedOutRedirectPath(input)).toBe("/app");
    }
  });

  it("always answers with a path under /app", () => {
    const hostile = [
      "/app/invite/x",
      "/app/dm/c1",
      "/",
      "",
      "..",
      "not-a-path",
    ];
    for (const input of hostile) {
      expect(signedOutRedirectPath(input).startsWith("/app")).toBe(true);
    }
  });
});

describe("pickOpenableServer", () => {
  it("keeps a server the viewer is already in", () => {
    expect(pickOpenableServer("lobby", ["lobby", "other"])).toEqual({
      serverId: "lobby",
      usedFallback: false,
    });
  });

  it("falls back when the URL names a server they cannot open", () => {
    expect(pickOpenableServer("gone", ["lobby"])).toEqual({
      serverId: "lobby",
      usedFallback: true,
    });
  });

  it("returns null when they have no server at all", () => {
    expect(pickOpenableServer("gone", [])).toBeNull();
  });
});
