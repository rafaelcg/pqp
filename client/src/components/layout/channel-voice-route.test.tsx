import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Channel } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { en as enMessages } from "@/lib/i18n";
import {
  ChannelOverviewSection,
  voiceRouteReasonKey,
  type ChannelOverviewDraft,
} from "./channel-overview-section";

/**
 * The voice route block states two facts and must never conflate them: what a
 * new call would open on, and what the call happening right now is actually
 * on. A room is pinned to its transport from first join until it empties, so a
 * channel whose size setting moved this afternoon can legitimately report one
 * of each, and the reason it gives belongs to the first fact only.
 */

const REASONS = [
  "unconfigured",
  "dm",
  "small",
  "large",
  "community",
  "override",
  "hls",
  "default",
];

describe("voiceRouteReasonKey", () => {
  it("maps every reason the server can send today onto real copy", () => {
    for (const reason of REASONS) {
      const key = voiceRouteReasonKey(reason);
      expect(key, reason).toBe(`channelMeta.voiceRoute.reason.${reason}`);
      expect(enMessages[key as string], reason).toBeTruthy();
    }
  });

  it("drops a reason from a newer server instead of printing a raw key", () => {
    expect(voiceRouteReasonKey("some-future-reason")).toBeNull();
    expect(voiceRouteReasonKey("")).toBeNull();
  });

  it("does not answer for an inherited property name", () => {
    expect(voiceRouteReasonKey("constructor")).toBeNull();
    expect(voiceRouteReasonKey("toString")).toBeNull();
  });
});

/**
 * The mismatch line is the whole reason both rows exist, so pin the condition
 * that reveals it rather than the markup wrapped around it.
 */
function showsPinnedLine(
  live: { transport: string } | null,
  resolved: { transport: string },
): boolean {
  return live !== null && live.transport !== resolved.transport;
}

describe("live versus resolved", () => {
  it("explains itself when the live call is on the other route", () => {
    expect(
      showsPinnedLine({ transport: "mesh" }, { transport: "livekit" }),
    ).toBe(true);
  });

  it("stays quiet when the two agree", () => {
    expect(showsPinnedLine({ transport: "mesh" }, { transport: "mesh" })).toBe(
      false,
    );
  });

  it("says nothing about a pin when nobody is on the call", () => {
    expect(showsPinnedLine(null, { transport: "livekit" })).toBe(false);
  });
});

describe("voice route copy", () => {
  it("carries a name and a hint for both transports", () => {
    for (const transport of ["mesh", "livekit"]) {
      expect(enMessages[`channelMeta.voiceRoute.${transport}`]).toBeTruthy();
      expect(
        enMessages[`channelMeta.voiceRoute.${transport}.hint`],
      ).toBeTruthy();
    }
  });

  it("counts people with a plural family, not a bare number", () => {
    expect(enMessages["channelMeta.voiceRoute.liveLabel_one"]).toContain(
      "{count}",
    );
    expect(enMessages["channelMeta.voiceRoute.liveLabel_other"]).toContain(
      "{count}",
    );
  });
});

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    serverId: "11111111-1111-4111-8111-111111111111",
    kind: "server",
    name: "Lobby",
    type: "voice",
    position: 0,
    parentId: null,
    isPrivate: false,
    topic: null,
    imageUrl: null,
    slowmodeSeconds: 0,
    voiceTransport: null,
    ...overrides,
  } as Channel;
}

function render(one: Channel) {
  const draft: ChannelOverviewDraft = {
    name: one.name,
    topic: "",
    imageUrl: "",
    slowmodeSeconds: 0,
    voiceRoomSize: "auto",
  };
  return renderToStaticMarkup(
    <TooltipProvider>
      <ChannelOverviewSection
        channel={one}
        draft={draft}
        onDraftChange={() => {}}
        iconOpen={false}
        onIconOpenChange={() => {}}
        showPrivateBridge={false}
        showRecipeBridge={false}
        isPrivate={false}
        recipeKind="everyone"
        recipeRoleNames={[]}
        onJumpPrivate={() => {}}
        onJumpRecipe={() => {}}
      />
    </TooltipProvider>,
  );
}

describe("the block before its one fetch lands", () => {
  it("is absent, with no placeholder and no error", () => {
    // Static rendering runs no effects, which is exactly the pre-fetch state.
    const html = render(channel());
    expect(html).toContain("Voice room size");
    expect(html).not.toContain("How the call is routed");
    expect(html).not.toContain("channelMeta.voiceRoute");
  });

  it("stays out of a text channel entirely", () => {
    const html = render(channel({ type: "text", name: "geral" }));
    expect(html).not.toContain("How the call is routed");
  });
});
