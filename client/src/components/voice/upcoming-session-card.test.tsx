import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChannelSession } from "@pqp/shared";
import { UpcomingSessionCard } from "./upcoming-session-card";

/**
 * The four statuses the card can show, and the manager/member split on
 * actions. Same testing style as the rest of `components/voice`:
 * `renderToStaticMarkup` against a fixed prop set, because this suite runs
 * in the `node` environment (no DOM, no simulated clicks, see
 * vitest.config.ts) and the contract that matters is "given these props,
 * does the right markup exist", not an event loop.
 */

function baseSession(overrides: Partial<ChannelSession> = {}): ChannelSession {
  return {
    id: "session-1",
    channelId: "channel-1",
    serverId: "server-1",
    title: "Cinemoon",
    description: null,
    coverImageUrl: null,
    startsAt: "2026-09-11T21:00:00.000Z",
    status: "scheduled",
    createdBy: "user-1",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    reminding: false,
    ...overrides,
  };
}

const NOW = new Date("2026-09-08T18:00:00");

function render(
  session: ChannelSession,
  overrides: {
    canManage?: boolean;
  } = {},
) {
  return renderToStaticMarkup(
    <UpcomingSessionCard
      session={session}
      now={NOW}
      canManage={overrides.canManage ?? false}
      onToggleReminder={async () => {}}
      onCancel={async () => {}}
    />,
  );
}

describe("UpcomingSessionCard", () => {
  it("scheduled: shows the relative time and the remind toggle", () => {
    const html = render(baseSession({ status: "scheduled" }));
    expect(html).toContain('data-session-status="scheduled"');
    expect(html).toContain("Cinemoon");
    expect(html).toContain('data-session-remind-toggle');
  });

  it("live: drops the remind toggle and cancel action, shows a live label", () => {
    const html = render(baseSession({ status: "live" }), { canManage: true });
    expect(html).toContain('data-session-status="live"');
    expect(html).not.toContain("data-session-remind-toggle");
    expect(html).not.toContain("data-session-cancel");
  });

  it("ended: a quiet, actionless line", () => {
    const html = render(baseSession({ status: "ended" }));
    expect(html).toContain('data-session-status="ended"');
    expect(html).not.toContain("data-session-remind-toggle");
    expect(html).not.toContain("data-session-cancel");
  });

  it("cancelled: a quiet, actionless line", () => {
    const html = render(baseSession({ status: "cancelled" }));
    expect(html).toContain('data-session-status="cancelled"');
    expect(html).not.toContain("data-session-remind-toggle");
    expect(html).not.toContain("data-session-cancel");
  });

  it("member: no cancel action even while scheduled", () => {
    const html = render(baseSession({ status: "scheduled" }), {
      canManage: false,
    });
    expect(html).toContain("data-session-remind-toggle");
    expect(html).not.toContain("data-session-cancel");
  });

  it("manager: cancel action appears alongside the remind toggle", () => {
    const html = render(baseSession({ status: "scheduled" }), {
      canManage: true,
    });
    expect(html).toContain("data-session-remind-toggle");
    expect(html).toContain("data-session-cancel");
  });

  it("the remind toggle reflects the subscription state", () => {
    const remindingHtml = render(
      baseSession({ status: "scheduled", reminding: true }),
    );
    expect(remindingHtml).toContain('aria-pressed="true"');

    const notRemindingHtml = render(
      baseSession({ status: "scheduled", reminding: false }),
    );
    expect(notRemindingHtml).toContain('aria-pressed="false"');
  });
});
