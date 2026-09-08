import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Channel } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  ChannelOverviewSection,
  type ChannelOverviewDraft,
} from "./channel-overview-section";

/**
 * Which controls a channel's Overview offers, and to which kind of channel.
 *
 * Slow mode is the one that matters here. A voice channel carries its own
 * chat, shown beside the call, and during a busy call that chat is exactly
 * where the flooding happens. The setting was drawn for text channels only,
 * so a moderator running a 510-member community had the one tool for a flood
 * greyed out on the only surface that was flooding: "n da pra por slow mode
 * em chat de call".
 */

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    serverId: "11111111-1111-4111-8111-111111111111",
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
    ...overrides,
  } as Channel;
}

function draftOf(one: Channel): ChannelOverviewDraft {
  return {
    name: one.name,
    topic: "",
    imageUrl: "",
    slowmodeSeconds: one.slowmodeSeconds ?? 0,
    voiceRoomSize: "auto",
  };
}

function render(one: Channel) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ChannelOverviewSection
        channel={one}
        draft={draftOf(one)}
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

describe("ChannelOverviewSection slow mode", () => {
  it("offers slow mode on a text channel", () => {
    const html = render(channel());
    expect(html).toContain("Slow mode");
    expect(html).toContain("15 seconds");
  });

  it("offers slow mode on a voice channel, whose chat is what floods", () => {
    const html = render(channel({ type: "voice", name: "Lobby" }));
    expect(html).toContain("Slow mode");
    expect(html).toContain("15 seconds");
    // And says which sound it slows, so nobody reads it as slowing the talking.
    expect(html).toContain("Applies to the chat beside the call");
  });

  /**
   * A watch party is a voice room with a screen on it, and it is the one
   * channel type built for an audience of hundreds. The server has always
   * enforced the wait there; for a while it was the only surface with no
   * control to set it.
   */
  it("offers slow mode on a watch party too", () => {
    const html = render(channel({ type: "watch_party", name: "Sessao" }));
    expect(html).toContain("Slow mode");
    expect(html).toContain("15 seconds");
    expect(html).toContain("Applies to the chat beside the call");
  });

  it("keeps the plain hint on a text channel", () => {
    const html = render(channel());
    expect(html).toContain("One message per interval, per person.");
    expect(html).not.toContain("beside the call");
  });

  /** Both exempt bits are named, because both are what the server waives. */
  it("names Manage Messages and Manage Channels as the way past it", () => {
    const html = render(channel());
    expect(html).toContain("Manage Messages or Manage Channels skips it");
  });

  it("shows the interval already set on a voice channel", () => {
    const html = render(channel({ type: "voice", slowmodeSeconds: 30 }));
    expect(html).toMatch(/<option[^>]*selected[^>]*value="30"|value="30"[^>]*selected/);
  });

  it("does not offer slow mode on a category, which nobody posts into", () => {
    const html = render(channel({ type: "category", name: "Salas" }));
    expect(html).not.toContain("Slow mode");
  });
});
