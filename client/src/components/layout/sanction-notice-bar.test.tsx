import { renderToStaticMarkup } from "react-dom/server";
import type { SanctionNotice } from "@pqp/shared";
import { afterEach, describe, expect, it } from "vitest";
import { en, setActiveCatalogue } from "@/lib/i18n/catalogue";
import { SanctionNoticeBar } from "./sanction-notice-bar";

afterEach(() => setActiveCatalogue(undefined));

const notice: SanctionNotice = {
  type: "sanction-notice",
  sanction: "timeout",
  serverId: "11111111-1111-4111-8111-111111111111",
  channelId: "22222222-2222-4222-8222-222222222222",
  expiresAt: "2026-08-08T12:00:00.000Z",
  reason: "being loud",
  message:
    "You are timed out in this server until 2026-08-08T12:00:00.000Z. You can still read, but you cannot post, react or join voice until then.",
};

describe("SanctionNoticeBar", () => {
  it("renders the server's sentence verbatim", () => {
    const html = renderToStaticMarkup(
      <SanctionNoticeBar notice={notice} onDismiss={() => {}} />,
    );
    // `describeTimeout` is the single author of this sentence, across the HTTP
    // 403 body and this frame. A client that re-words it starts a second,
    // drifting explanation of the same state.
    expect(html).toContain(
      "You are timed out in this server until 2026-08-08T12:00:00.000Z.",
    );
    expect(html).toContain("you cannot post, react or join voice");
  });

  it("does not leak the expiry or reason as separate copy", () => {
    // Everything the person needs is already in `message`; re-rendering the
    // parts beside it is how the two get to disagree.
    const html = renderToStaticMarkup(
      <SanctionNoticeBar notice={notice} onDismiss={() => {}} />,
    );
    expect(html).not.toContain("being loud");
  });

  it("announces itself without shouting", () => {
    const html = renderToStaticMarkup(
      <SanctionNoticeBar notice={notice} onDismiss={() => {}} />,
    );
    // `status`, not `alert`: a timeout is a state to read, not an emergency to
    // interrupt whatever the screen reader was saying.
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
  });

  it("takes its own chrome from the catalogue and the sentence from the frame", () => {
    const html = renderToStaticMarkup(
      <SanctionNoticeBar notice={notice} onDismiss={() => {}} />,
    );
    // The label is looked up, not written into the JSX — following `en` here is
    // what would fail if someone hardcoded the word back in. The server's
    // sentence is the opposite: it must survive untouched in every language,
    // because the server, not the catalogue, is its author.
    expect(html).toContain(en["connection.dismiss"]);
    expect(html).toContain(notice.message);
  });

  it("renders English when no catalogue has loaded, never a key name", () => {
    // Outside a provider — which is the state of the app for the first frames
    // after boot, and for every render in this suite.
    setActiveCatalogue(undefined);
    const html = renderToStaticMarkup(
      <SanctionNoticeBar notice={notice} onDismiss={() => {}} />,
    );
    expect(html).toContain("Dismiss");
    expect(html).not.toContain("connection.dismiss");
  });
});
