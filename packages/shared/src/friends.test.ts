import { describe, expect, it } from "vitest";
import {
  chatServerMessageSchema,
  CHAT_SERVER_MESSAGE_TYPES,
  isChatServerMessage,
} from "./chat.js";
import { friendActivitySchema, friendNudgeFor } from "./friends.js";
import {
  allowedModerationActions,
  canManageMessages,
  canModerateMember,
  MODERATION_ACTIONS,
} from "./moderation.js";

const OWNER = "11111111-1111-1111-1111-111111111111";
const ADMIN = "22222222-2222-2222-2222-222222222222";
const MEMBER = "33333333-3333-3333-3333-333333333333";

describe("friendNudgeFor", () => {
  it("nudges the person who was asked when a new request stands", () => {
    expect(friendNudgeFor("pending")).toBe("request");
  });

  it("nudges on the auto-accept, which completes a handshake they started", () => {
    expect(friendNudgeFor("accepted")).toBe("accepted");
  });

  /**
   * THE RULE THIS FILE EXISTS FOR. `sendFriendRequest` deliberately does not
   * touch `created_at` on a resend so an ignored request cannot be re-surfaced;
   * a nudge here would hand that same bell straight back — send, send, send,
   * and the badge lights three times for one request that never changed.
   */
  it("stays silent on a resend, so resending is not a bell", () => {
    expect(friendNudgeFor("already-pending")).toBeNull();
  });

  it("stays silent when the two were already friends — nothing changed", () => {
    expect(friendNudgeFor("already-friends")).toBeNull();
  });
});

describe("friendActivitySchema", () => {
  it("carries no identity, so the frame discloses nothing on its own", () => {
    const parsed = friendActivitySchema.parse({
      type: "friend-activity",
      kind: "request",
      // A sender who tried to attach the asker's name gets it stripped: the
      // recipient learns who asked from `GET /api/friends`, which is access-
      // controlled, and never from a frame.
      from: { id: OWNER, displayName: "Someone" },
    });
    expect(parsed).toEqual({ type: "friend-activity", kind: "request" });
    expect("from" in parsed).toBe(false);
  });

  it("refuses a kind nobody defined", () => {
    expect(
      friendActivitySchema.safeParse({
        type: "friend-activity",
        kind: "declined",
      }).success,
    ).toBe(false);
  });

  it("is a chat server frame, so a client can route it by name", () => {
    expect(
      chatServerMessageSchema.safeParse({
        type: "friend-activity",
        kind: "accepted",
      }).success,
    ).toBe(true);
  });

  /**
   * The guard that keeps a one-person nudge off a whole channel. `sanction-
   * notice` is kept out of this list for the same reason and says so at length;
   * this is the assertion that stops somebody "fixing" the omission.
   */
  it("is NOT relayable to a channel", () => {
    expect(CHAT_SERVER_MESSAGE_TYPES).not.toContain("friend-activity");
    expect(isChatServerMessage({ type: "friend-activity" })).toBe(false);
  });
});

describe("canModerateMember", () => {
  it("offers a plain member nothing at all", () => {
    for (const action of MODERATION_ACTIONS) {
      expect(
        canModerateMember(action, {
          actorRole: "member",
          actorId: MEMBER,
          targetRole: "member",
          targetId: OWNER,
        }),
      ).toBe(false);
    }
  });

  it("lets an owner act on an admin", () => {
    expect(
      canModerateMember("timeout", {
        actorRole: "owner",
        actorId: OWNER,
        targetRole: "admin",
        targetId: ADMIN,
      }),
    ).toBe(true);
  });

  /**
   * The iOS bug this function was extracted to kill: `MembersView` gated on
   * "not the owner, not me" alone, so an admin was shown Kick against a peer
   * and got a 403 from `requireOutranked` every single time.
   */
  it("refuses an admin acting on another admin", () => {
    expect(
      canModerateMember("kick", {
        actorRole: "admin",
        actorId: ADMIN,
        targetRole: "admin",
        targetId: MEMBER,
      }),
    ).toBe(false);
  });

  it("refuses everybody against the owner, the owner included", () => {
    for (const actorRole of ["owner", "admin"] as const) {
      expect(
        canModerateMember("ban", {
          actorRole,
          actorId: ADMIN,
          targetRole: "owner",
          targetId: OWNER,
        }),
      ).toBe(false);
    }
  });

  it("refuses self-targeting, which the server answers with 'use leave'", () => {
    expect(
      canModerateMember("kick", {
        actorRole: "owner",
        actorId: OWNER,
        targetRole: "owner",
        targetId: OWNER,
      }),
    ).toBe(false);
  });

  /**
   * A non-member is allowed through: `POST /api/servers/:id/bans` takes any
   * existing user, which is what a pre-emptive ban is. Callers that need the
   * person to be present — a voice disconnect — check that themselves.
   */
  it("allows a non-member target, for the pre-emptive ban", () => {
    expect(
      canModerateMember("ban", {
        actorRole: "admin",
        actorId: ADMIN,
        targetRole: null,
        targetId: MEMBER,
      }),
    ).toBe(true);
  });

  it("projects the rule onto a menu as all-or-nothing today", () => {
    expect(
      allowedModerationActions({
        actorRole: "admin",
        actorId: ADMIN,
        targetRole: "member",
        targetId: MEMBER,
      }),
    ).toEqual([...MODERATION_ACTIONS]);
    expect(
      allowedModerationActions({
        actorRole: "member",
        actorId: MEMBER,
        targetRole: "member",
        targetId: OWNER,
      }),
    ).toEqual([]);
  });
});

describe("canManageMessages", () => {
  /**
   * Flat, with NO rank rule, matching `canManageServer` on the server: an admin
   * removing the owner's post is a moderator doing their job. Both iOS bugs
   * this pins were in opposite directions — Delete was `isMine`-only, so an
   * owner could remove nothing; Pin was ungated, so a member always 403'd.
   */
  it("lets both managers act, and nobody else", () => {
    expect(canManageMessages("owner")).toBe(true);
    expect(canManageMessages("admin")).toBe(true);
    expect(canManageMessages("member")).toBe(false);
    expect(canManageMessages(null)).toBe(false);
  });
});
