import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Channel, Server } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChannelList } from "./channel-list";

/**
 * The server header, rebuilt per `docs/plans/SERVER_HEADER_REDO.md` after
 * #542 (name over the banner, `PQ` at a narrow column, a role chip and a
 * community chip crowding the row) was merged and reverted.
 *
 * Everything checkable from static markup lives here: the banner strip's
 * shape, the name said exactly once, no role word, no community chip, the
 * two visible action buttons, and the loading / no-server states. What
 * needs a live click, a resize or a hover — the menu's own contents, real
 * truncation at a pixel width, focus order — is Radix behaviour or belongs
 * in `e2e/server-header.spec.ts`, which runs in a real browser.
 *
 * Two tests below are recovered from `bf3d75f6` (the pre-#542 header's own
 * regression suite), adapted to the new markup: the mobile close button
 * must survive the loading and no-server states, and the banner must not be
 * able to clip the row underneath it — impossible by construction now that
 * the strip and the identity row are siblings, but pinned here as a DOM
 * assertion so a future change cannot reintroduce the old single-box shape.
 */

const server: Server = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "QG do pqp",
  ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  createdAt: "2026-07-01T00:00:00.000Z",
  messageRetentionDays: null,
  ssoEmailDomain: null,
  iconUrl: null,
  bannerUrl: null,
  role: "owner",
  isCommunity: false,
  communityHomeEnabled: false,
  showOnProfile: true,
};

const channels: Channel[] = [
  {
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
  },
];

const baseProps = {
  server,
  channels,
  selectedChannelId: channels[0]!.id,
  canManage: true,
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
  channelSidebarToggle: { iconsOnly: false, onToggle: () => {} },
};

function render(node: ReactElement) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>{node}</TooltipProvider>
    </MemoryRouter>,
  );
}

/** How many times a string shows up in the rendered markup. */
function occurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/** The `[data-server-header]` block on its own, for scoped assertions. */
function headerBlock(html: string): string {
  const start = html.indexOf('data-server-header=""');
  const actionsEnd = html.indexOf('data-server-header-actions=""');
  const afterActions = html.indexOf("</div>", actionsEnd);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(afterActions).toBeGreaterThan(start);
  // Walk to the row's own closing tag: the actions wrapper's close, then the
  // row's own close, one `</div>` further.
  const rowEnd = html.indexOf("</div>", afterActions + "</div>".length);
  return html.slice(start, rowEnd);
}

