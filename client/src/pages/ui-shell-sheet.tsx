import type {
  Channel,
  DmSummary,
  PublicUser,
  Server,
  ThreadSummary,
  VoiceParticipant,
  WatchParty,
} from "@pqp/shared";
import { useEffect, type ComponentProps, type ReactNode } from "react";
import { CommunityHomePreview } from "@/components/community-home/community-home-preview";
import {
  CategoryHeader,
  ChannelRow,
  ChannelSection,
  SidebarThreadRow,
  channelRowIconClass,
} from "@/components/layout/channel-list";
import { ChannelIcon } from "@/components/layout/channel-icon";
import { VoiceOccupantRow } from "@/components/layout/voice-occupant-row";
import { ChannelMusicCard } from "@/components/voice/channel-music-card";
import {
  MixedCategoryHeader,
  type CategoryHeaderDrag,
} from "@/components/layout/channel-list-mixed";
import { ServerRail } from "@/components/layout/server-rail";
import { LivePartyBlock } from "@/components/watch-party/live-party-block";
import { ServerIcon } from "@/components/layout/server-identity";
import type { LatestCard, LatestPreview } from "@/lib/community-home/latest";
import { setUpdateWaiting } from "@/lib/update-prompt-state";

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

/** A live party, as the server sends it; only what the block reads matters. */
function party(id: string, name: string, host: string, state: WatchParty["state"] = "live"): WatchParty {
  return {
    id: `00000000-0000-4000-8000-0000000000${id}`,
    channelId: `00000000-0000-4000-8000-0000000001${id}`,
    serverId: null,
    name,
    description: null,
    state,
    startsAt: null,
    wentLiveAt: state === "live" ? new Date(Date.now() - 47 * 60_000).toISOString() : null,
    endedAt: null,
    hostUserId: `00000000-0000-4000-8000-0000000002${id}`,
    hostDisplayName: host,
    hostAvatarUrl: null,
    hostDisconnectedAt: null,
  } as unknown as WatchParty;
}

function post(id: string, title: string, isNew: boolean, mediaKind: LatestCard["mediaKind"] = null): LatestCard {
  return {
    postId: `00000000-0000-4000-8000-0000000003${id}`,
    serverId: "00000000-0000-4000-8000-000000000400",
    serverName: "Turma do Fliperama",
    title,
    teaser: null,
    author: { id: "00000000-0000-4000-8000-000000000500", displayName: "Bia", avatarUrl: null },
    mediaKind,
    mediaUrl: null,
    posterUrl: null,
    visibility: "free",
    locked: false,
    pinned: false,
    likeCount: 12,
    commentCount: 3,
    publishedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    isNew,
  };
}

const BAU_NEW: LatestPreview = {
  unread: 2,
  lastSeenAt: null,
  posts: [post("01", "O mapa novo da caverna", true, "image"), post("02", "Fotos do encontro", true)],
};
const BAU_SEEN: LatestPreview = { unread: 0, lastSeenAt: null, posts: [post("03", "Regras do servidor", false)] };
const BAU_EMPTY: LatestPreview = { unread: 0, lastSeenAt: null, posts: [] };

function category(id: string, name: string): Channel {
  return { id, name, type: "category", serverId: "fliperama", parentId: null, position: 0 } as unknown as Channel;
}

function drag(drop: CategoryHeaderDrag["drop"] = null): CategoryHeaderDrag {
  return {
    draggable: false,
    dragging: false,
    drop,
    onDragStart: noop,
    onDragEnd: noop,
    onDragOver: noop,
    onDragLeave: noop,
    onDrop: noop,
  };
}

const ADD_ITEMS = [
  { id: "text", label: "Canal de texto", onSelect: noop },
  { id: "voice", label: "Canal de voz", onSelect: noop },
];

const fold = (collapsed: boolean, childCount: number, hasUnread = false) => ({
  collapsed,
  onToggle: noop,
  childCount,
  hasUnread,
});

function textChannel(id: string, name: string, extra: Partial<Channel> = {}): Channel {
  return {
    id: `qa-channel-${id}`,
    name,
    type: "text",
    serverId: "fliperama",
    parentId: null,
    position: 0,
    isPrivate: false,
    imageUrl: null,
    topic: null,
    ...extra,
  } as unknown as Channel;
}

