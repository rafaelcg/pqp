import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setServerNotificationLevel } from "@/lib/notifications";
import { ServerRail } from "./server-rail";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";

function server(id: string, name: string): Server {
  return {
    id,
    name,
    ownerId: "33333333-3333-4333-8333-333333333333",
    role: "member",
    createdAt: "2026-01-01T00:00:00.000Z",
    messageRetentionDays: null,
    ssoEmailDomain: null,
    iconUrl: null,
    bannerUrl: null,
    isCommunity: false,
  } as Server;
}

function rail(extra: {
  selectedServerId?: string | null;
  serverUnread?: Record<string, { count: number; mentions: number }>;
  serverBauUnread?: Record<string, number>;
}) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ServerRail
        servers={[server(S1, "Filminho"), server(S2, "Outro")]}
        selectedServerId={extra.selectedServerId ?? null}
        serverUnread={extra.serverUnread ?? {}}
        serverBauUnread={extra.serverBauUnread}
        homeSelected={false}
        homeUnread={{ count: 0, mentions: 0 }}
        onSelectHome={() => {}}
        onSelectServer={() => {}}
        onCreateServer={() => {}}
        onJoinServer={() => {}}
        onInvite={() => {}}
        onOpenMembers={() => {}}
        onOpenSettings={() => {}}
        onLeaveServer={() => {}}
      />
    </TooltipProvider>,
  );
}

/** The markup of one server's button. */
function buttonFor(html: string, name: string): string {
  const match = new RegExp(`<button[^>]*aria-label="${name}"[\\s\\S]*?</button>`).exec(
    html,
  );
  if (!match) {
    throw new Error(`no button for ${name}`);
  }
  return match[0];
}

afterEach(() => {
  setServerNotificationLevel(S1, null);
});

describe("ServerRail with an unread Baú", () => {
  it("shows a lime count at the corner on a server that is not open", () => {
    const html = rail({ serverBauUnread: { [S1]: 3 } });
    const lit = buttonFor(html, "Filminho");
    expect(lit).toContain("bg-paper");
    expect(lit).toContain("data-bau-count=\"3\"");
    expect(lit).toContain("bg-signal text-ink");
    expect(lit).not.toContain("bg-danger");
    expect(lit).toContain("3 new posts in Ba");
    expect(lit).not.toContain("ring-signal");
    const quiet = buttonFor(html, "Outro");
    expect(quiet).not.toContain("data-bau-count");
    expect(quiet).not.toContain("bg-paper group-hover");
  });

  it("caps the lime count at 9+", () => {
    const html = rail({ serverBauUnread: { [S1]: 40 } });
    const lit = buttonFor(html, "Filminho");
    expect(lit).toContain(">9+<");
    expect(lit).toContain("40 new posts in Ba");
  });

  it("gives the corner to the red mention count and rings the icon in lime instead", () => {
    const html = rail({
      serverBauUnread: { [S1]: 3 },
      serverUnread: { [S1]: { count: 5, mentions: 2 } },
    });
    const lit = buttonFor(html, "Filminho");
    expect(lit).toContain("bg-danger");
    expect(lit).toContain("animate-badge-pop");
    expect(lit).not.toContain("data-bau-count");
    expect(lit).toContain("ring-signal");
    expect(lit).toContain('data-bau-cue="ring"');
  });

  it("says nothing for a muted server", () => {
    setServerNotificationLevel(S1, "none");
    const html = rail({ serverBauUnread: { [S1]: 3 } });
    const muted = buttonFor(html, "Filminho");
    expect(muted).not.toContain("data-bau-count");
    expect(muted).not.toContain("data-bau-cue");
    expect(muted).not.toContain("bg-paper group-hover");
    expect(muted).toContain("opacity-50");
  });

  it("draws the open server as selected, and still counts its unread posts", () => {
    const html = rail({ selectedServerId: S1, serverBauUnread: { [S1]: 3 } });
    const open = buttonFor(html, "Filminho");
    expect(open).toContain("bg-signal");
    expect(open).not.toContain("bg-paper group-hover");
    expect(open).toContain("data-bau-count");
  });
});
