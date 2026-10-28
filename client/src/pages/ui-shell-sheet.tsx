import { messageSchema } from "@pqp/shared";
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
import { cn } from "@/lib/utils";
import { CommunityHomePreview } from "@/components/community-home/community-home-preview";
import {
  CategoryHeader,
  ChannelRailItem,
  ChannelRow,
  ChannelSection,
  CommunityHomeNavButton,
  SidebarThreadRow,
  channelRowIconClass,
} from "@/components/layout/channel-list";
import { ChannelIcon } from "@/components/layout/channel-icon";
import { UserPanel } from "@/components/layout/user-panel";
import { MessageList, type MessageAuthorInfo } from "@/components/chat/message-list";
import type { ChatMessage } from "@/hooks/use-chat";
import { ConnectionBanner } from "@/components/layout/connection-banner";
import { ArrivalBanner } from "@/components/onboarding/arrival-banner";
import { BringCrewStrip } from "@/components/onboarding/bring-crew-strip";
import { DiscordImportNotice } from "@/components/onboarding/discord-import-notice";
import { NewcomerInviteStrip } from "@/components/onboarding/newcomer-invite-strip";
import { UpcomingSessionCard } from "@/components/voice/upcoming-session-card";
import { WatchNowBanner } from "@/components/watch-now/watch-now-banner";
import { VoiceStatusBar } from "@/components/voice/voice-status-bar";
import { VoiceOccupantRow } from "@/components/layout/voice-occupant-row";
import { ChannelMusicCard } from "@/components/voice/channel-music-card";
import {
  MixedCategoryHeader,
  type CategoryHeaderDrag,
} from "@/components/layout/channel-list-mixed";
import { ServerRail } from "@/components/layout/server-rail";
import { communitySummarySchema } from "@pqp/shared";
import { CommunityCard, CommunityCardSkeleton } from "@/components/communities/community-card";
import { LivePartyBlock } from "@/components/watch-party/live-party-block";
import { ServerIcon } from "@/components/layout/server-identity";
import type { LatestCard, LatestPreview } from "@/lib/community-home/latest";
import { CornerCard } from "@/components/layout/corner-card";
import { FirstRunCard } from "@/components/onboarding/first-run-card";
import { Button } from "@/components/ui/button";
import { AppSessionCard } from "@/components/apps/app-session-card";
import { AppSessionStrip } from "@/components/apps/app-session-strip";
import type { CardPerson, EndedCardModel, LiveCardModel } from "@/lib/apps/card-model";
import type { EndedStripModel, LiveStripModel } from "@/lib/apps/strip-model";
import { setUpdateWaiting } from "@/lib/update-prompt-state";
import { AppBootstrapError, AppLoadingShell } from "@/components/layout/app-loading-shell";
import { MusicQueueSpecimen } from "@/pages/qa-music-queue";

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
      icon={<ChannelIcon channel={channel} className={channelRowIconClass(channel, selected, rest.connected)} />}
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
          {/* The party you are watching from, not open: the success fill. */}
          <SheetChannelRow
            channel={textChannel("cine3", "sessão da tarde", { type: "watch_party", topic: "Com a turma" })}
            liveState={{ live: true, presenterPeerId: "p2", viewerCount: 5, startedAt: null } as never}
            connected
          />
          {/* Connected with something unread: the pip takes the dot's place. */}
          <SheetChannelRow
            channel={textChannel("cine4", "maratona", { type: "watch_party", topic: "Trilogia inteira" })}
            liveState={{ live: true, presenterPeerId: "p3", viewerCount: 3, startedAt: null } as never}
            unread={{ count: 2, mentions: 0 }}
            connected
          />
        </div>
      </SidePane>
    </div>
  );
}

/** One icons-only sidebar: the side pane at the strip's 72px. */
function StripPane({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-[72px] flex-col items-center gap-1 rounded-lg bg-surface-1 px-2 py-3 redesign:gap-1.5 redesign:rounded-[var(--radius-pane)] redesign:bg-pane-side">
      {children}
    </div>
  );
}

function StripGroup({ first = false, children }: { first?: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex w-full flex-col items-center gap-1 redesign:gap-1.5",
        !first && "mt-1 border-t border-ink-4/50 pt-2 redesign:border-[color:var(--card-border)]",
        // Under a Baú the first group takes the rule too, as in the app.
        first && "redesign:mt-1 redesign:border-t redesign:pt-2 redesign:border-[color:var(--card-border)]",
      )}
    >
      {children}
    </div>
  );
}

const NOTHING_UNREAD = { count: 0, mentions: 0 };

