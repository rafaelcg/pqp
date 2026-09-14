import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WATCH_PARTY_DEFAULT_OPTIONS, type WatchPartyOptions } from "@pqp/shared";
import { WatchPartyOptionsPanel } from "./watch-party-options";

/**
 * CONVIDADOS REPLACED "VOZ" (`docs/plans/WATCH_PARTY_GUESTS.md` §2). The old
 * Voz select and its one-line summary are gone from this panel; the radio
 * group in `guests/watch-party-guests-setting.tsx` is mounted in their place,
 * and this suite now pins the panel's own responsibilities: which of the
 * three options is checked, and that the busy-room slow-mode nudge (a
 * DIFFERENT row, unrelated to guests) still appears.
 */
describe("the Convidados row", () => {
  const render = (options: WatchPartyOptions, audienceCount = 0) =>
    renderToStaticMarkup(
      <WatchPartyOptionsPanel
        options={options}
        audienceCount={audienceCount}
        onChange={() => {}}
      />,
    );

  it("checks Off by default", () => {
    const html = render(WATCH_PARTY_DEFAULT_OPTIONS);
    expect(html).toContain('data-watch-party-guests-option="off"');
    const offIndex = html.indexOf('data-watch-party-guests-option="off"');
    const offInput = html.slice(offIndex, html.indexOf("<input", offIndex) + 200);
    expect(offInput).toContain("checked=\"\"");
  });

  it("checks Request when guests is request", () => {
    const html = render({ ...WATCH_PARTY_DEFAULT_OPTIONS, guests: "request" });
    const requestIndex = html.indexOf(
      'data-watch-party-guests-option="request"',
    );
    const requestInput = html.slice(
      requestIndex,
      html.indexOf("<input", requestIndex) + 200,
    );
    expect(requestInput).toContain("checked=\"\"");
  });

  it("renders all three radios, every time", () => {
    const html = render(WATCH_PARTY_DEFAULT_OPTIONS);
    expect(html).toContain('data-watch-party-guests-option="off"');
    expect(html).toContain('data-watch-party-guests-option="invite"');
    expect(html).toContain('data-watch-party-guests-option="request"');
  });
});

describe("the slow-mode nudge, unrelated to guests", () => {
  it("still shows up for a busy room whatever guests is set to", () => {
    const html = renderToStaticMarkup(
      <WatchPartyOptionsPanel
        options={{ ...WATCH_PARTY_DEFAULT_OPTIONS, guests: "off" }}
        audienceCount={30}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("already holds the flood back");
  });
});
