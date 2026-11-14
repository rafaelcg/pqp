import { describe, expect, it, vi } from "vitest";
import type { DmSummary, Friend } from "@pqp/shared";
import {
  directConversationWith,
  friendProfileSubject,
  friendRowMenuItems,
} from "./friend-row-menu";
import { publicProfileHref } from "@/components/user/profile-relations";

const friend: Friend = {
  id: "u-gabi",
  displayName: "Gabi",
  username: "gabi",
  tag: "gabi#0001",
  avatarUrl: null,
  customStatus: "volto às 22h",
  handle: "gabi",
  status: "online",
  friendsSince: "2026-01-01T00:00:00.000Z",
};

function dm(channelId: string, ids: string[]): DmSummary {
  return {
    channelId,
    kind: ids.length > 1 ? "group" : "dm",
    participants: ids.map((id) => ({
      id,
      displayName: id,
      username: id,
      tag: null,
      avatarUrl: null,
      customStatus: null,
    })),
    lastMessageAt: null,
    unread: { count: 0, mentions: 0 },
    lastMessage: null,
  } as DmSummary;
}

const t = (key: string) => key;

describe("friendProfileSubject", () => {
  it("carries the handle, so the card can open the public page", () => {
    const subject = friendProfileSubject(friend);
    expect(subject.handle).toBe("gabi");
    expect(publicProfileHref(subject.handle)).toBe("/@gabi");
    expect(subject.status).toBe("online");
    expect(subject.customStatus).toBe("volto às 22h");
  });

  it("is null for a friend with no handle", () => {
    const subject = friendProfileSubject({ ...friend, handle: undefined });
    expect(subject.handle).toBeNull();
    expect(publicProfileHref(subject.handle)).toBeNull();
  });
});

describe("directConversationWith", () => {
  it("finds the 1:1 and ignores groups that include the friend", () => {
    const group = dm("c-group", ["u-gabi", "u-caio"]);
    const one = dm("c-gabi", ["u-gabi"]);
    expect(directConversationWith([group, one], "u-gabi")).toBe(one);
    expect(directConversationWith([group], "u-gabi")).toBeNull();
    expect(directConversationWith(undefined, "u-gabi")).toBeNull();
  });
});

describe("friendRowMenuItems", () => {
  const base = {
    t: t as never,
    friend,
    conversation: null,
    pinned: false,
    onOpenProfile: () => {},
    onRemove: () => {},
  };

  it("offers profile, block and remove when there is no conversation yet", () => {
    const ids = friendRowMenuItems({ ...base, onBlock: () => {} }).map((i) => i.id);
    expect(ids).toEqual(["profile", "sep", "block", "remove"]);
  });

  it("offers pin for an existing 1:1 and flips to unpin when pinned", () => {
    const onTogglePin = vi.fn();
    const conversation = dm("c-gabi", ["u-gabi"]);
    const items = friendRowMenuItems({ ...base, conversation, onTogglePin });
    const pin = items.find((i) => i.id === "pin")!;
    expect(pin.label).toBe("chrome.pinConversation");
    pin.onSelect?.();
    expect(onTogglePin).toHaveBeenCalledWith("c-gabi");

    const pinned = friendRowMenuItems({ ...base, conversation, onTogglePin, pinned: true });
    expect(pinned.find((i) => i.id === "pin")!.label).toBe("chrome.unpinConversation");
  });

  it("wires profile, block and remove to their callbacks", () => {
    const onOpenProfile = vi.fn();
    const onBlock = vi.fn();
    const onRemove = vi.fn();
    const items = friendRowMenuItems({ ...base, onOpenProfile, onBlock, onRemove });
    for (const id of ["profile", "block", "remove"]) {
      items.find((i) => i.id === id)!.onSelect?.();
    }
    expect(onOpenProfile).toHaveBeenCalledOnce();
    expect(onBlock).toHaveBeenCalledWith(friend);
    expect(onRemove).toHaveBeenCalledWith(friend);
  });

  it("leaves block out when the view cannot block", () => {
    const ids = friendRowMenuItems(base).map((i) => i.id);
    expect(ids).not.toContain("block");
    expect(ids.at(-1)).toBe("remove");
  });
});
