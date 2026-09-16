import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { WatchParty } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LivePartyBlock } from "./live-party-block";

const PARTY: WatchParty = {
  id: "11111111-1111-4111-8111-111111111111",
  channelId: "22222222-2222-4222-8222-222222222222",
  serverId: "33333333-3333-4333-8333-333333333333",
  name: "Cinemoon",
  description: null,
  state: "live",
  startsAt: null,
  wentLiveAt: "2026-09-08T12:00:00.000Z",
  endedAt: null,
  hostUserId: "44444444-4444-4444-8444-444444444444",
  hostDisplayName: "Alice",
  hostAvatarUrl: null,
  hostDisconnectedAt: null,
  cohosts: [],
  options: {
    voiceEnabled: false,
    guests: "off",
    stageMode: "hosts_only",
    raiseHand: true,
    slowModeSeconds: 0,
    reactionsEnabled: true,
    lowLatency: false,
  },
  viewerRole: "host",
  reminding: false,
  stage: { invited: [], hands: [], handRaised: false },
  guests: {
    onAir: [],
    invited: [],
    requests: [],
    requestCount: 0,
    requested: false,
    position: null,
  },
};

function markup(recoveringChannelId: string | null) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>
        <LivePartyBlock
          parties={[PARTY]}
          selectedChannelId={null}
          audience={{ [PARTY.channelId]: 3 }}
          onWatch={() => {}}
          recoveringChannelId={recoveringChannelId}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

/**
 * The exact surface the host stared at for 35 minutes on 2026-09-16:
 * "AO VIVO · 3 assistindo · <uptime>". When THIS viewer is the presenter and
 * their own screen publish has dropped, the card must tell the truth instead.
 */
describe("the sidebar live block when the presenter's own publish drops", () => {
  it("shows the live badge and the viewer count for a healthy party", () => {
    const html = markup(null);
    expect(html).toContain('data-watch-party-live-pill=""');
    // The audience number and its accessible "watching" label are present.
    expect(html).toContain('data-live-party-audience="3"');
  });

  it("flips to reconnecting and drops the viewer count on the presenter's own dead party", () => {
    const html = markup(PARTY.channelId);
    expect(html).toContain('data-watch-party-live-pill="recovering"');
    // No fake live badge, and no viewer/uptime line over a stream reaching nobody.
    expect(html).not.toContain('data-watch-party-live-pill=""');
    expect(html).not.toContain('data-live-party-audience="3"');
  });

  it("leaves a different channel's card untouched", () => {
    // Recovering somewhere else must not rewrite this party's card.
    const html = markup("99999999-9999-4999-8999-999999999999");
    expect(html).toContain('data-watch-party-live-pill=""');
    expect(html).toContain('data-live-party-audience="3"');
  });
});
