import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { JamTakeNotice } from "@pqp/shared";
import { I18nProvider } from "@/lib/i18n";
import { JamTakeNoticeCards } from "./jam-take-notice-cards";

const SONG = "11111111-1111-4111-8111-111111111111";
const item = (over: Partial<JamTakeNotice> = {}): JamTakeNotice => ({
  id: "n1",
  kind: "take",
  songId: SONG,
  title: "Lua cheia",
  instruments: ["bass"],
  count: 1,
  createdAt: "2026-11-26T12:00:00.000Z",
  updatedAt: "2026-11-26T12:00:00.000Z",
  ...over,
});

function html(notices: JamTakeNotice[], more = 0, placement: "overlay" | "inline" = "overlay"): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <JamTakeNoticeCards notice={notices[0] ?? null} more={more} placement={placement} onOpen={vi.fn()} onDismiss={vi.fn()} />
    </I18nProvider>,
  );
}

describe("JamTakeNoticeCards", () => {
  it("draws nothing without items", () => {
    expect(html([])).toBe("");
  });

  it("a take card names the instrument and the song, and its button says to answer", () => {
    const out = html([item()]);
    expect(out).toContain("data-jam-take-notice=\"take\"");
    expect(out).toContain("A bass part arrived");
    expect(out).toContain("Lua cheia");
    expect(out).toContain("See and answer");
    expect(out).toContain("data-jam-take-notice-dismiss");
  });

  it("a burst reads as a count with every instrument", () => {
    const out = html([item({ count: 3, instruments: ["bass", "drums"] })]);
    expect(out).toContain("3 parts are waiting for your answer");
    expect(out).toContain("bass and drums");
  });

  it("the sender's answers say accepted or refused, and open the song rather than ask to answer", () => {
    const accepted = html([item({ kind: "accepted" })]);
    expect(accepted).toContain("Your bass part is in");
    expect(accepted).toContain("Open the song");
    expect(accepted).not.toContain("See and answer");
    expect(html([item({ kind: "refused" })])).toContain("did not make it in");
  });

  it("draws ONE card and says how many wait behind it (round 3, N-1: they were a stack that covered the record button)", () => {
    const one = html([item({ id: "a" })], 2);
    expect(one.match(/data-jam-take-notice=/g)).toHaveLength(1);
    expect(one).toContain("data-jam-take-notice-more=\"2\"");
    expect(one).toContain("2 more");
    expect(html([item()], 0)).not.toContain("data-jam-take-notice-more");
  });

  it("floats at the corner on a desktop and above the bar on a phone, never at the top where the app's own buttons are", () => {
    const out = html([item()]);
    expect(out).toContain("data-placement=\"overlay\"");
    expect(out).toContain("fixed");
    expect(out).toContain("sm:bottom-4");
    expect(out).not.toContain("sm:top-");
  });

  it("inside a view it is in the flow, not fixed, so it cannot cover the song's controls", () => {
    const out = html([item()], 0, "inline");
    expect(out).toContain("data-placement=\"inline\"");
    expect(out).not.toContain("fixed");
    expect(out).not.toContain("elevation-3");
  });

  it("an unnamed instrument has words of its own", () => {
    expect(html([item({ instruments: ["other"] })])).toContain("another instrument");
  });
});