describe("the server header", () => {
  it("says the server's name exactly once, without a banner", () => {
    const html = render(<ChannelList {...baseProps} />);
    expect(occurrences(html, "QG do pqp")).toBe(1);
    expect(html).not.toContain("data-server-banner-strip");
  });

  it("says the server's name exactly once, with a banner", () => {
    const html = render(
      <ChannelList
        {...baseProps}
        server={{ ...server, bannerUrl: "https://cdn.example.com/banner.png" }}
      />,
    );
    expect(occurrences(html, "QG do pqp")).toBe(1);
  });

  it("draws the banner strip with exactly one child, an <img>, when there is a banner", () => {
    const html = render(
      <ChannelList
        {...baseProps}
        server={{ ...server, bannerUrl: "https://cdn.example.com/banner.png" }}
      />,
    );
    const match = /<div data-server-banner-strip="" class="([^"]*)">(.*?)<\/div>/.exec(
      html,
    );
    expect(match).not.toBeNull();
    expect(match![1]).toContain("h-18");
    expect(match![1]).toContain("overflow-hidden");
    // Exactly one child: the <img>. No <p>, no gradient <span>.
    const inner = match![2]!;
    expect((inner.match(/<img /g) ?? []).length).toBe(1);
    expect(inner).not.toContain("<p");
    expect(inner).not.toContain("<span");
  });

  it("the banner strip's <img> is aria-hidden and object-cover", () => {
    const html = render(
      <ChannelList
        {...baseProps}
        server={{ ...server, bannerUrl: "https://cdn.example.com/banner.png" }}
      />,
    );
    const strip = /<div data-server-banner-strip="" class="[^"]*">(.*?)<\/div>/.exec(
      html,
    );
    expect(strip).not.toBeNull();
    expect(strip![1]).toContain('aria-hidden="true"');
    expect(strip![1]).toContain("object-cover");
    expect(strip![1]).toContain('alt=""');
  });

  it("renders no banner strip at all without a banner — not present-and-empty", () => {
    const html = render(<ChannelList {...baseProps} />);
    expect(html).not.toContain("data-server-banner-strip");
  });

  // The #542 regression, stated as a DOM assertion: the name must never be
  // inside the banner strip, whether or not there is a banner.
  it("[data-server-name] is never a descendant of [data-server-banner-strip]", () => {
    for (const bannerUrl of [null, "https://cdn.example.com/banner.png"]) {
      const html = render(
        <ChannelList {...baseProps} server={{ ...server, bannerUrl }} />,
      );
      const stripMatch = /<div data-server-banner-strip="">(.*?)<\/div>/.exec(
        html,
      );
      if (stripMatch) {
        expect(stripMatch[1]).not.toContain("data-server-name");
      }
      // And the name itself is present, outside the strip.
      expect(html).toContain("data-server-name");
    }
  });

  it("the identity row is a sibling of the banner strip, never nested inside it", () => {
    // Recovered from bf3d75f6's "never clips the header row inside a
    // fixed-height banner box" — the failure mode there was a single wrapper
    // with `overflow-hidden` around both the image and the name-bearing row.
    // That shape is now impossible: `[data-server-header]` carries no
    // `overflow-hidden` of its own, and the banner strip's `overflow-hidden`
    // wraps only the <img>.
    const html = render(
      <ChannelList
        {...baseProps}
        server={{ ...server, bannerUrl: "https://cdn.example.com/banner.png" }}
      />,
    );
    const rowOpenTag = /<div data-server-header="" class="([^"]*)"/.exec(html);
    expect(rowOpenTag).not.toBeNull();
    expect(rowOpenTag![1]).not.toContain("overflow-hidden");
  });

  it("the name is truncate/min-w-0/flex-1, never line-clamp-2", () => {
    const html = render(<ChannelList {...baseProps} />);
    const match = /<p id="[^"]*" data-server-name="" class="([^"]*)">/.exec(
      html,
    );
    expect(match).not.toBeNull();
    expect(match![1]).toContain("truncate");
    expect(match![1]).toContain("min-w-0");
    expect(match![1]).toContain("flex-1");
    expect(match![1]).not.toContain("line-clamp");
    expect(match![1]).not.toContain("title=");
  });

  it("carries no uppercase role word for any role", () => {
    for (const role of ["owner", "admin", "member"] as const) {
      const html = render(
        <ChannelList {...baseProps} server={{ ...server, role }} />,
      );
      const row = headerBlock(html);
      for (const word of ["DONO", "OWNER", "ADMIN", "MEMBER", "Dono", "Adm"]) {
        expect(row).not.toContain(word);
      }
    }
  });

  it("no community chip in the header for a community server", () => {
    const html = render(
      <ChannelList {...baseProps} server={{ ...server, isCommunity: true }} />,
    );
    const row = headerBlock(html);
    expect(row).not.toContain("COMUNIDADE");
    expect(row).not.toContain(">Comunidade<");
    expect(row).not.toContain(">Community<");
  });

  it("the trigger's accessible name is 'Server menu', not the server's own name", () => {
    const html = render(<ChannelList {...baseProps} />);
    expect(html).toContain('data-server-menu-trigger=""');
    expect(html).toContain('aria-label="Server menu"');
  });

  it("the trigger has aria-describedby pointing at the name, so it is still reachable to a screen reader", () => {
    const html = render(<ChannelList {...baseProps} />);
    const trigger = /<button[^>]*data-server-menu-trigger=""[^>]*>/.exec(html);
    expect(trigger).not.toBeNull();
    const describedBy = /aria-describedby="([^"]+)"/.exec(trigger![0]);
    expect(describedBy).not.toBeNull();
    // The id it points at is the name paragraph's own id.
    expect(html).toContain(`<p id="${describedBy![1]}" data-server-name=""`);
  });

  it("[data-server-header-actions] contains exactly two buttons", () => {
    const html = render(<ChannelList {...baseProps} />);
    const actions = /<div data-server-header-actions="" class="[^"]*">(.*?)<\/div><\/div>/.exec(
      html,
    );
    expect(actions).not.toBeNull();
    expect((actions![1].match(/<button/g) ?? []).length).toBe(2);
  });

  it("every button in the header has a non-empty accessible name", () => {
    const html = render(<ChannelList {...baseProps} onMobileClose={() => {}} />);
    const row = headerBlock(html);
    for (const match of row.matchAll(/<button[^>]*>/g)) {
      const tag = match[0];
      const hasAriaLabel = /aria-label="[^"]+"/.test(tag);
      // The trigger has its own aria-label; the members/collapse/close
      // buttons are wrapped in a `Tooltip`, which puts `aria-label` on the
      // rendered button too (see `tooltip.tsx`).
      expect(hasAriaLabel).toBe(true);
    }
  });

  it("no element in the header has a title attribute", () => {
    const html = render(
      <ChannelList
        {...baseProps}
        server={{ ...server, bannerUrl: "https://cdn.example.com/banner.png" }}
        onMobileClose={() => {}}
      />,
    );
    const row = headerBlock(html);
    expect(row).not.toContain("title=");
  });

  it("the collapse button carries aria-pressed and data-channel-sidebar-toggle", () => {
    const html = render(
      <ChannelList
        {...baseProps}
        channelSidebarToggle={{ iconsOnly: true, onToggle: () => {} }}
      />,
    );
    const row = headerBlock(html);
    expect(row).toContain('data-channel-sidebar-toggle=""');
    expect(row).toContain('aria-pressed="true"');
  });

  it("the identity row is min-h-12 (48px), not min-h-16", () => {
    const html = render(<ChannelList {...baseProps} />);
    const rowOpenTag = /<div data-server-header="" class="([^"]*)"/.exec(html);
    expect(rowOpenTag).not.toBeNull();
    expect(rowOpenTag![1]).toContain("min-h-12");
    expect(rowOpenTag![1]).not.toContain("min-h-16");
  });

  // Recovered from bf3d75f6: the mobile close button has to survive both the
  // loading and the no-server states. This is exactly the bug Farol caught
  // on #542 — the whole action group had been moved inside the `server &&`
  // branch, so a drawer opened while the server was still loading had no way
  // to close.
  it("keeps the mobile close button while loading or with no server selected", () => {
    for (const props of [
      { ...baseProps, server: null, isLoading: true },
      { ...baseProps, server: null, isLoading: false },
    ]) {
      const html = render(<ChannelList {...props} onMobileClose={() => {}} />);
      expect(html).toContain('aria-label="Close channel list"');
      // Neither members nor collapse: there is no server to act on.
      expect(html).not.toContain('aria-label="Members"');
      expect(html).not.toContain("data-channel-sidebar-toggle");
      // No trigger either — a bare label, not a menu with nothing in it.
      expect(html).not.toContain("data-server-menu-trigger");
    }
  });

  it("shows the loading label with no server", () => {
    const html = render(
      <ChannelList {...baseProps} server={null} isLoading />,
    );
    expect(html).toContain("Loading");
  });

  it("shows 'No server' once loading has finished with nothing selected", () => {
    const html = render(
      <ChannelList {...baseProps} server={null} isLoading={false} />,
    );
    expect(html).toContain("No server");
  });
});
