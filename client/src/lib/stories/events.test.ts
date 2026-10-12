import { describe, expect, it } from "vitest";
import { emitStoriesUpdate, onStoriesSignal, signalTouchesStrip } from "./events";
import { commitSeenStories, getSeenStories, noteStoriesSeen, resetSeenStories } from "./seen-store";

const SERVER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("signalTouchesStrip", () => {
  const server = { kind: "server", serverId: SERVER } as const;
  const friends = { kind: "friends" } as const;

  it("a server frame touches that server's strip only", () => {
    const signal = { kind: "update", frame: { type: "stories-update", scope: "server", serverId: SERVER } } as const;
    expect(signalTouchesStrip(signal, server)).toBe(true);
    expect(signalTouchesStrip(signal, { kind: "server", serverId: OTHER })).toBe(false);
    expect(signalTouchesStrip(signal, friends)).toBe(false);
  });

  it("a friends frame touches the friends strip only", () => {
    const signal = { kind: "update", frame: { type: "stories-update", scope: "friends" } } as const;
    expect(signalTouchesStrip(signal, friends)).toBe(true);
    expect(signalTouchesStrip(signal, server)).toBe(false);
  });

  it("an own frame and a reconnect refresh touch every strip", () => {
    const own = { kind: "update", frame: { type: "stories-update", scope: "own" } } as const;
    expect(signalTouchesStrip(own, server)).toBe(true);
    expect(signalTouchesStrip(own, friends)).toBe(true);
    expect(signalTouchesStrip({ kind: "refresh" }, server)).toBe(true);
  });

  it("listeners get the frame and stop after unsubscribing", () => {
    const got: string[] = [];
    const off = onStoriesSignal((signal) => got.push(signal.kind));
    emitStoriesUpdate({ type: "stories-update", scope: "friends" });
    off();
    emitStoriesUpdate({ type: "stories-update", scope: "friends" });
    expect(got).toEqual(["update"]);
  });
});

describe("seen store", () => {
  it("a view shows on the rings only once the viewer commits it", () => {
    resetSeenStories();
    noteStoriesSeen(["a"]);
    expect(getSeenStories().has("a")).toBe(false);
    commitSeenStories();
    expect(getSeenStories().has("a")).toBe(true);
  });
});
