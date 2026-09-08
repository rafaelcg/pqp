import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { SCREEN_SHARE_LIMIT } from "@pqp/shared";
import { setActiveCatalogue } from "@/lib/i18n";
import { CapacityNotice } from "./capacity-notice";

const REAL_SCREENS = SCREEN_SHARE_LIMIT.livekit;

/** `as const` makes the entry readonly to the checker, never at runtime. */
function setScreens(limit: number | null): void {
  (SCREEN_SHARE_LIMIT as Record<string, number | null>).livekit = limit;
}

afterEach(() => {
  setScreens(REAL_SCREENS);
  setActiveCatalogue(undefined);
});

const ROOM = "33333333-3333-4333-8333-333333333333";

/**
 * `seen` is passed explicitly because the one hint store reads `localStorage`,
 * which does not exist under Node and therefore reads as "already seen". The
 * store's own once-per-room behaviour is proven against a fake storage in
 * `lib/voice-capacity.test.ts`; this file is about what gets rendered.
 */
function render(props: Partial<Parameters<typeof CapacityNotice>[0]> = {}) {
  return renderToStaticMarkup(
    <CapacityNotice
      voiceChannelId={ROOM}
      transport="livekit"
      roseFrom="mesh"
      seen={false}
      {...props}
    />,
  );
}

describe("CapacityNotice", () => {
  it("says the room grew, and promises both when there is no count", () => {
    // The voice server has no share count and no camera count, so the card
    // renders the words rather than a number, and above all never "null".
    const markup = render();
    expect(markup).toContain("This call grew");
    expect(markup).toContain("screen and camera for everyone");
    expect(markup).not.toContain("null");
    expect(markup).toContain('data-corner-card="voice-capacity"');
  });

  it("takes its numbers from the map rather than from the copy", () => {
    setScreens(9);
    expect(render()).toContain("up to 9 screens");
  });

  it("stays out of the way of somebody who joined after the change", () => {
    // `roseFrom` is null for a seat minted by `welcome`: nothing changed for
    // them, so there is nothing to announce.
    expect(render({ roseFrom: null })).toBe("");
  });

  it("stays quiet when the room's transport never changed", () => {
    expect(render({ roseFrom: "livekit" })).toBe("");
  });

  it("does not come back for a room that already showed it", () => {
    expect(render({ seen: true })).toBe("");
  });

  it("does not spend its impression under hidden call chrome", () => {
    expect(render({ visible: false })).toBe("");
  });
});
