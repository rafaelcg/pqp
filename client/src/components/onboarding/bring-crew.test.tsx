// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BringCrewAnnouncement } from "./bring-crew-announcement";
import { BringCrewStrip } from "./bring-crew-strip";

const noop = () => {};
const code = () => Promise.resolve("AbC123");

describe("BringCrewAnnouncement", () => {
  it("shows the announcement with the import's tagged link and one copy button", () => {
    const html = renderToStaticMarkup(
      <BringCrewAnnouncement serverName="Mesa" inviteCode="AbC123" />,
    );
    expect(html).toContain("data-bring-crew-copy");
    expect(html).toContain("/app/invite/AbC123?ref=discord");
    expect(html).toContain("1080p60");
    // The bold markers are drawn, not shown.
    expect(html).not.toContain("**");
    expect(html).toContain('role="radiogroup"');
  });
});

describe("BringCrewStrip", () => {
  it("counts arrivals with a plural", () => {
    const one = renderToStaticMarkup(
      <BringCrewStrip kind="arrived" count={1} serverName="Mesa" resolveInviteCode={code} onDismiss={noop} />,
    );
    expect(one).toContain("1 person from your crew is here");
    const many = renderToStaticMarkup(
      <BringCrewStrip kind="arrived" count={12} serverName="Mesa" resolveInviteCode={code} onDismiss={noop} />,
    );
    expect(many).toContain("12 people from your crew are here");
  });

  it("says nobody came without a zero plural", () => {
    const html = renderToStaticMarkup(
      <BringCrewStrip kind="reminder" count={0} serverName="Mesa" resolveInviteCode={code} onDismiss={noop} />,
    );
    expect(html).toContain("Your crew isn&#x27;t here yet");
    expect(html).toContain('data-bring-crew-kind="reminder"');
  });

  it("names how few came on the reminder", () => {
    const html = renderToStaticMarkup(
      <BringCrewStrip kind="reminder" count={2} serverName="Mesa" resolveInviteCode={code} onDismiss={noop} />,
    );
    expect(html).toContain("Only 2 people have come so far");
    expect(html).toContain("data-bring-crew-strip-copy");
    expect(html).toContain("data-bring-crew-close");
  });
});
