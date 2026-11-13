import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { song } from "@/lib/jam-test-fixtures";
import { JamLinkCard, JamLinkCardView } from "./jam-link-card";

function render(value: ReturnType<typeof song>): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <JamLinkCardView song={value} href="/app/server/s/channel/c/song/x" onOpen={() => undefined} />
    </I18nProvider>,
  );
}

const LINK = {
  serverId: "33333333-3333-4333-8333-333333333333",
  channelId: "22222222-2222-4222-8222-222222222222",
  songId: "11111111-1111-4111-8111-111111111111",
  url: "http://localhost/x",
  origin: "http://localhost",
  start: 0,
  end: 1,
};

describe("JamLinkCardView", () => {
  it("is one row: the title is the link that opens the song, and the round button plays it", () => {
    const html = render(song({ instruments: ["guitar", "vocals"], contributorCount: 2 }));
    expect(html).toContain("data-jam-link-card=");
    expect(html).toContain("data-jam-card-open");
    expect(html).toContain("data-jam-card-play");
    // exactly two tab stops: the link and the button
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html.match(/<button /g)).toHaveLength(1);
    expect(html).toContain("In Bloom");
    expect(html).toContain("Nirvana");
  });

  it("says what is missing in words, with the missing part drawn dashed", () => {
    const html = render(
      song({ joinMode: "wanted", wantedInstruments: ["bass", "guitar"], instruments: ["guitar"], missingInstruments: ["bass"] }),
    );
    expect(html.toLowerCase()).toContain("needs bass");
    expect(html).toContain("border-dashed");
  });

  it("says nothing about a need when the song is open or ready", () => {
    expect(render(song({ joinMode: "open" })).toLowerCase()).not.toContain("needs");
    expect(render(song({ joinMode: "closed" })).toLowerCase()).not.toContain("needs");
  });

  it("uses tokens for colour, never a literal, and no gradient", () => {
    const html = render(song());
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/rgb\(|hsl\(|oklch\(/);
    expect(html).not.toContain("gradient");
  });
});

describe("JamLinkCard", () => {
  it("draws nothing for an unavailable song, so the row keeps the plain link", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <JamLinkCard link={LINK} state={{ status: "unavailable" }} />
      </I18nProvider>,
    );
    expect(html).toBe("");
  });

  it("draws a quiet placeholder of the same height while it loads, with no words in it", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <JamLinkCard link={LINK} state={{ status: "loading" }} />
      </I18nProvider>,
    );
    expect(html).toContain("data-jam-link-card-skeleton");
    expect(html).not.toContain("In Bloom");
  });
});
