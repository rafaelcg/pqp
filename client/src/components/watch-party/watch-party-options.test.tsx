import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WATCH_PARTY_DEFAULT_OPTIONS, type WatchPartyOptions } from "@pqp/shared";
import { WatchPartyOptionsPanel } from "./watch-party-options";

/**
 * THE VOZ ROW'S ONE-LINE SUMMARY (2026-09-13, Rafael's "the audience never
 * joins a call" decision, item 4). Off says the party is a broadcast; on
 * says it is a stage. Kept on distinct keys from the older
 * `watchParty.options.voiceOffBody` — see the comment beside `voiceNote` in
 * `watch-party-options.tsx` for why.
 */
describe("the Voz row's summary", () => {
  const render = (options: WatchPartyOptions) =>
    renderToStaticMarkup(
      <WatchPartyOptionsPanel
        options={options}
        audienceCount={0}
        onChange={() => {}}
      />,
    );

  it("reads as a broadcast while voice is off", () => {
    const html = render(WATCH_PARTY_DEFAULT_OPTIONS);
    expect(html).toContain("Off: everyone just watches");
  });

  it("reads as a stage once voice is on", () => {
    const html = render({
      ...WATCH_PARTY_DEFAULT_OPTIONS,
      voiceEnabled: true,
      stageMode: "hosts_only",
    });
    expect(html).toContain("Stage with voice: guests can speak");
    expect(html).not.toContain("Off: everyone just watches");
  });

  it("still gives way to the busy-room warning for an open floor", () => {
    const html = render({
      ...WATCH_PARTY_DEFAULT_OPTIONS,
      voiceEnabled: true,
      stageMode: "everyone",
    });
    const busy = renderToStaticMarkup(
      <WatchPartyOptionsPanel
        options={{
          ...WATCH_PARTY_DEFAULT_OPTIONS,
          voiceEnabled: true,
          stageMode: "everyone",
        }}
        audienceCount={30}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Stage with voice: guests can speak");
    expect(busy).not.toContain("Stage with voice: guests can speak");
    expect(busy).toContain("gets out of hand fast");
  });
});
