import { renderToStaticMarkup } from "react-dom/server";
import type { ThreadSummary } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import { translateMessage } from "@/lib/i18n";
import { ThreadChip, threadChipLabel } from "./thread-chip";

const t = translateMessage;

const BASE: ThreadSummary = {
  channelId: "11111111-1111-4111-8111-111111111111",
  parentChannelId: "22222222-2222-4222-8222-222222222222",
  rootMessageId: "33333333-3333-4333-8333-333333333333",
  name: "deploy broke again",
  replyCount: 3,
  lastActivityAt: new Date().toISOString(),
  archived: false,
};

describe("threadChipLabel", () => {
  it("distinguishes none, one, and many replies", () => {
    expect(threadChipLabel(t, 0)).toBe("No replies yet");
    expect(threadChipLabel(t, 1)).toBe("1 reply");
    expect(threadChipLabel(t, 3)).toBe("3 replies");
  });
});

describe("ThreadChip", () => {
  function render(thread: ThreadSummary, unread = false, isOpen = false) {
    return renderToStaticMarkup(
      <ThreadChip
        thread={thread}
        unread={unread}
        isOpen={isOpen}
        onOpen={() => {}}
        tabIndex={0}
      />,
    );
  }

  it("names the thread and counts its replies", () => {
    const html = render(BASE);
    expect(html).toContain("deploy broke again");
    expect(html).toContain("3 replies");
  });

  it("marks an inactive thread as archived instead of showing freshness", () => {
    const html = render({
      ...BASE,
      archived: true,
      lastActivityAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
    });
    expect(html).toContain("Archived");
    expect(html).not.toContain("<time");
  });

  it("carries the open state for the panel it toggles", () => {
    expect(render(BASE, false, true)).toContain('aria-expanded="true"');
    expect(render(BASE, false, false)).toContain('aria-expanded="false"');
  });
});
