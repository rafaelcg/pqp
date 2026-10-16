// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Channel, Server, VoiceParticipant } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const voiceConfig = vi.hoisted(() => ({
  answer: { soundboard: true } as { soundboard?: boolean },
  asked: [] as Array<string | null | undefined>,
}));

vi.mock("@/hooks/use-voice-config", () => ({
  useVoiceConfig: (serverId: string | null | undefined) => {
    voiceConfig.asked.push(serverId);
    return voiceConfig.answer;
  },
}));

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= FakeResizeObserver;

const { ChannelList } = await import("./channel-list");

/**
 * The sidebar row's person menu follows the same rule as the call surfaces:
 * the soundboard switch is there only for another person in a server call
 * whose board is on (`GET /api/voice/config?serverId=`).
 */

const server = {
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
  communityTagline: null,
  communityAbout: null,
  communityLinks: [],
  communitySlug: null,
} as Server;

const lobby = {
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
} as Channel;

const andre = {
  peerId: "peer-andre",
  userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  displayName: "Andre",
  avatarUrl: null,
  sharingScreen: false,
  muted: false,
  deafened: false,
  serverMuted: false,
} as VoiceParticipant;

const rafa = {
  ...andre,
  peerId: "peer-rafa",
  userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  displayName: "Rafa",
} as VoiceParticipant;

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(soundboard: boolean) {
  voiceConfig.answer = { soundboard };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <MemoryRouter>
        <TooltipProvider>
          <ChannelList
            server={server}
            channels={[lobby]}
            selectedChannelId={lobby.id}
            canManage={false}
            voiceOccupancy={{ [lobby.id]: [andre, rafa] }}
            speakingPeerIds={[]}
            activeVoiceChannelId={lobby.id}
            unread={{}}
            currentUserId={andre.userId}
            peerVolumes={{ [rafa.userId]: 1 }}
            onSetPeerVolume={() => {}}
            onSelectChannel={() => {}}
            onCreateChannel={() => {}}
            onRenameChannel={() => {}}
            onDeleteChannel={() => {}}
            onOpenChannelSettings={() => {}}
            onMoveChannel={() => {}}
            onInvite={() => {}}
            onOpenMembers={() => {}}
            onOpenServerSettings={() => {}}
          />
        </TooltipProvider>
      </MemoryRouter>,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  voiceConfig.asked.length = 0;
});

const rafaRow = () =>
  host!.querySelector<HTMLElement>(`[data-voice-occupant="${rafa.userId}"]`)!;
const menu = () =>
  document.querySelector<HTMLElement>('[data-testid="peer-audio-menu"]');

describe("the sidebar row's soundboard switch", () => {
  it("is missing from another person's menu while the server's board is off", () => {
    mount(false);
    expect(voiceConfig.asked).toContain(server.id);
    act(() => rafaRow().click());
    expect(menu()).not.toBeNull();
    expect(menu()!.querySelector('[data-testid="peer-audio-voice"]')).not.toBeNull();
    expect(menu()!.querySelector('[data-testid="peer-audio-soundboard"]')).toBeNull();
  });

  it("is in another person's menu while the board is on", () => {
    mount(true);
    act(() => rafaRow().click());
    expect(menu()!.querySelector('[data-testid="peer-audio-soundboard"]')).not.toBeNull();
  });

  it("never opens a menu on our own row, whatever the board says", () => {
    mount(true);
    const own = host!.querySelector<HTMLElement>(
      `[data-voice-occupant="${andre.userId}"]`,
    )!;
    act(() => own.click());
    expect(menu()).toBeNull();
  });
});