/** One channel row with every handler a no-op; pass the state that differs. */
function SheetChannelRow({
  channel,
  selected = false,
  ...rest
}: { channel: Channel; selected?: boolean } & Partial<ComponentProps<typeof ChannelRow>>) {
  return (
    <ChannelRow
      channel={channel}
      selected={selected}
      unread={{ count: 0, mentions: 0 }}
      canManage
      icon={<ChannelIcon channel={channel} className={channelRowIconClass(channel, selected)} />}
      isDragging={false}
      isDragOver={false}
      onSelect={noop}
      onOpenSettings={noop}
      onDelete={noop}
      categories={[]}
      onMoveToCategory={noop}
      onDragStart={noop}
      onDragEnd={noop}
      onDragOverRow={noop}
      onDrop={noop}
      {...rest}
    />
  );
}

function thread(id: string, name: string): ThreadSummary {
  return {
    channelId: `qa-thread-${id}`,
    parentChannelId: "qa-channel-papo",
    rootMessageId: null,
    name,
    replyCount: 4,
    lastActivityAt: new Date().toISOString(),
    archived: false,
  } as unknown as ThreadSummary;
}

/** A slice of the side pane, as wide as the sidebar. */
function SidePane({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-64 flex-col gap-2 rounded-lg bg-surface-1 p-3 redesign:rounded-[var(--radius-pane)] redesign:bg-pane-side">
      {children}
    </div>
  );
}

function RailFrame({ children }: { children: ReactNode }) {
  // The canvas the rail sits on, and the edge of the side pane beside it.
  return (
    <div className="flex h-[680px] overflow-hidden rounded-lg bg-rail redesign:bg-canvas">
      {children}
      <div className="my-2 w-6 rounded-l-[var(--radius-pane)] bg-surface-1 redesign:bg-pane-side" />
    </div>
  );
}

function seat(id: string, displayName: string, extra: Partial<VoiceParticipant> = {}): VoiceParticipant {
  return {
    peerId: `qa-peer-${id}`,
    userId: `qa-user-${id}`,
    displayName,
    avatarUrl: null,
    sharingScreen: false,
    muted: false,
    deafened: false,
    serverMuted: false,
    ...extra,
  } as VoiceParticipant;
}

const SEATS: { person: VoiceParticipant; speaking?: boolean; hand?: number }[] = [
  { person: { ...seat("rafa", "Rafa"), avatarUrl: "https://api.dicebear.com/9.x/shapes/png?seed=relay" }, speaking: true },
  { person: seat("bia", "Bia", { muted: true }) },
  { person: seat("caio", "Caio", { deafened: true, muted: true }) },
  { person: seat("lia", "Lia", { sharingScreen: true, cameraStreamId: "cam" }) },
  { person: seat("teo", "Téo", { handRaisedAt: Date.now() }), hand: 1 },
];

/** Voice rows: the room you are in with five people and the music it plays, and an empty room. */
function VoiceRowsBlock() {
  const lobby = textChannel("lobby", "Lobby", { type: "voice" });
  return (
    <div data-testid="qa-shell-voice-rows" className="flex flex-wrap items-start gap-6">
      <SidePane>
        <div className="flex flex-col gap-0.5">
          <SheetChannelRow channel={lobby} connected onJoinVoice={noop} />
          <ChannelMusicCard
            channelId={lobby.id}
            track={{ videoId: "qa", title: "Lo-fi pra jogar junto", thumbnailUrl: null, listeners: 3 }}
            inCall
          />
          <ul className="ml-2 space-y-0.5 border-l border-ink-4/70 py-0.5 pl-2 redesign:ml-5 redesign:border-[color:var(--card-border)] redesign:pl-1.5">
            {SEATS.map(({ person, speaking, hand }) => (
              <VoiceOccupantRow
                key={person.peerId}
                person={person}
                channelId={lobby.id}
                isSpeaking={Boolean(speaking)}
                handPosition={hand ?? null}
                canDrag={false}
                items={[]}
                onDragStart={noop}
                onDragEnd={noop}
              />
            ))}
          </ul>
          <SheetChannelRow channel={textChannel("sala", "sala-do-jogo", { type: "voice" })} onJoinVoice={noop} />
          <ChannelMusicCard
            channelId="qa-channel-sala"
            track={{ videoId: "qa2", title: "Trilha do campeonato", thumbnailUrl: null, listeners: 1 }}
            inCall={false}
            onJoin={noop}
          />
        </div>
      </SidePane>
    </div>
  );
}

