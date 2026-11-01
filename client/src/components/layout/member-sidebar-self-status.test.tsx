import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { UserStatus } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProfilePopoverProvider } from "@/components/user/user-profile-popover";
import type { ServerMember } from "@/lib/api";
import { MemberSidebar } from "./member-sidebar";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const ANA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BRUNO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function member(
  overrides: Partial<ServerMember> & { id: string },
): ServerMember {
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

function render(members: ServerMember[], selfStatus: UserStatus | null): string {
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
            selfStatus={selfStatus}
            role="member"
            blockedUserIds={new Set<string>()}
            members={members}
            onBlockUser={() => {}}
            onUnblockUser={() => {}}
          />
        </ProfilePopoverProvider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

/** The pip that sits in the row of one person. */
function dotsOf(html: string): string[] {
  return [...html.matchAll(/data-status-dot="(\w+)"/g)].map((m) => m[1]!);
}

describe("the member list's own row", () => {
  it("follows the status the user panel holds, not the stale roster read", () => {
    // The roster still says dnd; the panel just went back to online.
    const stale = [
      member({ id: ANA, status: "dnd" }),
      member({ id: BRUNO, displayName: "Bruno", username: "bruno", status: "offline" }),
    ];
    expect(dotsOf(render(stale, null))).toContain("dnd");
    const fresh = dotsOf(render(stale, "online"));
    expect(fresh).not.toContain("dnd");
    expect(fresh).toContain("online");
  });

  it("leaves other people's rows to the roster", () => {
    const html = render(
      [
        member({ id: ANA, status: "online" }),
        member({ id: BRUNO, displayName: "Bruno", username: "bruno", status: "dnd" }),
      ],
      "idle",
    );
    const dots = dotsOf(html);
    expect(dots).toContain("idle");
    expect(dots).toContain("dnd");
    expect(dots).not.toContain("online");
  });
});