function SidebarStripBlock() {
  const tile = (channel: Channel, extra: Partial<ComponentProps<typeof ChannelRailItem>> = {}) => (
    <ChannelRailItem
      key={channel.id}
      channel={channel}
      selected={false}
      connected={false}
      unread={NOTHING_UNREAD}
      occupants={0}
      onSelect={noop}
      {...extra}
    />
  );
  return (
    <div data-testid="qa-shell-sidebar-strip" className="flex flex-wrap items-start gap-6">
      {/* Left: the Baú with new posts; plain, unread, open, mentions and a
          private channel; then the call you are in, a room with people and a
          live watch party. Right: the Baú open, a forum. */}
      <StripPane>
        <CommunityHomeNavButton
          server={{ name: "Turma do Fliperama", iconUrl: null, isCommunity: false, communitySlug: null }}
          selected={false}
          unread={3}
          showNew={false}
          compact
          onSelect={noop}
        />
        <StripGroup first>
          {tile(textChannel("general", "general"))}
          {tile(textChannel("avisos", "avisos"), { unread: { count: 4, mentions: 0 } })}
          {tile(textChannel("papo", "papo"), { selected: true })}
          {tile(textChannel("anuncios", "anúncios"), { unread: { count: 9, mentions: 3 } })}
          {tile(textChannel("staff", "staff", { isPrivate: true }))}
        </StripGroup>
        <StripGroup>
          {tile(textChannel("lobby", "Lobby", { type: "voice" }), { connected: true, occupants: 4, onJoinVoice: noop })}
          {tile(textChannel("jogo", "sala-do-jogo", { type: "voice" }), { occupants: 2, onJoinVoice: noop })}
          {tile(textChannel("cinema", "cinema", { type: "watch_party" }), {
            occupants: 12,
            liveState: { live: true, presenterPeerId: "p1", viewerCount: 12, startedAt: null } as never,
          })}
        </StripGroup>
      </StripPane>
      <StripPane>
        <CommunityHomeNavButton
          server={{ name: "Turma do Fliperama", iconUrl: null, isCommunity: false, communitySlug: null }}
          selected
          unread={0}
          showNew={false}
          compact
          onSelect={noop}
        />
        <StripGroup first>
          {tile(textChannel("ajuda", "ajuda", { type: "forum" }))}
          {tile(textChannel("clipes", "clipes"))}
        </StripGroup>
        <StripGroup>
          {/* In the call and viewing it: the solid green edge. */}
          {tile(textChannel("lobby2", "Lobby", { type: "voice" }), { connected: true, selected: true, occupants: 3, onJoinVoice: noop })}
        </StripGroup>
      </StripPane>
    </div>
  );
}

/** The sidebar's footer, at the sidebar's width, so the strip sits as it does above the user panel. */
function FooterPane({ children, width = "w-64" }: { children: ReactNode; width?: string }) {
  return (
    <div className={cn("flex flex-col justify-end rounded-lg bg-surface-1 pt-3 redesign:rounded-[var(--radius-pane)] redesign:bg-pane-side", width)}>
      {children}
    </div>
  );
}

function VoiceStripBlock() {
  const base = {
    channelName: "Lobby",
    isMuted: false,
    onOpen: noop,
    onLeave: noop,
    onToggleCamera: noop,
    onToggleScreenShare: noop,
    canShareScreen: true,
  } as const;
  return (
    <div data-testid="qa-shell-voice-strip" className="flex flex-wrap items-end gap-6">
      {/* Left: connected, the camera on. Then: connecting; listen only with
          push-to-talk idle and the share at its limit; a call in a text
          channel; the 72px strip. */}
      <FooterPane>
        <VoiceStatusBar {...base} status="connected" isCameraOn />
      </FooterPane>
      {/* Sharing the screen: the share pill pressed, its "on air" glyph. */}
      <FooterPane>
        <VoiceStatusBar {...base} status="connected" isSharingScreen />
      </FooterPane>
      <FooterPane>
        <VoiceStatusBar {...base} status="joining" />
      </FooterPane>
      <FooterPane>
        <VoiceStatusBar
          {...base}
          status="connected"
          listenOnly
          shareCappedOut
          shareLimit={2}
        />
      </FooterPane>
      <FooterPane>
        <VoiceStatusBar
          {...base}
          channelName="papo"
          channelType="text"
          status="connected"
          inputMode="push-to-talk"
          isTransmitting={false}
          canStream={false}
        />
      </FooterPane>
      <FooterPane width="w-[72px]">
        <VoiceStatusBar {...base} status="connected" compact />
      </FooterPane>
    </div>
  );
}

function UserPanelBlock() {
  const base = {
    displayName: "Lia",
    tag: "lia#3716",
    isMuted: false,
    isDeafened: false,
    inVoice: false,
    showUserButton: false,
    manualStatus: "online",
    effectiveStatus: "online",
    statusSaving: false,
    statusError: null,
    onSetStatus: noop,
    customStatus: "",
    customStatusSaving: false,
    customStatusError: null,
    onSetCustomStatus: noop,
    onClearCustomStatusError: noop,
    onToggleMute: noop,
    onToggleDeafen: noop,
    onOpenSettings: noop,
    onOpenFeedback: noop,
    onOpenProfile: noop,
    hideDownloadHint: true,
  } as const;
  return (
    <div data-testid="qa-shell-user-panel" className="flex flex-wrap items-end gap-6">
      {/* Off a call (mute and deafen disabled), with a handle. In a call:
          the mic off; deafened; muted by a moderator; Não Perturbe. Then
          invisible, and the 72px strip. */}
      <FooterPane>
        <UserPanel {...base} handle="lia" hideDownloadHint={false} />
      </FooterPane>
      <FooterPane>
        <UserPanel {...base} inVoice isMuted />
      </FooterPane>
      <FooterPane>
        <UserPanel {...base} inVoice isDeafened />
      </FooterPane>
      <FooterPane>
        <UserPanel {...base} inVoice serverMuted />
      </FooterPane>
      {/* Listen only (audience mode): the mic locked, not unavailable. */}
      <FooterPane>
        <UserPanel {...base} inVoice canSpeak={false} />
      </FooterPane>
      <FooterPane>
        <UserPanel {...base} inVoice canSpeak={false} isMuted />
      </FooterPane>
      <FooterPane>
        <UserPanel {...base} manualStatus="dnd" effectiveStatus="dnd" />
      </FooterPane>
      <FooterPane>
        <UserPanel {...base} manualStatus="invisible" effectiveStatus="offline" />
      </FooterPane>
      <FooterPane width="w-[72px]">
        <UserPanel {...base} inVoice compact />
      </FooterPane>
    </div>
  );
}

