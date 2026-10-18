import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Server } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ServerRail } from "./server-rail";

/**
 * A public server says so on the rail. The setting used to be invisible, and a
 * private test server stayed open to the directory for weeks because nothing
 * anywhere showed it. The mark is a globe on the icon, the word in the tooltip
 * and in the button's accessible description. The accessible NAME stays the
 * server's own, because people (and the e2e suite) find the button by it.
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
  it("draws the globe and describes a public server as public, on an instance with communities", () => {
    const html = rail(true);
    const open = buttonFor(html, "Aberta");
    expect(open).toContain("data-server-public");
    const describedBy = /aria-describedby="([^"]+)"/.exec(open)![1]!;
    expect(open).toContain(`<span id="${describedBy}" class="sr-only">Public</span>`);
  });

  it("leaves a private server's icon alone", () => {
    const html = rail(true);
    const closed = buttonFor(html, "Fechada");
    expect(closed).not.toContain("data-server-public");
    expect(closed).not.toContain("aria-describedby");
  });

  it("says nothing while the instance has communities off", () => {
    const html = rail(false);
    expect(html).not.toContain("data-server-public");
    expect(buttonFor(html, "Aberta")).not.toContain("aria-describedby");
  });
});
