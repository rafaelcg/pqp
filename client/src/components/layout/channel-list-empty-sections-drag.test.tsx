// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { Channel, Server } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChannelList } from "./channel-list";

// The empty "Text" and "Voice" headers a member does not see come back only
// while a pinned channel is dragged: they are the drop that unpins it. A drag
// of any other row must not mount them, because they sit above the categories
// and would push the row in the member's hand down mid-drag.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver;
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const SERVER_ID = "11111111-1111-4111-8111-111111111111";

const server: Server = {
  id: SERVER_ID,
  name: "Mesa",
  ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  createdAt: "2026-07-01T00:00:00.000Z",
  messageRetentionDays: null,
  ssoEmailDomain: null,
  iconUrl: null,
  bannerUrl: null,
  role: "member",
  isCommunity: false,
  communityHomeEnabled: false,
  showOnProfile: true,
  communityTagline: null,
  communityAbout: null,
  communityLinks: [],
  communitySlug: null,
};

function channel(
  id: string,
  name: string,
  type: Channel["type"],
  parentId: string | null,
  position: number,
): Channel {
  return {
    id,
    serverId: SERVER_ID,
    kind: "server",
    name,
    type,
    position,
    parentId,
    isPrivate: false,
    topic: null,
    imageUrl: null,
    slowmodeSeconds: 0,
    voiceTransport: null,
  };
}

const CATEGORY = "c0000000-0000-4000-8000-000000000001";
const GENERAL = "a0000000-0000-4000-8000-000000000001";
const CLIPS = "a0000000-0000-4000-8000-000000000002";

const channels: Channel[] = [
  channel(CATEGORY, "general-ooc", "category", null, 0),
  channel(GENERAL, "general", "text", CATEGORY, 0),
  channel(CLIPS, "clips", "text", CATEGORY, 1),
];

type Props = ComponentProps<typeof ChannelList>;

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(): HTMLElement {
  const props: Props = {
    server,
    channels,
    selectedChannelId: null,
    canManage: false,
    voiceOccupancy: {},
    speakingPeerIds: [],
    activeVoiceChannelId: null,
    unread: {},
    onSelectChannel: () => {},
    onCreateChannel: () => {},
    onRenameChannel: () => {},
    onDeleteChannel: () => {},
    onOpenChannelSettings: () => {},
    onMoveChannel: () => {},
    onInvite: () => {},
    onOpenMembers: () => {},
    onOpenServerSettings: () => {},
    favoriteChannelIds: [CLIPS],
    onFavoriteChannelIdsChange: () => {},
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <MemoryRouter>
        <TooltipProvider>
          <ChannelList {...props} />
        </TooltipProvider>
      </MemoryRouter>,
    );
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function row(container: HTMLElement, id: string): HTMLElement {
  const wrapper = container.querySelector<HTMLElement>(`[data-channel-id="${id}"]`);
  expect(wrapper, `row ${id}`).toBeTruthy();
  return wrapper!.querySelector<HTMLElement>("[draggable]")!;
}

/** dragstart, then the tick the list waits before it reacts. */
async function startDrag(target: Element): Promise<void> {
  const event = new Event("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      dropEffect: "none",
      effectAllowed: "all",
      types: [],
      setData: () => {},
      setDragImage: () => {},
      getData: () => "",
    },
  });
  act(() => {
    target.dispatchEvent(event);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The section header spans: `>Text<` and `>Voice<`, exactly. */
function headers(container: HTMLElement): string[] {
  return ["Text", "Voice"].filter((label) =>
    container.innerHTML.includes(`>${label}</span>`),
  );
}

describe("empty top-level sections during a member's drag", () => {
  it("stay hidden while an ordinary channel is dragged", async () => {
    const container = mount();
    expect(headers(container)).toEqual([]);
    await startDrag(row(container, GENERAL));
    expect(headers(container)).toEqual([]);
  });

  it("come back while a pinned channel is dragged, to unpin it", async () => {
    const container = mount();
    expect(headers(container)).toEqual([]);
    await startDrag(row(container, CLIPS));
    expect(headers(container)).toEqual(["Text", "Voice"]);
  });
});