/** The conversation pane, for the strips that sit under its header. */
function MainPane({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-[720px] max-w-full flex-col overflow-hidden rounded-lg bg-surface-0 pb-3 redesign:rounded-[var(--radius-pane)] redesign:bg-pane-main">
      {children}
    </div>
  );
}

const NOW = Date.UTC(2026, 9, 27, 20, 0);
const asyncNoop = () => Promise.resolve();

function BannersBlock() {
  return (
    <div data-testid="qa-shell-banners" className="flex flex-col gap-6">
      {/* Top: a live share (with a second one folded under "more"), the
          arrival strip for a member, and the owner's with "Copiar convite".
          Bottom: who came over from Discord, a newcomer alone, the Discord
          import notice, a scheduled session, and the connection strip as the
          banner they all follow. */}
      <MainPane>
        <WatchNowBanner
          now={NOW}
          streams={[
            { key: "a", channelId: "c1", kind: "voice", place: "Lobby", sharerUserId: "u1", sharerName: "Rafa", startedAt: NOW - 12 * 60_000, watching: 3, inRoom: false },
            { key: "b", channelId: "c2", kind: "party", place: "Sessão de terror", sharerUserId: "u2", sharerName: "Caio", startedAt: NOW - 3 * 60_000, watching: 14, inRoom: false },
          ]}
          onWatch={noop}
          onDismiss={noop}
        />
        <ArrivalBanner variant="text" serverName="Turma do Fliperama" channelName="general" onDismiss={noop} />
        <ArrivalBanner variant="owner" serverName="Turma do Fliperama" channelName="general" onCopyInvite={asyncNoop} onDismiss={noop} />
      </MainPane>
      <MainPane>
        <BringCrewStrip kind="arrived" count={4} serverName="Turma do Fliperama" resolveInviteCode={() => Promise.resolve("abc123")} onDismiss={noop} />
        <NewcomerInviteStrip onInvite={noop} onDismiss={noop} />
        <DiscordImportNotice serverId="fliperama" existing={false} onImport={noop} onDismiss={noop} />
        <UpcomingSessionCard
          session={{
            id: "00000000-0000-4000-8000-000000000201",
            channelId: "00000000-0000-4000-8000-000000000202",
            serverId: null,
            title: "Maratona de Zelda",
            description: null,
            coverImageUrl: null,
            startsAt: new Date(NOW + 2 * 3_600_000).toISOString(),
            status: "scheduled",
            createdBy: "00000000-0000-4000-8000-000000000203",
            createdAt: new Date(NOW).toISOString(),
            updatedAt: new Date(NOW).toISOString(),
            reminding: true,
          }}
          now={new Date(NOW)}
          canManage
          onToggleReminder={asyncNoop}
          onCancel={asyncNoop}
          onEdit={noop}
        />
        <ConnectionBanner status="reconnecting" refusedRepeatedly={false} onRetry={noop} onCheck={noop} onSignInAgain={noop} />
      </MainPane>
      {/* The harder states: a watch-now join that failed, and a session
          with no reminder set (the ghost "Lembrar"). */}
      <MainPane>
        <WatchNowBanner
          now={NOW}
          streams={[
            { key: "c", channelId: "c3", kind: "voice", place: "Lobby", sharerUserId: "u1", sharerName: "Rafa", startedAt: NOW - 4 * 60_000, watching: 2, inRoom: false },
          ]}
          failure="A transmissão terminou."
          onWatch={noop}
          onDismiss={noop}
        />
        <UpcomingSessionCard
          session={{
            id: "00000000-0000-4000-8000-000000000211",
            channelId: "00000000-0000-4000-8000-000000000212",
            serverId: null,
            title: "Noite do Mario Kart",
            description: null,
            coverImageUrl: null,
            startsAt: new Date(NOW + 26 * 3_600_000).toISOString(),
            status: "scheduled",
            createdBy: "00000000-0000-4000-8000-000000000203",
            createdAt: new Date(NOW).toISOString(),
            updatedAt: new Date(NOW).toISOString(),
            reminding: false,
          }}
          now={new Date(NOW)}
          canManage={false}
          onToggleReminder={asyncNoop}
          onCancel={asyncNoop}
          onEdit={noop}
        />
      </MainPane>
    </div>
  );
}

const ROW_CHANNEL = "00000000-0000-4000-8000-000000000301";
const ROW_ME = "00000000-0000-4000-8000-000000000302";
const ROW_RAFA = "00000000-0000-4000-8000-000000000303";
const ROW_BIA = "00000000-0000-4000-8000-000000000304";
const ROW_HOOK = "00000000-0000-4000-8000-000000000305";

function rowMessage(n: number, authorId: string, authorName: string, body: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    ...messageSchema.parse({
      id: `00000000-0000-4000-8000-0000000004${String(n).padStart(2, "0")}`,
      channelId: ROW_CHANNEL,
      authorId,
      authorName,
      authorTag: null,
      authorAvatarUrl: null,
      body,
      createdAt: new Date(NOW - (20 - n) * 60_000).toISOString(),
    }),
    ...extra,
  };
}

