import { describe, expect, it } from "vitest";
import {
  displayFields,
  readShowOriginal,
  writeShowOriginal,
} from "./translation-view";

const translated = {
  title: "Session 11",
  body: "the basement map",
  teaser: null,
  translation: {
    original: { title: "Sessão 11", body: "o mapa do porão", teaser: null },
  },
};

describe("displayFields", () => {
  it("shows the translated fields, or the author's own when flipped", () => {
    expect(displayFields(translated, false)).toEqual({
      title: "Session 11",
      body: "the basement map",
      teaser: null,
    });
    expect(displayFields(translated, true)).toEqual({
      title: "Sessão 11",
      body: "o mapa do porão",
      teaser: null,
    });
  });

  it("a post with no translation is itself, whatever was remembered", () => {
    const plain = { title: "a", body: "b", teaser: null, translation: null };
    expect(displayFields(plain, true)).toEqual({ title: "a", body: "b", teaser: null });
  });

  it("a locked post's original body stays null", () => {
    const locked = {
      title: "t",
      body: null,
      teaser: "x",
      translation: { original: { title: "o", body: null, teaser: "y" } },
    };
    expect(displayFields(locked, true).body).toBeNull();
    expect(displayFields(locked, false).body).toBeNull();
  });
});

describe("the per-session choice", () => {
  it("is remembered per post and can be undone, with storage unavailable", () => {
    // The node test environment has no sessionStorage: the in-memory fallback answers.
    expect(readShowOriginal("p1")).toBe(false);
    writeShowOriginal("p1", true);
    expect(readShowOriginal("p1")).toBe(true);
    expect(readShowOriginal("p2")).toBe(false);
    writeShowOriginal("p1", false);
    expect(readShowOriginal("p1")).toBe(false);
  });
});
