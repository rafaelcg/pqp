import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ServerRail } from "./server-rail";

function rail(extra: { phoneHidden?: boolean; mobileNavOpen?: boolean } = {}) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ServerRail
        servers={[]}
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
        {...extra}
      />
    </TooltipProvider>,
  );
}

const navClass = (html: string) =>
  /^<nav[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";

describe("ServerRail on a phone during a live party", () => {
  it("is untouched by default", () => {
    const html = rail();
    expect(navClass(html)).not.toContain("max-md:");
    expect(html).not.toContain("data-rail-phone-hidden");
  });

  it("leaves the flow under md while the nav drawer is shut", () => {
    const html = rail({ phoneHidden: true });
    expect(navClass(html)).toContain("max-md:hidden");
    expect(html).toContain("data-rail-phone-hidden");
  });

  it("comes back over the page, not in the flow, when the drawer opens", () => {
    const cls = navClass(rail({ phoneHidden: true, mobileNavOpen: true }));
    expect(cls).not.toContain("max-md:hidden");
    expect(cls).toContain("max-md:fixed");
    expect(cls).toContain("max-md:left-0");
  });
});
