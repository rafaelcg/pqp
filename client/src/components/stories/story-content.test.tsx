import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StoryContent, type StoryDisplay } from "./story-content";

const call: StoryDisplay = {
  id: "s1",
  kind: "text",
  text: "Bora pra call?",
  background: "lime",
  caption: null,
  mediaUrl: null,
  posterUrl: null,
  call: {
    serverId: "11111111-1111-4111-8111-111111111111",
    channelId: "22222222-2222-4222-8222-222222222222",
    channelName: "Lobby",
    participants: [{ id: "a", displayName: "Ana", avatarUrl: null, handle: null }],
    count: 1,
    state: "live",
    joinable: true,
  },
};

describe("call sticker colours", () => {
  // The sticker sits on the story's own dark surface in both themes. The
  // light theme's accent is a dark green made for paper: on this surface the
  // label and the button all but vanished (found in the pre-launch QA).
  it("reads the story's own accent, never the theme's", () => {
    const html = renderToStaticMarkup(<StoryContent story={call} onJoinCall={() => {}} />);
    expect(html).toContain("var(--story-accent-soft)");
    expect(html).toContain("background:var(--story-accent)");
    expect(html).not.toMatch(/\btext-accent\b|\bbg-accent\b|\btext-on-accent-soft\b|\btext-text-secondary\b/);
  });
});