const ROW_MESSAGES: ChatMessage[] = [
  rowMessage(1, ROW_RAFA, "Rafa", "alguém on hoje à noite pra fechar aquela campanha?"),
  rowMessage(2, ROW_RAFA, "Rafa", "trouxe o mapa novo, ficou insano", { editedAt: new Date(NOW - 15 * 60_000).toISOString() }),
  rowMessage(3, ROW_RAFA, "Rafa", "@lia cê vem?"),
  // A second mention right under it, so the joined corners show.
  rowMessage(9, ROW_RAFA, "Rafa", "@lia traz o controle extra", {
    createdAt: new Date(NOW - 16.5 * 60_000).toISOString(),
  }),
  rowMessage(4, ROW_ME, "Lia", "vou sim, levo o lanche dessa vez"),
  // A mention that starts a group, so the avatar and its dot sit on the fill.
  rowMessage(10, ROW_BIA, "Bia", "@lia guarda um lugar pra mim", {
    createdAt: new Date(NOW - 15.5 * 60_000).toISOString(),
  }),
  rowMessage(5, ROW_BIA, "Bia", "as regras do campeonato tão aqui", {
    pinnedAt: new Date(NOW - 5 * 60_000).toISOString(),
  }),
  rowMessage(6, ROW_HOOK, "Deploys", "build 1.4.2 no ar", { isWebhook: true }),
  rowMessage(7, ROW_ME, "Lia", "mandando agora", { pending: true, nonce: "n1" }),
  rowMessage(8, ROW_ME, "Lia", "e essa não foi", { failed: true, nonce: "n2" }),
];

const ROW_AUTHORS = new Map<string, MessageAuthorInfo>([
  [ROW_ME, { username: "lia", status: "online" }],
  [ROW_RAFA, { username: "rafa", status: "online" }],
  [ROW_BIA, { username: "bia", status: "idle" }],
]);

function MessageRowsBlock() {
  return (
    <div data-testid="qa-shell-message-rows" className="flex flex-col gap-6">
      {/* Rafa: a group of four (one edited, the last two name you). You. Bia
          naming you, then a pinned line. A webhook. Then yours sending, and one that
          failed with Retry and Discard. */}
      <MainPane>
        <div className="flex h-[620px] min-h-0 flex-col">
          <MessageList
            messages={ROW_MESSAGES}
            currentUserId={ROW_ME}
            currentUsername="lia"
            channelId={ROW_CHANNEL}
            onToggleReaction={noop}
            onRetryMessage={noop}
            authors={ROW_AUTHORS}
            authorsComplete
          />
        </div>
      </MainPane>
    </div>
  );
}

/** A message carrying content, for the content sheet (s-message-content). */
function contentMessage(n: number, authorId: string, authorName: string, body: string, extra: Record<string, unknown> = {}): ChatMessage {
  return messageSchema.parse({
    id: `00000000-0000-4000-8000-0000000005${String(n).padStart(2, "0")}`,
    channelId: ROW_CHANNEL,
    authorId,
    authorName,
    authorTag: null,
    authorAvatarUrl: null,
    body,
    createdAt: new Date(NOW - (30 - n) * 60_000).toISOString(),
    ...extra,
  }) as ChatMessage;
}

const SHEET_ORIGIN = typeof window === "undefined" ? "http://localhost" : window.location.origin;
/** 64 peaks, a rise and fall, as a voice note stores them. */
const SHEET_WAVEFORM = btoa(
  String.fromCharCode(
    ...Array.from({ length: 64 }, (_, i) => Math.round(60 + 160 * Math.abs(Math.sin(i / 4)) * (0.5 + 0.5 * Math.sin(i / 11)))),
  ),
);

const CONTENT_MARKDOWN = [
  "**bora** fechar hoje, o mapa novo tá em `maps/v2` e as regras em https://pqp.gg/regras",
  "@bia cê traz o controle? o @rafa já confirmou",
  "- 20h: aquecimento",
  "- 21h: final",
  "```",
  "/roll 2d6+1",
  "```",
  // Last, so nothing after it is pulled into the quote.
  "> quem perder paga o lanche",
].join("\n");

