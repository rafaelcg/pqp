import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Server } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ServerRail } from "./server-rail";

/**
 * A public server says so on the rail. The setting used to be invisible, and a
 * private test server stayed open to the directory for weeks because nothing
 * anywhere showed it. The mark is the word in the accessible name (what a
 * screen reader and the tooltip say) and a globe on the icon.
 */

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";

function server(id: string, name: string, isCommunity: boolean): Server {
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
    isCommunity,
  } as Server;
}

function rail(communitiesEnabled: boolean) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ServerRail
        communitiesEnabled={communitiesEnabled}
        servers={[server(S1, "Aberta", true), server(S2, "Fechada", false)]}
        selectedServerId={null}
        serverUnread={{}}
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

function buttonFor(html: string, label: string): string {
  const escaped = label.replace(/[()]/g, "\\$&");
  const match = new RegExp(
    `<button[^>]*aria-label="${escaped}"[\\s\\S]*?</button>`,
  ).exec(html);
  if (!match) {
    throw new Error(`no button for ${label}`);
  }
  return match[0];
}

describe("ServerRail public mark", () => {
  it("names a public server as public and draws the globe, on an instance with communities", () => {
    const html = rail(true);
    const open = buttonFor(html, "Aberta (public)");
    expect(open).toContain("data-server-public");
  });

  it("leaves a private server's name and icon alone", () => {
    const html = rail(true);
    const closed = buttonFor(html, "Fechada");
    expect(closed).not.toContain("data-server-public");
    expect(html).not.toContain("Fechada (public)");
  });

  it("says nothing while the instance has communities off", () => {
    const html = rail(false);
    expect(html).not.toContain("data-server-public");
    expect(html).not.toContain("(public)");
    expect(buttonFor(html, "Aberta")).toBeTruthy();
  });
});
