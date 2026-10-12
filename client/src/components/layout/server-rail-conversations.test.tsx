import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { DmSummary } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setChannelNotificationLevel } from "@/lib/notifications";
import { ServerRail } from "./server-rail";

function convo(channelId: string, name: string): DmSummary {
  return {
    channelId,
    kind: "dm",
    participants: [{ id: `u-${channelId}`, displayName: name, avatarUrl: null }],
    lastMessageAt: "2026-10-11T20:00:00.000Z",
    unread: { count: 0, mentions: 0 },
    lastMessage: null,
  } as DmSummary;
}

const people = ["a", "b", "c", "d", "e"].map((id) => convo(id, id.toUpperCase()));

function rail(extra: Partial<Parameters<typeof ServerRail>[0]> = {}) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ServerRail
        servers={[]}
        selectedServerId={null}
        serverUnread={{}}
        homeSelected={false}
        homeUnread={{ count: 47, mentions: 0 }}
        onSelectHome={() => {}}
        onSelectServer={() => {}}
        onCreateServer={() => {}}
        onJoinServer={() => {}}
        onInvite={() => {}}
        onOpenMembers={() => {}}
        onOpenSettings={() => {}}
        onLeaveServer={() => {}}
        conversations={people}
        pinnedUnread={{
          a: { count: 40, mentions: 0 },
          b: { count: 5, mentions: 1 },
          c: { count: 1, mentions: 0 },
          d: { count: 1, mentions: 0 },
          e: { count: 0, mentions: 0 },
        }}
        {...extra}
      />
    </TooltipProvider>,
  );
}

afterEach(() => {
  setChannelNotificationLevel("d", null);
});

describe("the rail with Conversas off", () => {
  it("is what it was: the door badges messages, no label, no faces", () => {
    const html = rail();
    expect(html).not.toContain("data-rail-conversations-label");
    expect(html).not.toContain('data-rail-conversation="waiting"');
    expect(html).toMatch(/>47</);
  });
});

describe("the rail with Conversas on", () => {
  it("labels the door and badges conversations waiting, not messages", () => {
    const html = rail({ conversationsHome: true });
    expect(html).toContain("data-rail-conversations-label");
    expect(html).toContain('data-conversations-waiting="4"');
  });

  it("surfaces three faces and folds the rest into +N", () => {
    const html = rail({ conversationsHome: true });
    expect(html.match(/data-rail-conversation="waiting"/g)).toHaveLength(3);
    expect(html).toContain('data-rail-conversations-more="1"');
  });

  it("never surfaces or counts the open conversation, a muted one, or a pinned one twice", () => {
    setChannelNotificationLevel("d", "none");
    const html = rail({
      conversationsHome: true,
      openConversationId: "a",
      pinnedConversations: [people[1]!],
    });
    // b, c waiting (a is open, d is muted); b is pinned, so it keeps its own
    // slot and only c surfaces as a face.
    expect(html).toContain('data-conversations-waiting="2"');
    expect(html.match(/data-rail-conversation="waiting"/g)).toHaveLength(1);
    expect(html.match(/data-rail-conversation="pinned"/g)).toHaveLength(1);
    expect(html).not.toContain("data-rail-conversations-more");
  });
});