const CONTENT_MESSAGES_A: ChatMessage[] = [
  contentMessage(1, ROW_RAFA, "Rafa", CONTENT_MARKDOWN),
  contentMessage(2, ROW_BIA, "Bia", "@lia trago sim, e o @rafa leva o chaveamento:", {
    attachments: [
      {
        id: "00000000-0000-4000-8000-000000000601",
        filename: "partida.jpg",
        contentType: "image/jpeg",
        byteSize: 182_000,
        width: 1280,
        height: 720,
        url: `${SHEET_ORIGIN}/media/bubbles-poster.jpg`,
      },
      {
        id: "00000000-0000-4000-8000-000000000602",
        filename: "chaveamento-final.pdf",
        contentType: "application/pdf",
        byteSize: 1_240_000,
        width: null,
        height: null,
        url: `${SHEET_ORIGIN}/chaveamento-final.pdf`,
      },
    ],
  }),
  contentMessage(3, ROW_ME, "Lia", "", {
    attachments: [
      {
        id: "00000000-0000-4000-8000-000000000603",
        filename: "nota-de-voz.webm",
        contentType: "audio/webm",
        byteSize: 48_000,
        width: null,
        height: null,
        url: `${SHEET_ORIGIN}/nota-de-voz.webm`,
        voice: { durationMs: 14_000, waveform: SHEET_WAVEFORM, listenedByMe: false },
      },
    ],
  }),
  // Bia's note, not heard yet: the unheard dot and the quiet bars.
  contentMessage(9, ROW_BIA, "Bia", "", {
    createdAt: new Date(NOW - 26.5 * 60_000).toISOString(),
    attachments: [
      {
        id: "00000000-0000-4000-8000-000000000604",
        filename: "nota-da-bia.webm",
        contentType: "audio/webm",
        byteSize: 36_000,
        width: null,
        height: null,
        url: `${SHEET_ORIGIN}/nota-da-bia.webm`,
        voice: { durationMs: 9_000, waveform: SHEET_WAVEFORM, listenedByMe: false },
      },
    ],
  }),
  contentMessage(4, ROW_RAFA, "Rafa", "olha isso que o Caio mandou no outro server", {
    forward: {
      v: 1,
      kind: "message",
      sourceServerId: "00000000-0000-4000-8000-000000000701",
      sourceServerName: "Turma do Fliperama",
      sourceServerIconUrl: null,
      sourceChannelName: "geral",
      sourceId: "00000000-0000-4000-8000-000000000702",
      authorDisplayName: "Caio",
      excerpt: "achei o cartucho original no sebo, R$ 30. alguém quer testar sábado?",
      mediaKind: "image",
      url: `${SHEET_ORIGIN}/app/server/00000000-0000-4000-8000-000000000701/channel/00000000-0000-4000-8000-000000000703/message/00000000-0000-4000-8000-000000000702`,
      createdAt: new Date(NOW - 3 * 3_600_000).toISOString(),
    },
  }),
];

const CONTENT_VOTERS = [
  { userId: ROW_RAFA, displayName: "Rafa", avatarUrl: null },
  { userId: ROW_BIA, displayName: "Bia", avatarUrl: null },
  { userId: ROW_ME, displayName: "Lia", avatarUrl: null },
  { userId: "00000000-0000-4000-8000-0000000008a1", displayName: "Caio", avatarUrl: null },
];

const CONTENT_MESSAGES_B: ChatMessage[] = [
  contentMessage(5, ROW_BIA, "Bia", "Que horas a final?", {
    poll: {
      question: "Que horas a final?",
      allowMultiselect: false,
      closesAt: new Date(NOW + 5 * 3_600_000).toISOString(),
      closedAt: null,
      totalVotes: 4,
      canClose: false,
      options: [
        // You voted 21h; 20h leads. So the ring and the leading fill show apart.
        { id: "00000000-0000-4000-8000-000000000801", label: "20h", votes: 3, voted: false, voters: [CONTENT_VOTERS[0], CONTENT_VOTERS[1], CONTENT_VOTERS[3]] },
        { id: "00000000-0000-4000-8000-000000000802", label: "21h", votes: 1, voted: true, voters: [CONTENT_VOTERS[2]] },
        { id: "00000000-0000-4000-8000-000000000803", label: "Amanhã", votes: 0, voted: false, voters: [] },
      ],
    },
  }),
  contentMessage(6, ROW_RAFA, "Rafa", "2d6+1: 11", {
    chance: { type: "roll", notation: "2d6+1", faces: [4, 6], modifier: 1, total: 11, comment: "quem começa" },
  }),
  contentMessage(7, ROW_RAFA, "Rafa", "as regras completas: https://pqp.gg/regras", {
    embeds: [
      {
        url: "https://pqp.gg/regras",
        kind: "link",
        title: "Regras do campeonato de sábado",
        description: "Formato, horários, o que vale e o que não vale. Leia antes da primeira partida.",
        siteName: "pqp.gg",
        imageUrl: null,
        imageWidth: null,
        imageHeight: null,
      },
    ],
  }),
  contentMessage(8, ROW_HOOK, "Deploys", "", {
    isWebhook: true,
    webhookEmbeds: [
      {
        title: "Build 1.4.2 no ar",
        url: "https://pqp.gg/novidades",
        description: "Notas de voz mais leves e o chaveamento novo.",
        color: 0x5865f2,
        fields: [
          { name: "Ambiente", value: "produção", inline: true },
          { name: "Duração", value: "3 min 12 s", inline: true },
        ],
        footer: { text: "via GitHub Actions" },
      },
    ],
  }),
];

function MessageContentBlock() {
  return (
    <div data-testid="qa-shell-message-content" className="flex flex-wrap items-start gap-6">
      {/* Left: markdown (bold, code, a link, a quote, two mentions, one of
          them you, a list, a code block); a picture and a file; your voice
          note, not heard yet; a forwarded message. Right: a poll you voted
          in; a dice roll; a link preview; a webhook's own embed. */}
      {[CONTENT_MESSAGES_A, CONTENT_MESSAGES_B].map((messages, index) => (
        <MainPane key={index}>
          <div className={cn("flex min-h-0 flex-col", index === 0 ? "h-[1180px]" : "h-[900px]")}>
            <MessageList
              messages={messages}
              currentUserId={ROW_ME}
              currentUsername="lia"
              channelId={ROW_CHANNEL}
              onToggleReaction={noop}
              onRetryMessage={noop}
              authors={ROW_AUTHORS}
              authorsComplete
            />
          </div>
        </MainPane>
      ))}
    </div>
  );
}

