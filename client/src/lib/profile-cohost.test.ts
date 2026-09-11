import { describe, expect, it } from "vitest";
import type { WatchParty } from "@pqp/shared";
import { cohostActionFor } from "./profile-cohost";

const HOST = "11111111-1111-4111-8111-111111111111";
const GUEST = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

const party = (over: Partial<WatchParty> = {}): WatchParty =>
  ({
    id: "p",
    channelId: "c",
    serverId: "s",
    name: "Cinemoon",
    state: "live",
    hostUserId: HOST,
    viewerRole: "host",
    cohosts: [],
    ...over,
  }) as unknown as WatchParty;

describe("cohostActionFor", () => {
  it("offers to promote a member the host is looking at", () => {
    expect(cohostActionFor({ party: party(), subjectId: GUEST, currentUserId: HOST })).toBe("promote");
  });

  it("offers to demote one who already is a co-host", () => {
    const p = party({ cohosts: [{ userId: GUEST, displayName: "g", avatarUrl: null }] });
    expect(cohostActionFor({ party: p, subjectId: GUEST, currentUserId: HOST })).toBe("demote");
  });

  it("never against yourself, or the host", () => {
    expect(cohostActionFor({ party: party(), subjectId: HOST, currentUserId: HOST })).toBeNull();
    const asCohost = party({ viewerRole: "cohost" });
    expect(cohostActionFor({ party: asCohost, subjectId: HOST, currentUserId: OTHER })).toBeNull();
  });

  it("is absent for a viewer, with no party, and once the party has ended", () => {
    expect(cohostActionFor({ party: party({ viewerRole: "viewer" }), subjectId: GUEST, currentUserId: OTHER })).toBeNull();
    expect(cohostActionFor({ party: null, subjectId: GUEST, currentUserId: HOST })).toBeNull();
    expect(cohostActionFor({ party: party({ state: "ended" }), subjectId: GUEST, currentUserId: HOST })).toBeNull();
  });
});
