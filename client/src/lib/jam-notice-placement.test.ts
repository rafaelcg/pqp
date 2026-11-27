import type { JamTakeNotice } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import { jamNoticePlacement, jamNoticeQueue } from "./jam-notice-placement";

const notice = (id: string, kind: JamTakeNotice["kind"] = "accepted"): JamTakeNotice => ({
  id,
  kind,
  songId: `song-${id}`,
  title: `Song ${id}`,
  instruments: ["guitar"],
  count: 1,
  createdAt: "2026-11-26T10:00:00.000Z",
  updatedAt: "2026-11-26T10:00:00.000Z",
});

describe("where a Jam notice may be drawn (round 3, N-1)", () => {
  it("is never drawn over the studio, whatever else is open", () => {
    expect(jamNoticePlacement({ studio: true, song: false, view: false })).toBe("hold");
    expect(jamNoticePlacement({ studio: true, song: true, view: true })).toBe("hold");
  });

  it("is drawn in the flow of a public view and never over its transport", () => {
    expect(jamNoticePlacement({ studio: false, song: true, view: true })).toBe("inline");
  });

  it("waits over a channel's own song panel, which has no slot for it", () => {
    expect(jamNoticePlacement({ studio: false, song: true, view: false })).toBe("hold");
  });

  it("is an overlay only where there is no song and no studio", () => {
    expect(jamNoticePlacement({ studio: false, song: false, view: false })).toBe("overlay");
  });
});

describe("which notice is drawn", () => {
  const three = [notice("a"), notice("b"), notice("c")];

  it("draws one card, the newest, and counts the rest", () => {
    expect(jamNoticeQueue(three, false, "overlay")).toEqual({ toast: false, card: three[0], more: 2 });
    expect(jamNoticeQueue([three[0]!], false, "overlay").more).toBe(0);
  });

  it("holds the cards back while the toast is up", () => {
    expect(jamNoticeQueue(three, true, "overlay")).toEqual({ toast: true, card: null, more: 0 });
  });

  it("draws nothing while on hold, and keeps the toast for later", () => {
    expect(jamNoticeQueue(three, true, "hold")).toEqual({ toast: false, card: null, more: 0 });
  });

  it("puts the card, not the toast, inside a view", () => {
    expect(jamNoticeQueue(three, true, "inline")).toEqual({ toast: false, card: three[0], more: 2 });
  });

  it("is empty with nothing waiting", () => {
    expect(jamNoticeQueue([], false, "overlay")).toEqual({ toast: false, card: null, more: 0 });
  });
});
