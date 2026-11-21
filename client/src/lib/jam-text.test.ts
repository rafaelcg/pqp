import { JAM_TITLE_MAX, jamTitleSchema } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { jamErrorKind } from "./jam-api";
import { cleanSongArtist, cleanSongTitle, planJamEdit } from "./jam-cover";
import { jamArtistCheck, jamTitleCheck } from "./jam-text";

/**
 * The client asks the SAME rule the server applies before it enables Save or
 * enters the studio. A title of nothing but zero-width characters used to pass
 * every client check, let a person record a whole take, and fail at the server
 * with "That did not work".
 */

const INVISIBLE_TITLES = ["​", "⁠", "​​ ‍", "⠀", "ㅤ", " ​ ⁠ "];

describe("a title the client checks before it asks", () => {
  it.each(INVISIBLE_TITLES)("refuses %j as invisible, as the server does", (value) => {
    expect(jamTitleSchema.safeParse(value).success).toBe(false);
    expect(jamTitleCheck(value)).toEqual({ ok: false, problem: "invisible" });
  });

  it("tells empty from invisible", () => {
    expect(jamTitleCheck("")).toEqual({ ok: false, problem: "empty" });
    expect(jamTitleCheck("   \n ")).toEqual({ ok: false, problem: "empty" });
    expect(jamTitleCheck("​")).toEqual({ ok: false, problem: "invisible" });
  });

  it("accepts what the server accepts and hands over what it stores", () => {
    expect(jamTitleCheck("  In   Bloom ")).toEqual({ ok: true, title: "In Bloom" });
    // The bidi override is stripped, not refused.
    expect(jamTitleCheck("Hello ‮FEDCBA")).toEqual({ ok: true, title: "Hello FEDCBA" });
    // Right-to-left text, a ZWJ emoji family and a flag all carry something to read.
    for (const real of ["مرحبا", "שלום עולם", "\u{1F468}‍\u{1F469}‍\u{1F467}", "\u{1F1E7}\u{1F1F7}", "Nguyễn Văn"]) {
      expect(jamTitleCheck(real).ok, real).toBe(true);
      expect(jamTitleSchema.safeParse(real).success, real).toBe(true);
    }
  });

  it("agrees with the shared schema on every case above, and on the limit", () => {
    for (const value of [...INVISIBLE_TITLES, "", "ok", "x".repeat(JAM_TITLE_MAX), "x".repeat(JAM_TITLE_MAX + 1)]) {
      expect(jamTitleCheck(value).ok, JSON.stringify(value)).toBe(jamTitleSchema.safeParse(value).success);
    }
    expect(jamTitleCheck("x".repeat(JAM_TITLE_MAX + 1))).toEqual({ ok: false, problem: "long" });
  });
});

describe("an artist the client checks before it asks", () => {
  it("is none for an empty one, refused when it draws nothing, kept otherwise", () => {
    expect(jamArtistCheck("")).toEqual({ ok: true, artist: null });
    expect(jamArtistCheck("​")).toEqual({ ok: false, problem: "invisible" });
    expect(jamArtistCheck("Os Cometas")).toEqual({ ok: true, artist: "Os Cometas" });
    expect(cleanSongArtist("​")).toBeUndefined();
    expect(cleanSongArtist("  ")).toBeNull();
    expect(cleanSongArtist("‮Gabi")).toBe("Gabi");
  });
});

describe("the rename sheet's plan", () => {
  const SONG = { title: "Samba", artist: null, coverUrl: null };
  const KEEP = { kind: "keep" } as const;

  it("is nothing to save for an invisible title, so Save stays off", () => {
    expect(cleanSongTitle("​")).toBeNull();
    expect(planJamEdit(SONG, { title: "​", artist: "", cover: KEEP })).toMatchObject({ patch: null, empty: true });
  });

  it("never sends an artist the server refuses", () => {
    expect(planJamEdit(SONG, { title: "Samba", artist: "⁠", cover: KEEP })).toMatchObject({ patch: null, empty: true });
  });

  it("does not treat opening a legacy row as an edit", () => {
    const legacy = { title: "Samba ‮OLEH", artist: "‮Gabi", coverUrl: null };
    expect(planJamEdit(legacy, { title: legacy.title, artist: legacy.artist, cover: KEEP }).empty).toBe(true);
    expect(planJamEdit(legacy, { title: "Samba Novo", artist: legacy.artist, cover: KEEP }).patch).toEqual({ title: "Samba Novo" });
  });
});

describe("the server's refusal of text", () => {
  it("is said as such, so an old draft cannot loop on 'try again'", () => {
    expect(jamErrorKind(new ApiError(400, "Invalid request"))).toBe("invalid");
    expect(jamErrorKind(new ApiError(404, "Not found"))).toBe("gone");
    expect(jamErrorKind(new ApiError(500, "boom"))).toBe("other");
  });
});
