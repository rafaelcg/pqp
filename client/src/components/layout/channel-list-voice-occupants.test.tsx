import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Channel, Server, VoiceParticipant } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChannelList } from "./channel-list";

const server: Server = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Mesa da Tues",
  ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  createdAt: "2026-07-01T00:00:00.000Z",
  messageRetentionDays: null,
  ssoEmailDomain: null,
  iconUrl: null,
  bannerUrl: null,
  role: "owner",
  isCommunity: false,
  communityHomeEnabled: true,
  showOnProfile: true,
};

const textChannel: Channel = {
  id: "22222222-2222-4222-8222-222222222222",
  serverId: server.id,
  kind: "server",
  name: "geral",
  type: "text",
  position: 0,
  parentId: null,
  isPrivate: false,
  topic: null,
  imageUrl: null,
  slowmodeSeconds: 0,
  voiceTransport: null,
};

const lobby: Channel = {
  id: "33333333-3333-4333-8333-333333333333",
  serverId: server.id,
  kind: "server",
  name: "Lobby",
  type: "voice",
  position: 0,
  parentId: null,
  isPrivate: false,
  topic: null,
  imageUrl: null,
  slowmodeSeconds: 0,
  voiceTransport: null,
};

const studio: Channel = {
  id: "44444444-4444-4444-8444-444444444444",
  serverId: server.id,
  kind: "server",
  name: "Studio",
  type: "voice",
  position: 1,
  parentId: null,
  isPrivate: false,
  topic: null,
  imageUrl: null,
  slowmodeSeconds: 0,
  voiceTransport: null,
};

const andre: VoiceParticipant = {
  peerId: "peer-andre",
  userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  displayName: "Andre",
  avatarUrl: null,
  sharingScreen: false,
  muted: false,
  deafened: false,
  serverMuted: false,
};

const rafa: VoiceParticipant = {
  peerId: "peer-rafa",
  userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  displayName: "Rafa",
  avatarUrl: null,
  sharingScreen: false,
  muted: false,
  deafened: false,
  serverMuted: false,
};

const baseProps = {
  server,
  channels: [textChannel, lobby, studio],
  selectedChannelId: lobby.id,
  canManage: false,
  voiceOccupancy: { [lobby.id]: [andre, rafa] },
  speakingPeerIds: [andre.peerId],
  activeVoiceChannelId: lobby.id as string | null,
  unread: {},
  onSelectChannel: () => {},
  onCreateChannel: () => {},
  onRenameChannel: () => {},
  onDeleteChannel: () => {},
  onTogglePrivate: () => {},
  onManageChannelMembers: () => {},
  onManageWebhooks: () => {},
  onMoveChannel: () => {},
  onInvite: () => {},
  onOpenMembers: () => {},
  onOpenServerSettings: () => {},
};

function renderList(node: ReactElement) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>{node}</TooltipProvider>
    </MemoryRouter>,
  );
}

describe("ChannelList voice occupants", () => {
  it("nests seated people under the voice channel and keeps the speaking ring", () => {
    const html = renderList(
      <ChannelList {...baseProps} currentUserId={andre.userId} />,
    );
    expect(html).toContain("data-voice-occupant=\"" + andre.userId);
    expect(html).toContain(">Andre<");
    expect(html).toContain(">Rafa<");
    expect(html).toContain("ring-accent");
    expect(html).toContain('data-channel-type="voice"');
    expect(html).toContain('data-channel-type="text"');
  });

  it("lets you drag yourself without Move Members", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        currentUserId={andre.userId}
        canMoveIn={() => false}
      />,
    );
    expect(html).toContain(
      `data-voice-occupant="${andre.userId}"`,
    );
    expect(html).toMatch(
      new RegExp(
        `data-voice-occupant="${andre.userId}"[^>]*data-voice-occupant-draggable="true"`,
      ),
    );
    expect(html).toMatch(
      new RegExp(
        `data-voice-occupant="${rafa.userId}"[^>]*data-voice-occupant-draggable="false"`,
      ),
    );
  });

  it("does not let you drag a seat that is already moving", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        currentUserId={andre.userId}
        canMoveIn={() => true}
        pendingMoveUserIds={[rafa.userId]}
      />,
    );
    expect(html).toMatch(
      new RegExp(
        `data-voice-occupant="${rafa.userId}"[^>]*data-voice-occupant-draggable="false"`,
      ),
    );
  });

  it("lets staff drag someone else when Move Members is on that channel", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        currentUserId={andre.userId}
        canMoveIn={(id) => id === lobby.id}
      />,
    );
    expect(html).toMatch(
      new RegExp(
        `data-voice-occupant="${rafa.userId}"[^>]*data-voice-occupant-draggable="true"`,
      ),
    );
  });
});
