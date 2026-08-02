import { describe, expect, it } from "vitest";
import { parseAppRoute } from "./app-route";
import {
  HOME_SELECTION,
  selectionRoutePath,
  selectionServerId,
  type Selection,
} from "./selection";

const SERVER: Selection = { kind: "server", serverId: "s1" };

describe("selectionServerId", () => {
  it("names the server when one is selected", () => {
    expect(selectionServerId(SERVER)).toBe("s1");
  });

  it("is null in the conversation view", () => {
    // Everything scoped to a server reads this. A conversation view that
    // reported a server id would offer that server's invites, its member list
    // and its permalinks from inside a private conversation.
    expect(selectionServerId(HOME_SELECTION)).toBeNull();
  });
});

describe("selectionRoutePath", () => {
  it("writes a URL for a server with and without a channel", () => {
    expect(selectionRoutePath(SERVER, "c1")).toBe("/app/server/s1/channel/c1");
    expect(selectionRoutePath(SERVER, null)).toBe("/app/server/s1");
  });

  it("writes a URL for the conversation view, which used to write none", () => {
    // The regression this replaced: route syncing returned early on a null
    // server id, so a conversation had no address and could not be linked to.
    expect(selectionRoutePath(HOME_SELECTION, "c1")).toBe("/app/dm/c1");
    expect(selectionRoutePath(HOME_SELECTION, null)).toBe("/app/dm");
  });

  it("round-trips through the parser for both kinds", () => {
    expect(parseAppRoute(selectionRoutePath(SERVER, "c1"))).toEqual({
      kind: "channel",
      serverId: "s1",
      channelId: "c1",
      messageId: null,
    });
    expect(parseAppRoute(selectionRoutePath(HOME_SELECTION, "c1"))).toEqual({
      kind: "conversation",
      channelId: "c1",
      messageId: null,
    });
  });
});
