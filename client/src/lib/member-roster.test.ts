import { describe, expect, it } from "vitest";
import type { ServerMember } from "@/lib/api";
import { authorPipStatus, mergeMemberStatuses } from "./member-roster";

function member(
  id: string,
  status: ServerMember["status"],
  extra: Partial<ServerMember> = {},
): ServerMember {
  return {
    id,
    displayName: extra.displayName ?? "Caio",
    tag: extra.tag ?? "caio#0001",
    role: extra.role ?? "member",
    avatarUrl: extra.avatarUrl ?? null,
    username: extra.username ?? "caio",
    nickname: extra.nickname ?? null,
    status,
    isCharacter: extra.isCharacter,
  };
}

describe("mergeMemberStatuses", () => {
  it("changes the pip MessageList would draw when a later payload says they came online", () => {
    const first = [member("caio", "offline")];
    const later = [member("caio", "online")];

    expect(authorPipStatus(first, "caio")).toBe("offline");

    const roster = mergeMemberStatuses(first, later);
    expect(authorPipStatus(roster, "caio")).toBe("online");
  });

  it("keeps name, avatar and nickname on people already on the map", () => {
    const current = [
      member("caio", "offline", {
        displayName: "Caio [bot]",
        avatarUrl: "https://cdn.example/caio.png",
        nickname: "Caio",
      }),
    ];
    const incoming = [
      member("caio", "online", {
        displayName: "stale-from-poll",
        avatarUrl: null,
        nickname: null,
      }),
    ];

    const roster = mergeMemberStatuses(current, incoming);
    expect(roster[0]).toMatchObject({
      displayName: "Caio [bot]",
      avatarUrl: "https://cdn.example/caio.png",
      nickname: "Caio",
      status: "online",
    });
  });

  it("does not invent online when the payload carries no status", () => {
    const current = [member("caio", "offline")];
    const incoming = [member("caio", undefined)];

    const roster = mergeMemberStatuses(current, incoming);
    expect(authorPipStatus(roster, "caio")).toBe("offline");
    expect(roster[0]).toBe(current[0]);
  });

  it("adds someone who was not on the map yet and drops someone who left", () => {
    const current = [member("ana", "online", { displayName: "Ana" })];
    const incoming = [member("caio", "online")];

    const roster = mergeMemberStatuses(current, incoming);
    expect(roster.map((row) => row.id)).toEqual(["caio"]);
    expect(authorPipStatus(roster, "caio")).toBe("online");
    expect(authorPipStatus(roster, "ana")).toBeNull();
  });

  it("returns the same array when nothing about status moved", () => {
    const current = [member("caio", "idle")];
    const incoming = [member("caio", "idle", { displayName: "other" })];
    expect(mergeMemberStatuses(current, incoming)).toBe(current);
  });
});
