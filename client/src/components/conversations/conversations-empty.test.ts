import { describe, expect, it } from "vitest";
import type { Server } from "@pqp/shared";
import { rankSuggestions, roomsToAsk } from "@/components/conversations/conversations-empty";
import type { ServerMember } from "@/lib/api";

function member(id: string, displayName: string, extra: Partial<ServerMember> = {}): ServerMember {
  return { id, displayName, tag: null, role: "member", avatarUrl: null, ...extra };
}

describe("rankSuggestions", () => {
  it("puts people who are around first, never the viewer, the house cast or anybody twice", () => {
    const ranked = rankSuggestions(
      [
        {
          serverName: "Turma",
          members: [
            member("me", "Me", { status: "online" }),
            member("a", "Ana", { status: "offline" }),
            member("b", "Bia", { status: "online" }),
            member("bot", "Robô", { status: "online", isCharacter: true }),
          ],
        },
        {
          serverName: "Outra",
          members: [member("b", "Bia", { status: "online" }), member("c", "Cris", { status: "idle" })],
        },
      ],
      "me",
    );
    expect(ranked.map((one) => one.member.id)).toEqual(["b", "c", "a"]);
    expect(ranked[0]!.serverName).toBe("Turma");
  });

  it("offers at most three", () => {
    const members = ["a", "b", "c", "d", "e"].map((id) => member(id, id));
    expect(rankSuggestions([{ serverName: "x", members }], null)).toHaveLength(3);
  });
});

describe("roomsToAsk", () => {
  it("asks the person's own rooms, never a listed community, and only two", () => {
    const servers = [
      { id: "qg", name: "QG", isCommunity: true },
      { id: "r1", name: "Turma", isCommunity: false },
      { id: "r2", name: "Família", isCommunity: false },
      { id: "r3", name: "Trampo", isCommunity: false },
    ] as Server[];
    expect(roomsToAsk(servers).map((s) => s.id)).toEqual(["r1", "r2"]);
  });
});