function ChannelRowsBlock() {
  return (
    <div data-testid="qa-shell-channel-rows" className="flex flex-wrap items-start gap-6">
      <SidePane>
        <div className="flex flex-col gap-0.5">
          <SheetChannelRow channel={textChannel("general", "general")} />
          <SheetChannelRow channel={textChannel("avisos", "avisos")} unread={{ count: 4, mentions: 0 }} />
          <SheetChannelRow channel={textChannel("papo", "papo")} selected />
          <ul className="ml-2 space-y-0.5 border-l border-border/70 py-0.5 pl-2 redesign:ml-5 redesign:border-[color:var(--card-border)] redesign:pl-1.5">
            <SidebarThreadRow thread={thread("1", "build do sábado")} unread onOpen={noop} onLeave={noop} />
            <SidebarThreadRow thread={thread("2", "regras do campeonato")} unread={false} onOpen={noop} onLeave={noop} />
          </ul>
          <SheetChannelRow channel={textChannel("anuncios", "anúncios")} unread={{ count: 9, mentions: 3 }} />
          <SheetChannelRow channel={textChannel("staff", "staff", { isPrivate: true })} />
          <SheetChannelRow channel={textChannel("fixado", "regras")} isFavorite onToggleFavorite={noop} />
          <SheetChannelRow channel={textChannel("clipes", "clipes")} onToggleFavorite={noop} />
        </div>
      </SidePane>
      <SidePane>
        <div className="flex flex-col gap-0.5">
          <SheetChannelRow channel={textChannel("ajuda", "ajuda", { type: "forum" })} />
          <SheetChannelRow
            channel={textChannel("cinema", "cinema", { type: "watch_party", topic: "Sessão de terror" })}
            liveState={{ live: true, presenterPeerId: "p1", viewerCount: 12, startedAt: null } as never}
          />
          <SheetChannelRow
            channel={textChannel("cine2", "cineclube", { type: "watch_party", topic: "Clássicos de domingo" })}
            liveState={{ live: false, presenterPeerId: null, viewerCount: 0, startedAt: null } as never}
          />
        </div>
      </SidePane>
    </div>
  );
}

/**
 * A new build waiting, so both rails draw the update tile. The store is
 * this page's own; it goes back to nothing waiting when the sheet unmounts.
 */
function useUpdateWaitingFixture() {
  useEffect(() => {
    setUpdateWaiting(true);
    return () => setUpdateWaiting(false);
  }, []);
}

