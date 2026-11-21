import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { song } from "@/lib/jam-test-fixtures";
import { JamLinkCardView } from "./jam-link-card";
import { JamTile } from "./jam-tile";
import { UserText } from "./user-text";

/**
 * Rows written before the server stripped bidi controls (`cleanLine` in
 * `@pqp/shared`) may still hold a right-to-left override in an artist, a name or a
 * label, and a name always comes from an account. An unclosed U+202E reversed the
 * app's own copy around it on the wall, the song page and the chat card ("started
 * by you" drawn as "uoy yb detrats", the author shown reversed). Static markup is
 * enough to pin what each screen puts around the text: the controls are gone, and
 * the text sits in an isolate (`<bdi>` in the DOM, first-strong isolate characters
 * in a string).
 */

const RLO = "‮";
const FSI = "⁨";
const PDI = "⁩";

const EVIL = song({ artist: `${RLO}atsitra`, authorName: `${RLO}fAfar` });

function card(value: ReturnType<typeof song>): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <JamLinkCardView song={value} href="/x" onOpen={() => undefined} />
    </I18nProvider>,
  );
}

function tile(value: ReturnType<typeof song>): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <ul>
        <JamTile song={value} size="card" index={0} onOpen={() => undefined} onPlay={() => undefined} />
      </ul>
    </I18nProvider>,
  );
}

describe("a person's text inside the app's own sentence", () => {
  it("UserText is an isolate with the explicit controls dropped", () => {
    expect(renderToStaticMarkup(<UserText>{`${RLO}Gabi`}</UserText>)).toBe("<bdi>Gabi</bdi>");
    expect(renderToStaticMarkup(<UserText>{"مرحبا"}</UserText>)).toBe("<bdi>مرحبا</bdi>");
  });

  it("the chat link card isolates the artist and the people, and never draws the override", () => {
    const html = card(EVIL);
    expect(html).not.toContain(RLO);
    expect(html).toContain("<bdi>atsitra</bdi>");
    // the line beside the artist is the people, isolated one by one
    expect(html).toContain(`${FSI}fAfar${PDI}`);
  });

  it("the wall tile's credit line isolates the artist and the people", () => {
    const html = tile(EVIL);
    expect(html).not.toContain(RLO);
    expect(html).toContain(`${FSI}atsitra${PDI} · ${FSI}fAfar${PDI}`);
  });

  it("the accessible name of a card stays plain text, in reading order", () => {
    const html = card(EVIL);
    const label = /aria-label="([^"]*)"/.exec(html)![1]!;
    expect(label).toBe(`In Bloom, ${RLO}atsitra, ${RLO}fAfar`.replaceAll(RLO, ""));
    expect(label).not.toContain(FSI);
  });

  it("leaves honest right-to-left text alone", () => {
    const html = card(song({ artist: "فيروز", authorName: "אבי" }));
    expect(html).toContain("<bdi>فيروز</bdi>");
    expect(html).toContain(`${FSI}אבי${PDI}`);
  });
});