const CHROME_THREAD = "00000000-0000-4000-8000-000000000901";
const CHROME_THREAD_OPEN = "00000000-0000-4000-8000-000000000902";
const CHROME_FACES = [
  { id: ROW_RAFA, displayName: "Rafa", avatarUrl: null },
  { id: ROW_BIA, displayName: "Bia", avatarUrl: null },
  { id: ROW_ME, displayName: "Lia", avatarUrl: null },
];

function chromeThread(channelId: string, name: string, replyCount: number, extra: Record<string, unknown> = {}) {
  return {
    channelId,
    parentChannelId: ROW_CHANNEL,
    rootMessageId: null,
    name,
    replyCount,
    lastActivityAt: new Date(NOW - 12 * 60_000).toISOString(),
    archived: false,
    participants: CHROME_FACES,
    ...extra,
  };
}

const CHROME_MESSAGES: ChatMessage[] = [
  contentMessage(11, ROW_RAFA, "Rafa", "fechamos a campanha sábado então?", {
    reactions: [
      { emoji: "👍", count: 3, me: true, users: CHROME_FACES.map(({ id, displayName }) => ({ id, displayName })) },
      { emoji: "🔥", count: 1, me: false, users: [{ id: ROW_BIA, displayName: "Bia" }] },
      { emoji: "😂", count: 2, me: false, users: [] },
    ],
    thread: chromeThread(CHROME_THREAD, "Campanha de sábado", 12),
  }),
  contentMessage(12, ROW_BIA, "Bia", "eu topo, levo o lanche", {
    replyTo: {
      id: "00000000-0000-4000-8000-000000000511",
      authorId: ROW_RAFA,
      authorName: "Rafa",
      excerpt: "fechamos a campanha sábado então?",
      deleted: false,
    },
    reactions: [{ emoji: "❤️", count: 1, me: true, users: [{ id: ROW_ME, displayName: "Lia" }] }],
  }),
  contentMessage(13, ROW_ME, "Lia", "respondendo aquela que sumiu", {
    replyTo: { id: "00000000-0000-4000-8000-000000000599", authorId: null, authorName: null, excerpt: "", deleted: true },
  }),
  contentMessage(14, ROW_RAFA, "Rafa", "as regras ficam na thread", {
    thread: chromeThread(CHROME_THREAD_OPEN, "Regras", 4),
  }),
  contentMessage(15, ROW_BIA, "Bia", "lembra do torneio de julho?", {
    thread: chromeThread("00000000-0000-4000-8000-000000000903", "Torneio de julho", 31, {
      archived: true,
      lastActivityAt: new Date(NOW - 40 * 86_400_000).toISOString(),
    }),
  }),
];

const CHROME_UNREAD_THREADS = new Set([CHROME_THREAD]);

/** A row with ten reactions (they wrap) above a thread chip, then a one-line continuation. */
const CHROME_WRAP_MESSAGES: ChatMessage[] = [
  contentMessage(16, ROW_RAFA, "Rafa", "chaveamento fechado, 16 duplas", {
    reactions: [
      { emoji: "👍", count: 4, me: false, users: [] },
      { emoji: "🔥", count: 2, me: false, users: [] },
      { emoji: "😂", count: 3, me: false, users: [] },
      { emoji: "❤️", count: 1, me: false, users: [] },
      { emoji: "🎮", count: 5, me: true, users: [] },
      { emoji: "👀", count: 2, me: false, users: [] },
      { emoji: "🍕", count: 1, me: false, users: [] },
      { emoji: "🏆", count: 2, me: true, users: [] },
      { emoji: "😭", count: 1, me: false, users: [] },
      { emoji: "🙏", count: 3, me: false, users: [] },
    ],
    thread: chromeThread("00000000-0000-4000-8000-000000000904", "Chaveamento", 7, { participants: CHROME_FACES.slice(0, 2) }),
  }),
  contentMessage(17, ROW_RAFA, "Rafa", "quem chegar depois das 20h fica de fora"),
];

function MessageChromeWrapBlock() {
  return (
    <div data-testid="qa-shell-message-chrome-wrap" className="flex flex-col gap-6">
      {/* The shot hovers the continuation, so its toolbar rises over the row above. */}
      <MainPane>
        <div className="flex h-[320px] min-h-0 flex-col">
          <MessageList
            messages={CHROME_WRAP_MESSAGES}
            currentUserId={ROW_ME}
            currentUsername="lia"
            channelId={ROW_CHANNEL}
            onToggleReaction={noop}
            onRetryMessage={noop}
            onReplyTo={noop}
            onStartThread={noop}
            onOpenThread={noop}
            authors={ROW_AUTHORS}
            authorsComplete
          />
        </div>
      </MainPane>
    </div>
  );
}

