import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { DmSummary } from "@pqp/shared";
import { FriendsContext, type FriendsState } from "@/components/friends/use-friends";
import { TooltipProvider } from "@/components/ui/tooltip";
import { noteListTyping, resetListTypingForTests } from "@/lib/conversation-typing";
import { DmList } from "@/components/layout/dm-list";

const VIEWER = "00000000-0000-4000-8000-000000000000";

function convo(
  channelId: string,
  people: { id: string; displayName: string }[],
  extra: Partial<DmSummary> = {},
): DmSummary {
  return {
    channelId,
    kind: people.length > 1 ? "group" : "dm",
    participants: people.map((p) => ({ ...p, avatarUrl: null })),
    lastMessageAt: "2026-10-11T20:41:00.000Z",
    unread: { count: 0, mentions: 0 },
    lastMessage: {
      authorId: people[0]!.id,
      authorName: people[0]!.displayName,
      preview: `oi de ${people[0]!.displayName}`,
      isAttachment: false,
      isGif: false,
    },
    ...extra,
  } as DmSummary;
}

const rafa = convo("c-rafa", [{ id: "u-rafa", displayName: "Rafa" }]);
const gabi = convo("c-gabi", [{ id: "u-gabi", displayName: "Gabi" }]);
const group = convo("c-group", [
  { id: "u-caio", displayName: "Caio" },
  { id: "u-kata", displayName: "Kata" },
]);

function friends(): FriendsState {
  return {
    data: {
      friends: [
        {
          id: "u-gabi",
          displayName: "Gabi",
          avatarUrl: null,
          status: "online",
          friendsSince: "2026-01-01T00:00:00.000Z",
        },
      ],
      incoming: [],
      outgoing: [],
    },
    pendingDepoimentos: [],
    loading: false,
    error: null,
    refresh: async () => {},
    send: async () => "pending",
    accept: async () => {},
    remove: async () => {},
    approveDepoimento: async () => {},
    removeDepoimento: async () => {},
    applyNudge: () => {},
    nudge: null,
    clearNudge: () => {},
    retainLive: () => () => {},
  } as FriendsState;
}

function render(home: boolean, extra: Partial<Parameters<typeof DmList>[0]> = {}) {
  return renderToStaticMarkup(
    <FriendsContext.Provider value={friends()}>
      <TooltipProvider>
        <DmList
          home={home}
          conversations={[rafa, gabi, group]}
          selectedChannelId={null}
          unread={{ "c-gabi": { count: 3, mentions: 0 }, "c-group": { count: 1, mentions: 0 } }}
          blockedUserIds={new Set()}
          viewerId={VIEWER}
          onSelectConversation={() => {}}
          onStartConversation={() => {}}
          onOpenFriends={() => {}}
          friendRequestCount={2}
          onHideConversation={() => {}}
          pinnedChannelIds={new Set(["c-rafa"])}
          onTogglePin={() => {}}
          onBlockUser={() => {}}
          onUnblockUser={() => {}}
          {...extra}
        />
      </TooltipProvider>
    </FriendsContext.Provider>,
  );
}

afterEach(() => {
  resetListTypingForTests();
});

describe("DmList with Conversas off", () => {
  it("is the classic list: no Conversas column, the Amigos row is still there", () => {
    const html = render(false);
    expect(html).not.toContain("data-conversations=");
    expect(html).not.toContain("data-conversation-row");
  });

  it("centres the unread digits in their pill", () => {
    const html = render(false);
    const badge = /<span[^>]*data-dm-unread[^>]*>/.exec(html)?.[0] ?? "";
    expect(badge).toContain("items-center");
    expect(badge).toContain("justify-center");
    expect(badge).toContain("text-on-danger");
  });
});

describe("DmList with Conversas on", () => {
  it("puts pinned rows under Fixadas and the rest under Recentes", () => {
    const html = render(true);
    const pinned = /data-conversations-section="pinned"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    const recent = /data-conversations-section="recent"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    expect(pinned).toContain("Rafa");
    expect(pinned).not.toContain("Gabi");
    expect(recent).toContain("Gabi");
    expect(recent).toContain("Caio, Kata");
  });

  it("marks unread rows, counts unread conversations on the chip, and badges friend requests", () => {
    const html = render(true);
    expect(html.match(/data-unread=""/g)).toHaveLength(2);
    expect(html).toContain('data-conversations-unread-count="2"');
    expect(html).toContain('data-friend-requests="2"');
  });

  it("draws presence for a friend only", () => {
    const html = render(true);
    const gabiRow = /data-flip-key="c-gabi"[\s\S]*?data-conversations-preview/.exec(html)?.[0] ?? "";
    const rafaRow = /data-flip-key="c-rafa"[\s\S]*?data-conversations-preview/.exec(html)?.[0] ?? "";
    expect(gabiRow).toContain('role="img"');
    expect(rafaRow).not.toContain('role="img"');
  });

  it("says who is typing instead of the preview, but not for the open conversation", () => {
    noteListTyping("c-gabi", "u-gabi", "Gabi");
    noteListTyping("c-group", "u-kata", "Kata Souza");
    const html = render(true);
    expect(html).toMatch(/data-flip-key="c-gabi"[\s\S]*?data-conversations-typing/);
    expect(html).toContain("Kata is typing…");
    const open = render(true, { selectedChannelId: "c-gabi" });
    const openRow = /<div[^>]*data-flip-key="c-gabi"[^>]*>/.exec(open)?.[0] ?? "";
    expect(openRow).toContain("data-selected");
    expect(openRow).not.toContain("data-typing");
  });
});