export function ShellSheet() {
  useUpdateWaitingFixture();
  return (
    <div className="flex flex-col gap-6">
      {/* Server rail. Left: Conversas open, two friend requests, two people
          waiting and a pinned conversation; Oficina unread, Memes with three
          mentions. Right: a server open; a photo icon, a Baú count, a Baú ring
          beside a mention, a live party, a public community, Novidades
          unread. Both: a new build waiting (the update tile). */}
      {/* The blocks above the channels. Left: two live parties (one open)
          and the Baú with new posts as a card. Middle: a party being set up,
          the waitlist teaser, the Baú with nothing new (a row) and opened.
          Right: "start a party" and an empty Baú for staff. */}
      <div data-testid="qa-shell-sidebar-special" className="flex flex-wrap items-start gap-6">
        <SidePane>
          <LivePartyBlock
            parties={[party("01", "Sessão de terror", "Rafa"), party("02", "Campeonato de Mario Kart", "Caio")]}
            selectedChannelId="00000000-0000-4000-8000-000000000101"
            audience={{ "00000000-0000-4000-8000-000000000101": 14, "00000000-0000-4000-8000-000000000102": 6 }}
            onWatch={noop}
            historyChannels={[{ id: "h1", name: "cinema" }]}
            onOpenHistory={noop}
          />
          <CommunityHomePreview
            latest={BAU_NEW}
            serverName="Turma do Fliperama"
            serverHueSeed="fliperama"
            selected={false}
            canPost={false}
            face={<ServerIcon name="Turma do Fliperama" iconUrl={null} />}
            onOpen={noop}
            onOpenPost={noop}
            onCompose={noop}
          />
        </SidePane>
        <SidePane>
          <LivePartyBlock parties={[]} selectedChannelId={null} pending={party("03", "Maratona de Zelda", "Lia", "scheduled")} onWatch={noop} />
          <LivePartyBlock parties={[]} selectedChannelId={null} onWatch={noop} teaser={{ onList: true, onOpen: noop }} />
          <CommunityHomePreview
            latest={BAU_SEEN}
            serverName="Turma do Fliperama"
            serverHueSeed="fliperama"
            selected
            canPost={false}
            face={<ServerIcon name="Turma do Fliperama" iconUrl={null} />}
            onOpen={noop}
            onOpenPost={noop}
            onCompose={noop}
          />
        </SidePane>
        <SidePane>
          <LivePartyBlock parties={[]} selectedChannelId={null} canStart onCreate={noop} onWatch={noop} />
          <CommunityHomePreview
            latest={BAU_EMPTY}
            serverName="Turma do Fliperama"
            serverHueSeed="fliperama"
            selected={false}
            canPost
            face={<ServerIcon name="Turma do Fliperama" iconUrl={null} />}
            onOpen={noop}
            onOpenPost={noop}
            onCompose={noop}
          />
        </SidePane>
      </div>

      {/* Category headers. Left, the classic list: Texto open with the
          manager's "+" and lock, Voz folded with an unread channel, Texto as
          a drop target, a category open and a category folded. Right, the
          mixed list: open with "+", folded with an unread channel, and a
          channel being dropped into it. */}
      <div data-testid="qa-shell-categories" className="flex flex-wrap items-start gap-6">
        <SidePane>
          <ChannelSection label="Texto" fold={fold(false, 3)} canManage onAdd={noop} onAddPrivate={noop}>
            {null}
          </ChannelSection>
          <ChannelSection label="Voz" fold={fold(true, 2, true)} canManage={false} onAdd={noop} onAddPrivate={noop}>
            {null}
          </ChannelSection>
          <ChannelSection label="Texto" fold={fold(false, 3)} canManage={false} onAdd={noop} onAddPrivate={noop} isDragOver>
            {null}
          </ChannelSection>
          <CategoryHeader
            category={category("c1", "Jogos da semana")}
            controlsId="qa-category-1"
            canManage
            onRename={noop}
            onDelete={noop}
            isDragOver={false}
            onDragStart={noop}
            onDragEnd={noop}
            onDragOverRow={noop}
            onDrop={noop}
            {...fold(false, 4)}
          />
          <CategoryHeader
            category={category("c2", "Arquivo")}
            controlsId="qa-category-2"
            canManage
            onRename={noop}
            onDelete={noop}
            isDragOver={false}
            onDragStart={noop}
            onDragEnd={noop}
            onDragOverRow={noop}
            onDrop={noop}
            {...fold(true, 6, true)}
          />
        </SidePane>
        <SidePane>
          <MixedCategoryHeader
            category={category("m1", "Canais")}
            addItems={ADD_ITEMS}
            menuItems={[]}
            drag={drag()}
            {...fold(false, 5)}
          />
          <MixedCategoryHeader
            category={category("m2", "Bate-papo")}
            addItems={ADD_ITEMS}
            menuItems={[]}
            drag={drag()}
            {...fold(true, 4, true)}
          />
          <MixedCategoryHeader
            category={category("m3", "Jogos")}
            addItems={ADD_ITEMS}
            menuItems={[]}
            drag={drag("into")}
            {...fold(false, 2)}
          />
        </SidePane>
      </div>

      {/* Channel rows. Left: plain, unread, selected with its threads (one
          unread), mentions, private, pinned, and "clipes" for the
          hover. Right: a forum and a live watch party room. */}
      <ChannelRowsBlock />

      {/* Voice rows. The room you are in (its music, five seats: speaking,
          muted, deafened, sharing with the camera on, first in the hand
          queue), and a room with music you are not in. */}
      <VoiceRowsBlock />

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
