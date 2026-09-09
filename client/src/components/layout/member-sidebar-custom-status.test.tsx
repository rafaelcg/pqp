import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProfilePopoverProvider } from "@/components/user/user-profile-popover";
import type { ServerMember } from "@/lib/api";
import { MemberSidebar } from "./member-sidebar";

/**
 * O recado, where it was built to be read: the second line of a member row.
 *
 * Pinned here rather than left to a screenshot because three of its properties
 * are invisible in a passing render and expensive when they break:
 *
 *   * IT IS DRAWN AT ALL. The line is conditional on a field that travels
 *     through five hops (column, roster query, HTTP payload, socket frame,
 *     roster merge), and any one of them dropping it produces a member list
 *     that looks exactly like a member list where nobody has written one.
 *   * IT NEVER WRAPS. A member list whose rows are different heights stops
 *     being scannable, and this is the one field on the row whose length is
 *     chosen by somebody else.
 *   * IT CARRIES THE WHOLE TEXT IN A `title`. Eighty characters is roughly
 *     twice what fits at this width, so the tooltip is not a nicety, it is the
 *     only way the rest of the sentence is readable.
 *
 * Static markup rather than a DOM harness, the arrangement the channel-list
 * suites already use: everything asserted here is a property of the first
 * paint, and none of it needs an event.
 */

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const ANA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BRUNO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function member(overrides: Partial<ServerMember> & { id: string }): ServerMember {
  return {
    displayName: "Ana",
    username: "ana",
    tag: "ana#0001",
    role: "member",
    avatarUrl: null,
    status: "online",
    customStatus: null,
    ...overrides,
  };
}

function render(members: ServerMember[], blocked: string[] = []): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>
        <ProfilePopoverProvider
          currentUserId={ANA}
          blockedUserIds={new Set<string>()}
          moderation={null}
          onOpenConversation={() => {}}
          onBlockUser={() => {}}
          onUnblockUser={() => {}}
          onReportUser={() => {}}
        >
          <MemberSidebar
            open
            wide
            onClose={() => {}}
            serverId={SERVER_ID}
            participants={null}
            self={null}
            currentUserId={ANA}
            role="member"
            blockedUserIds={new Set(blocked)}
            members={members}
            onBlockUser={() => {}}
            onUnblockUser={() => {}}
          />
        </ProfilePopoverProvider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("the member row's recado line", () => {
  it("draws it under the name", () => {
    const html = render([
      member({ id: ANA, displayName: "Ana", customStatus: "no gym, volto as 20h" }),
    ]);
    expect(html).toContain("no gym, volto as 20h");
    expect(html).toContain(`data-member-custom-status="${ANA}"`);
  });

  it("truncates instead of wrapping, and carries the whole line in a title", () => {
    // A recado is capped at 80 characters and roughly 35 of them fit here, so
    // the truncation is the normal case and the title is where the rest lives.
    const long =
      "hoje eu to jogando valorant ate as tres da manha, chama no privado se quiser";
    const html = render([member({ id: ANA, customStatus: long })]);
    const line = /<span class="([^"]*)"[^>]*data-member-custom-status/.exec(html);
    expect(line).not.toBeNull();
    expect(line![1]).toContain("truncate");
    expect(html).toContain(`title="${long}"`);
  });

  it("draws nothing when there is none, so the row stays one line", () => {
    const html = render([member({ id: ANA, customStatus: null })]);
    expect(html).not.toContain("data-member-custom-status");
  });

  it("draws nothing for a blank one, which is the same state as none", () => {
    // The API stores NULL for a recado that normalises to nothing, but a client
    // that trusted that would draw an empty line the day something else did
    // not. An empty second line makes one row taller than its neighbours for
    // no visible reason.
    const html = render([member({ id: ANA, customStatus: "   " })]);
    expect(html).not.toContain("data-member-custom-status");
  });

  it("draws one person's and not another's", () => {
    const html = render([
      member({ id: ANA, displayName: "Ana", customStatus: "so na call" }),
      member({ id: BRUNO, displayName: "Bruno", customStatus: null }),
    ]);
    expect(html).toContain(`data-member-custom-status="${ANA}"`);
    expect(html).not.toContain(`data-member-custom-status="${BRUNO}"`);
  });

  it("draws nothing for somebody the viewer has blocked", () => {
    // A block is the reader saying they do not want this account's writing, and
    // the recado is the one thing on the row this account wrote. The name and
    // the picture stay: the row still has to be identifiable enough to unblock.
    const html = render(
      [member({ id: BRUNO, displayName: "Bruno", customStatus: "me chama" })],
      [BRUNO],
    );
    expect(html).toContain("Bruno");
    expect(html).not.toContain("me chama");
    expect(html).not.toContain("data-member-custom-status");
  });

  it("keeps emoji, which is most of what people put in one", () => {
    const html = render([
      member({ id: ANA, customStatus: "\u{1f480} morri \u{1f480}" }),
    ]);
    expect(html).toContain("\u{1f480} morri \u{1f480}");
  });
});