function MessageChromeBlock() {
  return (
    <div data-testid="qa-shell-message-chrome" className="flex flex-col gap-6">
      {/* Rafa: three reactions (one yours) and a thread with new replies.
          Bia answers him (a reply line; your heart). You answer a message
          that was deleted. Rafa's thread is the one open in the panel; Bia's
          is archived. The shot hovers Bia's reply and opens "Mais". */}
      <MainPane>
        <div className="flex h-[620px] min-h-0 flex-col">
          <MessageList
            messages={CHROME_MESSAGES}
            currentUserId={ROW_ME}
            currentUsername="lia"
            channelId={ROW_CHANNEL}
            onToggleReaction={noop}
            onRetryMessage={noop}
            onReplyTo={noop}
            onStartThread={noop}
            onOpenThread={noop}
            canModerate
            onPinMessage={asyncNoop}
            onUnpinMessage={asyncNoop}
            onDeleteMessage={asyncNoop}
            onReportMessage={noop}
            onForward={noop}
            onMarkUnread={noop}
            unreadThreadIds={CHROME_UNREAD_THREADS}
            activeThreadId={CHROME_THREAD_OPEN}
            authors={ROW_AUTHORS}
            authorsComplete
          />
        </div>
      </MainPane>
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

const NEW_USER = {
  id: "u-new",
  username: "lia",
  discriminator: "0369",
  tag: "lia#0369",
  displayName: "Lia",
  avatarUrl: null,
} as unknown as Parameters<typeof FirstRunCard>[0]["user"];

const community = (n: number, name: string, tagline: string, category: string, memberCount: number, extra: Record<string, unknown> = {}) =>
  communitySummarySchema.parse({
    id: `00000000-0000-4000-8000-0000000009${String(n).padStart(2, "0")}`,
    name,
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    tagline,
    category,
    memberCount,
    joined: false,
    createdAt: new Date(NOW - 30 * 86_400_000).toISOString(),
    ...extra,
  });

/**
 * Directory cards on the directory's own tone: one you are in ("Abrir"), one
 * with a banner, one plain, and the loading skeleton in the same shape.
 */
function CommunityCardsBlock() {
  return (
    <div data-testid="qa-community-cards" className="max-w-5xl rounded-[var(--radius-card)] bg-surface-1 p-6 redesign:bg-[color:var(--communities-bg)]">
      <ul className="grid grid-cols-3 gap-4">
        <CommunityCard
          community={community(1, "Turma do Fliperama", "Jogo velho, cartucho soprado e campeonato toda sexta.", "games", 1840, { joined: true })}
          joining={false}
          onEnter={noop}
          onReport={noop}
        />
        <CommunityCard
          community={community(2, "Sala de Som", "Tocando disco de vinil e discutindo encarte.", "musica", 312)}
          joining={false}
          bannerUrl="/media/bubbles-poster.jpg"
          onEnter={noop}
          onReport={noop}
        />
        <CommunityCard
          community={community(3, "Bate-bola", "Resenha do jogo de domingo.", "futebol", 47)}
          joining={false}
          onEnter={noop}
          onReport={noop}
        />
        <CommunityCardSkeleton />
      </ul>
    </div>
  );
}
const APP_PEOPLE: CardPerson[] = ["Bia", "Rafa", "Duda"].map((name) => ({
  userId: `id-${name}`,
  displayName: name,
  avatarUrl: null,
}));
const APP = { id: "pqp-eco", name: "Sala de jogos", icon: "gamepad" } as const;
const STRIP_LIVE: LiveStripModel = {
  kind: "live",
  sessionId: "s1",
  app: APP,
  phase: "participant",
  tone: "normal",
  line: { kind: "hostIs", name: "Bia" },
  people: APP_PEOPLE,
  more: 0,
  count: { kind: "of", players: 3, max: 4, watching: 0 },
  roster: [
    { userId: "id-Bia", name: "Bia", avatarUrl: null, host: true, spectator: false, reconnecting: false },
    { userId: "id-Rafa", name: "Rafa", avatarUrl: null, host: false, spectator: false, reconnecting: false },
  ],
  seated: true,
  isHost: false,
  spectating: false,
  showPane: true,
  actions: { leave: true, end: false, enter: null, takeHost: false, share: false },
};
const STRIP_HOST: LiveStripModel = {
  ...STRIP_LIVE,
  phase: "host",
  line: { kind: "host" },
  isHost: true,
  actions: { leave: true, end: true, enter: null, takeHost: false, share: true },
};
const STRIP_ENDED: EndedStripModel = {
  kind: "ended",
  sessionId: "s1",
  app: APP,
  disabled: false,
  cause: { kind: "host", name: "Bia", self: false },
  summary: { participants: 4, durationSeconds: 23 * 60 },
};
const CARD_LIVE: LiveCardModel = {
  kind: "live",
  sessionId: "s1",
  app: { ...APP, category: "game" },
  phase: "open",
  subtitle: { kind: "started", name: "Bia", minutes: 4 },
  count: { kind: "of", players: 3, max: 4 },
  people: APP_PEOPLE,
  more: 0,
  full: false,
  canWatch: false,
  join: { status: "idle" },
};
const CARD_ENDED: EndedCardModel = {
  kind: "ended",
  app: { ...APP, category: "game" },
  gone: false,
  disabled: false,
  summary: { participants: 4, durationSeconds: 1380 },
  resultText: null,
  starterName: "Bia",
  startedAt: "2026-10-19T19:40:00.000Z",
  people: APP_PEOPLE.slice(0, 2),
  more: 0,
};

export function ShellSheet() {
  useUpdateWaitingFixture();
  return (
    <div className="flex flex-col gap-6">
      {/* App states: the shell while the app boots, and the page when it
          cannot reach the API. Each in a fixed desktop-sized frame. */}
      <div data-testid="qa-shell-states" className="flex flex-col gap-6">
        <div className="h-[560px] w-[1100px] overflow-hidden rounded-[var(--radius-card)] border border-border">
          <AppLoadingShell />
        </div>
        <div className="h-[420px] w-[1100px] overflow-hidden rounded-[var(--radius-card)] border border-border bg-[color:var(--color-pane-main)]">
          <AppBootstrapError message="Não deu pra falar com o servidor (502)." onRetry={noop} />
        </div>
      </div>
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
        {/* The Baú open while a new post still shows as the card. */}
        <SidePane>
          <CommunityHomePreview
            latest={BAU_NEW}
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
          <ChannelSection label="Texto" fold={fold(false, 3)} canManage onAdd={noop} onAddPrivate={noop} isDragOver>
            {null}
          </ChannelSection>
          <ChannelSection label="Voz" fold={fold(true, 2)} canManage onAdd={noop} onAddPrivate={noop} isDragOver>
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
          <CategoryHeader
            category={category("c3", "Campeonatos de fim de semana")}
            controlsId="qa-category-3"
            canManage
            onRename={noop}
            onDelete={noop}
            isDragOver
            onDragStart={noop}
            onDragEnd={noop}
            onDragOverRow={noop}
            onDrop={noop}
            {...fold(false, 2)}
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
          <MixedCategoryHeader
            category={category("m4", "Campeonatos de fim de semana")}
            addItems={ADD_ITEMS}
            menuItems={[]}
            drag={drag("into")}
            {...fold(false, 3)}
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

      {/* The channel list folded to icons. */}
      <SidebarStripBlock />

      {/* The voice strip above the user panel. */}
      <VoiceStripBlock />

      {/* The user panel at the foot of the sidebar. */}
      <UserPanelBlock />

      {/* The strips above the conversation. */}
      <BannersBlock />

      {/* Message rows. */}
      <MessageRowsBlock />
      <MessageContentBlock />
      <MessageChromeBlock />
      <MessageChromeWrapBlock />

      <CommunityCardsBlock />

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
      {/* Onboarding: the one corner card shell, inline as it sits beside the
          control it explains, plain and with a hero; and the first-run card
          for a new account with nothing done yet. */}
      <div data-testid="qa-onboarding" className="flex max-w-4xl items-start gap-6 p-4">
        <div className="flex w-[17rem] flex-col gap-4">
          <CornerCard
            open
            layout="inline"
            onClose={noop}
            label="Dica"
            dismissLabel="Fechar"
            title="Atalhos do teclado"
            body="Aperta Ctrl K pra buscar qualquer mensagem, e Ctrl / pra ver todos os atalhos."
            footer={<Button size="sm" data-cta className="cta-lift rounded-full px-4" onClick={noop}>Entendi</Button>}
          />
          <CornerCard
            open
            layout="inline"
            onClose={noop}
            label="Novidade"
            dismissLabel="Fechar"
            hero={<div className="h-24 bg-[linear-gradient(135deg,var(--color-accent-soft),var(--color-surface-2))]" />}
            title="Watch party chegou"
            body="Assiste filme junto, com a voz da galera por cima."
            footer={<Button size="sm" variant="secondary" onClick={noop}>Ver como</Button>}
          />
        </div>
        <div className="min-w-0 flex-1">
          <FirstRunCard
            user={NEW_USER}
            serverCount={0}
            friendCount={0}
            onCreateServer={noop}
            onJoinServer={noop}
            onAddFriend={noop}
            onPickAvatar={noop}
            onDismiss={noop}
          />
          {/* Two steps done: ticked, dimmed and kept in place. */}
          <div className="mt-4">
            <FirstRunCard
              user={{ ...NEW_USER, avatarUrl: "https://api.dicebear.com/9.x/shapes/png?seed=lia" }}
              serverCount={1}
              friendCount={0}
              onCreateServer={noop}
              onJoinServer={noop}
              onAddFriend={noop}
              onPickAvatar={noop}
              onDismiss={noop}
            />
          </div>
        </div>
      </div>
      {/* The music queue in a call's composer: three waiting, one played. */}
      <MusicQueueSpecimen />
      {/* Apps: the strip over an app as a participant, as the host with the
          share switch, and after it ended; the card a session leaves in the
          chat, live and ended. */}
      <div data-testid="qa-apps" className="flex max-w-3xl flex-col gap-4 p-4">
        <AppSessionStrip model={STRIP_LIVE} onLeave={noop} />
        <AppSessionStrip
          model={STRIP_HOST}
          share={{ visible: true, on: true, pending: false, needsCall: false, viewers: 2, wholeTab: false }}
          onShareChange={noop}
          onEnd={noop}
          onLeave={noop}
        />
        <AppSessionStrip model={STRIP_ENDED} onClose={noop} />
        <div className="grid grid-cols-2 gap-4">
          <AppSessionCard model={CARD_LIVE} onJoin={noop} />
          <AppSessionCard model={CARD_ENDED} />
          {/* Joining (the button waits) and a full room you may watch. */}
          <AppSessionCard model={{ ...CARD_LIVE, sessionId: "s3", join: { status: "joining" } }} onJoin={noop} />
          <AppSessionCard
            model={{
              ...CARD_LIVE,
              sessionId: "s4",
              phase: "full",
              full: true,
              canWatch: true,
              count: { kind: "full", players: 4, max: 4, watching: 1 },
            }}
            onJoin={noop}
          />
        </div>
      </div>
    </div>
  );
}
