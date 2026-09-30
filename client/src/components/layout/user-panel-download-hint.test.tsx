import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PartyNewcomerStrip } from "@/components/onboarding/party-newcomer-strip";
import { UserPanel } from "./user-panel";

function panel(props: Partial<Parameters<typeof UserPanel>[0]> = {}) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <UserPanel
        displayName="Ana"
        tag="ana#0001"
        handle={null}
        avatarUrl={null}
        isMuted={false}
        isDeafened={false}
        inVoice={false}
        showUserButton={false}
        manualStatus="online"
        effectiveStatus="online"
        statusSaving={false}
        statusError={null}
        onSetStatus={() => {}}
        customStatus=""
        customStatusSaving={false}
        customStatusError={null}
        onSetCustomStatus={() => {}}
        onClearCustomStatusError={() => {}}
        onToggleMute={() => {}}
        onToggleDeafen={() => {}}
        onOpenSettings={() => {}}
        onOpenFeedback={() => {}}
        onOpenProfile={() => {}}
        {...props}
      />
    </TooltipProvider>,
  );
}

describe("the get-the-app strip over the user row", () => {
  it("is there by default, for everybody", () => {
    expect(panel()).toContain("Get the app");
  });

  it("is held back for a newcomer in a live party", () => {
    expect(panel({ hideDownloadHint: true })).not.toContain(
      "Get the app",
    );
  });
});

describe("PartyNewcomerStrip", () => {
  it("names the host and where the chat is", () => {
    const beside = renderToStaticMarkup(
      <PartyNewcomerStrip hostName="Ana" chatBeside onDismiss={() => {}} />,
    );
    expect(beside).toContain("Ana is sharing their screen");
    expect(beside).toContain("on the right");
    expect(beside).toContain("data-party-newcomer-strip");
    const below = renderToStaticMarkup(
      <PartyNewcomerStrip
        hostName="Ana"
        chatBeside={false}
        onDismiss={() => {}}
      />,
    );
    expect(below).toContain("Ana is sharing their screen");
    expect(below).toContain("right below");
  });

  it("has a nameless line for a host it cannot name, and a labelled close", () => {
    const html = renderToStaticMarkup(
      <PartyNewcomerStrip hostName="  " chatBeside onDismiss={() => {}} />,
    );
    expect(html).toContain("someone is sharing their screen");
    expect(html).toContain('aria-label="Got it"');
  });
});
