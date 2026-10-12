import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, Server } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { sectionCollapseKey } from "@/lib/collapsed-categories";
import { ChannelList } from "./channel-list";

/**
 * PQP-8: the classic list's Texto, Voz and category headers fold, say what
 * they hide, and never hide where you are.
 */

const server: Server = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "QG",
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

const GERAL = "22222222-2222-4222-8222-222222222222";
const MEMES = "33333333-3333-4333-8333-333333333333";
const LOBBY = "44444444-4444-4444-8444-444444444444";
const JOGOS = "55555555-5555-4555-8555-555555555555";
const VALORANT = "66666666-6666-4666-8666-666666666666";
const CS2 = "77777777-7777-4777-8777-777777777777";

function channel(
  id: string,
  name: string,
  type: Channel["type"],
  extra: Partial<Channel> = {},
): Channel {
  return {
    id,
    serverId: server.id,
    kind: "server",
    name,
    type,
    position: extra.position ?? 0,
    parentId: extra.parentId ?? null,
    isPrivate: false,
    topic: null,
    imageUrl: null,
    slowmodeSeconds: 0,
    voiceTransport: null,
    ...extra,
  };
}

const channels: Channel[] = [
  channel(GERAL, "geral", "text", { position: 0 }),
  channel(MEMES, "memes", "text", { position: 1 }),
  channel(LOBBY, "lobby", "voice"),
  channel(JOGOS, "Jogos", "category"),
  channel(VALORANT, "valorant", "text", { parentId: JOGOS, position: 0 }),
  channel(CS2, "cs2", "text", { parentId: JOGOS, position: 1 }),
];

const baseProps = {
  server,
  channels,
  selectedChannelId: GERAL,
  canManage: false,
  voiceOccupancy: {},
  activeVoiceChannelId: null as string | null,
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
};

function renderList(node: ReactElement) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>{node}</TooltipProvider>
    </MemoryRouter>,
  );
}

function fakeLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
}

function collapse(...keys: string[]) {
  vi.stubGlobal(
    "localStorage",
    fakeLocalStorage({ "pqp:collapsed-categories": JSON.stringify(keys) }),
  );
}

/** The header button whose visible label is `label`, as markup. */
function headerButton(html: string, label: string): string {
  const at = html.indexOf(`>${label}</span>`);
  expect(at).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<button", at);
  return html.slice(start, html.indexOf("</button>", at));
}

describe("ChannelList section headers", () => {
  beforeEach(() => {
    collapse();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("makes Texto, Voz and each category a disclosure button that names what it folds", () => {
    const html = renderList(<ChannelList {...baseProps} />);
    for (const label of ["Text", "Voice", "Jogos"]) {
      const button = headerButton(html, label);
      expect(button).toContain('aria-expanded="true"');
      const controls = /aria-controls="([^"]+)"/.exec(button)?.[1];
      expect(controls).toBeTruthy();
      expect(html).toContain(`id="${controls}"`);
    }
  });

  it("folds Texto per server, keeps the open channel, and says how many it holds", () => {
    collapse(sectionCollapseKey(server.id, "text"));
    const html = renderList(<ChannelList {...baseProps} />);
    const button = headerButton(html, "Text");
    expect(button).toContain('aria-expanded="false"');
    expect(button).toContain("2 channels");
    expect(html).toContain(">geral<");
    expect(html).not.toContain(">memes<");
    expect(html).toContain(">lobby<");
  });

  it("marks a folded section that hides an unread channel", () => {
    collapse(sectionCollapseKey(server.id, "text"));
    const html = renderList(
      <ChannelList {...baseProps} unread={{ [MEMES]: { count: 3, mentions: 0 } }} />,
    );
    expect(headerButton(html, "Text")).toContain("(unread)");
  });

  it("does not fold Texto on another server", () => {
    collapse(sectionCollapseKey("99999999-9999-4999-8999-999999999999", "text"));
    const html = renderList(<ChannelList {...baseProps} />);
    expect(headerButton(html, "Text")).toContain('aria-expanded="true"');
    expect(html).toContain(">memes<");
  });

  it("keeps the open channel visible under a folded category", () => {
    collapse(JOGOS);
    const html = renderList(<ChannelList {...baseProps} selectedChannelId={CS2} />);
    expect(headerButton(html, "Jogos")).toContain('aria-expanded="false"');
    expect(html).toContain(">cs2<");
    expect(html).not.toContain(">valorant<");
  });

  it("keeps the call you are in visible under a folded Voz", () => {
    collapse(sectionCollapseKey(server.id, "voice"));
    const html = renderList(
      <ChannelList {...baseProps} activeVoiceChannelId={LOBBY} />,
    );
    expect(headerButton(html, "Voice")).toContain('aria-expanded="false"');
    expect(html).toContain(">lobby<");
  });

  it("leaves every section open by default", () => {
    const html = renderList(<ChannelList {...baseProps} />);
    for (const label of ["Text", "Voice", "Jogos"]) {
      expect(headerButton(html, label)).toContain('aria-expanded="true"');
    }
    expect(html).not.toContain("data-section-summary");
  });
});
