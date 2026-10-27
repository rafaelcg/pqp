import type { DmSummary, PublicUser, Server } from "@pqp/shared";
import type { ReactNode } from "react";
import { ServerRail } from "@/components/layout/server-rail";

/**
 * The shell's pieces on `/qa/ui`, drawn by the real components with made-up
 * data, so a council shot shows every state at once. Each block is a
 * `data-testid` the council shot spec frames (`qa-shell-*`).
 */

const noop = () => {};

function person(id: string, displayName: string, avatarUrl: string | null = null): PublicUser {
  return { id, displayName, avatarUrl, tag: null, username: id, customStatus: null };
}

function conversation(channelId: string, people: PublicUser[]): DmSummary {
  return { channelId, participants: people } as unknown as DmSummary;
}

function server(id: string, name: string, extra: Partial<Server> = {}): Server {
  return { id, name, iconUrl: null, role: "member", ...extra } as Server;
}

const BIA = person("bia", "Bia");
const CAIO = person("caio", "Caio", "https://api.dicebear.com/9.x/shapes/png?seed=caio");
const RAFA = person("rafa", "Rafa", "https://api.dicebear.com/9.x/shapes/png?seed=relay");

/** Left rail: the conversations door is open, people are waiting. */
const HOME_SERVERS = [
  server("oficina", "Oficina"),
  server("memes", "Memes"),
  server("fliperama", "Turma do Fliperama"),
];

/** Right rail: a server is open; the others carry the server cues. */
const SERVER_SERVERS = [
  server("fliperama", "Turma do Fliperama"),
  server("memes", "Memes"),
  server("cinema", "Cineclube", { iconUrl: "https://api.dicebear.com/9.x/shapes/png?seed=cinema" }),
  server("bau", "Baú da Bia"),
  server("praca", "Praça", { isCommunity: true }),
];

function RailFrame({ children }: { children: ReactNode }) {
  // The canvas the rail sits on, and the edge of the side pane beside it.
  return (
    <div className="flex h-[680px] overflow-hidden rounded-lg bg-rail redesign:bg-canvas">
      {children}
      <div className="my-2 w-6 rounded-l-[var(--radius-pane)] bg-surface-1 redesign:bg-pane-side" />
    </div>
  );
}

export function ShellSheet() {
  return (
    <div className="flex flex-col gap-6">
      {/* Server rail. Left: Conversas open, two friend requests, two people
          waiting and a pinned conversation; Oficina unread, Memes with three
          mentions. Right: a server open; a photo icon, a Baú count, a Baú ring
          beside a mention, a live party, a public community, Novidades
          unread. */}
      <div data-testid="qa-shell-rail" className="flex gap-6">
        <RailFrame>
          <ServerRail
            servers={HOME_SERVERS}
            selectedServerId={null}
            serverUnread={{ oficina: { count: 4, mentions: 0 }, memes: { count: 3, mentions: 3 } }}
            homeSelected
            homeUnread={{ count: 2, mentions: 0 }}
            friendRequestCount={2}
            conversationsHome
            conversations={[conversation("dm-bia", [BIA]), conversation("dm-caio", [CAIO])]}
            pinnedConversations={[conversation("dm-rafa", [RAFA])]}
            pinnedUnread={{ "dm-bia": { count: 2, mentions: 0 }, "dm-caio": { count: 1, mentions: 1 } }}
            onSelectHome={noop}
            onSelectServer={noop}
            onCreateServer={noop}
            onJoinServer={noop}
            onInvite={noop}
            onOpenMembers={noop}
            onOpenSettings={noop}
            onLeaveServer={noop}
            onOpenCommunities={noop}
          />
        </RailFrame>
        <RailFrame>
          <ServerRail
            servers={SERVER_SERVERS}
            communitiesEnabled
            selectedServerId="fliperama"
            serverUnread={{ memes: { count: 5, mentions: 12 }, bau: { count: 0, mentions: 0 } }}
            serverBauUnread={{ bau: 3, memes: 2 }}
            liveServerIds={new Set(["cinema"])}
            homeSelected={false}
            homeUnread={{ count: 0, mentions: 0 }}
            onSelectHome={noop}
            onSelectServer={noop}
            onCreateServer={noop}
            onJoinServer={noop}
            onInvite={noop}
            onOpenMembers={noop}
            onOpenSettings={noop}
            onLeaveServer={noop}
            onOpenWhatsNew={noop}
            whatsNewUnread
            onOpenCommunities={noop}
          />
        </RailFrame>
      </div>
    </div>
  );
}
