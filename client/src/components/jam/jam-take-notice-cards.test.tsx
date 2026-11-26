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

function html(notices: JamTakeNotice[], lifted = false): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <JamTakeNoticeCards notices={notices} lifted={lifted} onOpen={vi.fn()} onDismiss={vi.fn()} />
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

  it("at most two cards stack, and a toast in the corner lifts them instead of covering it", () => {
    const three = html([item({ id: "a" }), item({ id: "b", kind: "accepted" }), item({ id: "c", kind: "refused" })], true);
    expect(three.match(/data-jam-take-notice=/g)).toHaveLength(2);
    expect(three).toContain("148px");
  });

  it("an unnamed instrument has words of its own", () => {
    expect(html([item({ instruments: ["other"] })])).toContain("another instrument");
  });
});
