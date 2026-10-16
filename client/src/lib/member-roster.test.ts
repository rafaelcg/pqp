import { describe, expect, it } from "vitest";
import type { ServerMember } from "@/lib/api";
import {
  applyMemberStatuses,
  authorPipStatus,
  LEAN_STATUS_POLL_MIN_MEMBERS,
  mergeMemberStatuses,
  readMemberStatusesIfSame,
} from "./member-roster";

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

describe("applyMemberStatuses", () => {
  it("reads a member the answer does not name as offline, and names the rest", () => {
    const roster = [
      member("a", "online"),
      member("b", "idle"),
      member("c", "offline"),
    ];
    const next = applyMemberStatuses(roster, { b: "dnd", c: "online" });
    expect(next.map((one) => [one.id, one.status])).toEqual([
      ["a", "offline"],
      ["b", "dnd"],
      ["c", "online"],
    ]);
  });

  it("returns the very same array when nothing moved, so a big list is not re-rendered", () => {
    const roster = [member("a", "online"), member("b", "offline")];
    expect(applyMemberStatuses(roster, { a: "online" })).toBe(roster);
  });

  it("touches only status: name, avatar and nickname survive", () => {
    const roster = [
      member("a", "offline", { displayName: "Ana [bot]", nickname: "Aninha" }),
    ];
    const [next] = applyMemberStatuses(roster, { a: "online" });
    expect(next).toMatchObject({
      status: "online",
      displayName: "Ana [bot]",
      nickname: "Aninha",
    });
  });
});

describe("readMemberStatusesIfSame", () => {
  const BIG = LEAN_STATUS_POLL_MIN_MEMBERS + 1;
  const answer = (over: Partial<{ roster: string; count: number }> = {}) => ({
    roster: "tok",
    count: BIG,
    statuses: { a: "online" as const },
    ...over,
  });

  it("returns the statuses when the token and the count are the held ones", async () => {
    await expect(
      readMemberStatusesIfSame(async () => answer(), { token: "tok", size: BIG }),
    ).resolves.toEqual({ a: "online" });
  });

  it("returns null, and does not even ask, without a token or for a small roster", async () => {
    const read = async () => answer();
    const spy = { calls: 0 };
    const counting = async () => {
      spy.calls += 1;
      return read();
    };
    await expect(
      readMemberStatusesIfSame(counting, { token: null, size: BIG }),
    ).resolves.toBeNull();
    await expect(
      readMemberStatusesIfSame(counting, {
        token: "tok",
        size: LEAN_STATUS_POLL_MIN_MEMBERS,
      }),
    ).resolves.toBeNull();
    expect(spy.calls).toBe(0);
  });

  it("returns null when somebody joined or left (token) or the count disagrees", async () => {
    await expect(
      readMemberStatusesIfSame(async () => answer({ roster: "other" }), {
        token: "tok",
        size: BIG,
      }),
    ).resolves.toBeNull();
    await expect(
      readMemberStatusesIfSame(async () => answer({ count: BIG + 1 }), {
        token: "tok",
        size: BIG,
      }),
    ).resolves.toBeNull();
  });

  it("returns null when the read fails, so the caller reads the whole list", async () => {
    await expect(
      readMemberStatusesIfSame(
        async () => {
          throw new Error("404");
        },
        { token: "tok", size: BIG },
      ),
    ).resolves.toBeNull();
  });
});
