import { renderToStaticMarkup } from "react-dom/server";
import { deriveThreadName, type ThreadSummary } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import { translateMessage } from "@/lib/i18n";
import { ThreadChip, threadChipLabel } from "./thread-chip";

const t = translateMessage;

const ORIGIN_BODY = "the deploy broke again, same as tuesday";

const BASE: ThreadSummary = {
  channelId: "11111111-1111-4111-8111-111111111111",
  parentChannelId: "22222222-2222-4222-8222-222222222222",
  rootMessageId: "33333333-3333-4333-8333-333333333333",
  name: deriveThreadName(ORIGIN_BODY),
  replyCount: 3,
  lastActivityAt: new Date().toISOString(),
  archived: false,
  participants: [
    { id: "44444444-4444-4444-8444-444444444444", displayName: "Bia", avatarUrl: null },
  ],
};

describe("threadChipLabel", () => {
  it("distinguishes none, one, and many replies", () => {
    expect(threadChipLabel(t, 0)).toBe("No replies yet");
    expect(threadChipLabel(t, 1)).toBe("1 reply");
    expect(threadChipLabel(t, 3)).toBe("3 replies");
  });
});

describe("ThreadChip", () => {
  function render(
    thread: ThreadSummary,
    {
      originBody = ORIGIN_BODY,
      unread = false,
      isOpen = false,
    }: { originBody?: string | null; unread?: boolean; isOpen?: boolean } = {},
  ) {
    return renderToStaticMarkup(
      <ThreadChip
        thread={thread}
        originBody={originBody}
        unread={unread}
        isOpen={isOpen}
        onOpen={() => {}}
        tabIndex={0}
      />,
    );
  }

  it("does not reprint a name still derived from the origin message", () => {
    const html = render(BASE);
    // Once, in the aria-label, which is the only place a screen reader can
    // learn which thread this is. Never in the visible row.
    expect(html.split(ORIGIN_BODY)).toHaveLength(2);
    expect(html).toContain(`aria-label="Open thread ${ORIGIN_BODY}`);
    expect(html).toContain("3 replies");
  });

  it("names a thread somebody renamed", () => {
    const html = render({ ...BASE, name: "tuesday's deploy" });
    expect(html).toContain("tuesday&#x27;s deploy");
  });

  it("names the thread when the origin message is gone", () => {
    const html = render(BASE, { originBody: null });
    expect(html).toContain(deriveThreadName(ORIGIN_BODY));
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

  it("shows how long ago the last reply landed", () => {
    const html = render({
      ...BASE,
      lastActivityAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    });
    expect(html).toContain("<time");
    expect(html).toContain("2 min. ago");
  });

  it("shows who is in the thread instead of a generic icon", () => {
    expect(render(BASE)).not.toContain("lucide-message-square-text");
    expect(render({ ...BASE, participants: [] })).toContain(
      "lucide-message-square-text",
    );
  });

  it("holds the unread dot until the thread is open", () => {
    const dot = "h-1.5 w-1.5 shrink-0 rounded-full bg-accent";
    expect(render(BASE, { unread: true })).toContain(dot);
    expect(render(BASE, { unread: true, isOpen: true })).not.toContain(dot);
  });

  it("carries the open state for the panel it toggles", () => {
    expect(render(BASE, { isOpen: true })).toContain('aria-expanded="true"');
    expect(render(BASE)).toContain('aria-expanded="false"');
  });
});
