import { describe, expect, it } from "vitest";
import { translateMessage } from "@/lib/i18n/instance";
import {
  cinemaOrientation,
  presenceAvatars,
  shouldShowCinema,
} from "./cinema-layout";

describe("shouldShowCinema", () => {
  it("shows cinema only for a live stream's audience", () => {
    expect(shouldShowCinema({ live: true, audience: true })).toBe(true);
  });

  it("stays off the ordinary stage for a joined participant", () => {
    expect(shouldShowCinema({ live: true, audience: false })).toBe(false);
  });

  it("stays off when nothing is live, even for an audience viewer", () => {
    expect(shouldShowCinema({ live: false, audience: true })).toBe(false);
  });

  it("stays off with neither condition", () => {
    expect(shouldShowCinema({ live: false, audience: false })).toBe(false);
  });
});

describe("cinemaOrientation", () => {
  it("is desktop at or above the lg breakpoint", () => {
    expect(cinemaOrientation(true)).toBe("desktop");
  });

  it("is phone below the lg breakpoint", () => {
    expect(cinemaOrientation(false)).toBe("phone");
  });
});

describe("presenceAvatars", () => {
  it("caps the strip at 8 by default", () => {
    const people = Array.from({ length: 20 }, (_, i) => i);
    expect(presenceAvatars(people)).toHaveLength(8);
  });

  it("keeps every entry under the cap", () => {
    expect(presenceAvatars([1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe("voice.cinema.watching presence line", () => {
  it("pluralizes zero as the group form", () => {
    expect(translateMessage("voice.cinema.watching", { count: 0 })).toBe(
      "0 people watching",
    );
  });

  it("singularizes exactly one", () => {
    expect(translateMessage("voice.cinema.watching", { count: 1 })).toBe(
      "1 person watching",
    );
  });

  it("pluralizes a large audience", () => {
    expect(translateMessage("voice.cinema.watching", { count: 512 })).toBe(
      "512 people watching",
    );
  });
});
