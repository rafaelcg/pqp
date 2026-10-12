import { describe, expect, it } from "vitest";
import { authorInRoom, defaultCallRoom } from "./call-room";

const me = "me";
const lobby = { id: "lobby", occupants: [{ id: me }] };
const busy = { id: "busy", occupants: [{ id: "a" }, { id: "b" }, { id: "c" }] };
const empty = { id: "empty", occupants: [] };

describe("defaultCallRoom", () => {
  it("starts on the room the author is in, even when another one is busier", () => {
    // The sticker is live only while its author is in the room: the busiest
    // room would be posted already closed.
    expect(defaultCallRoom([busy, lobby, empty], me)).toBe("lobby");
  });

  it("falls back to the busiest room when the author is in none", () => {
    expect(defaultCallRoom([empty, busy], me)).toBe("busy");
  });

  it("no rooms: nothing", () => {
    expect(defaultCallRoom([], me)).toBeNull();
  });
});

describe("authorInRoom", () => {
  it("reads the room's occupants", () => {
    expect(authorInRoom(lobby, me)).toBe(true);
    expect(authorInRoom(busy, me)).toBe(false);
    expect(authorInRoom(null, me)).toBe(false);
  });
});
