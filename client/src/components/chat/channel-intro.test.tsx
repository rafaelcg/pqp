import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChannelIntro } from "./channel-intro";

/**
 * The intro offers only what the viewer may do: no invite without the
 * invite callback, no topic card once the channel has a topic.
 */
describe("ChannelIntro", () => {
  it("shows the topic at the start and the two buttons the viewer may use", () => {
    const html = renderToStaticMarkup(
      <ChannelIntro
        info={{ name: "general", topic: "Papo geral", onCopyInvite: async () => {}, onEdit: () => {} }}
        empty={false}
      />,
    );
    expect(html).toContain("data-channel-intro=\"start\"");
    expect(html).toContain("Papo geral");
    expect(html).toContain("data-channel-intro-invite");
    expect(html).toContain("data-channel-intro-edit");
  });

  it("draws no actions without permissions, and no topic card when there is a topic", () => {
    const bare = renderToStaticMarkup(
      <ChannelIntro info={{ name: "general", topic: null }} empty />,
    );
    expect(bare).not.toContain("data-channel-intro-invite");
    expect(bare).not.toContain("data-channel-intro-topic");
    const withTopic = renderToStaticMarkup(
      <ChannelIntro info={{ name: "clipes", topic: "x", onEdit: () => {} }} empty />,
    );
    expect(withTopic).not.toContain("data-channel-intro-topic");
  });
});
