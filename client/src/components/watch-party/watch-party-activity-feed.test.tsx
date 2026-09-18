// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WatchPartyActivityFeed } from "./watch-party-activity-feed";

describe("WatchPartyActivityFeed", () => {
  it("draws an empty feed with the audience count before anything happens", () => {
    const html = renderToStaticMarkup(
      <WatchPartyActivityFeed channelId="c1" audienceCount={0} hands={[]} />,
    );
    expect(html).toContain('data-testid="watch-party-activity"');
    expect(html).toContain("Nothing yet");
  });
});
