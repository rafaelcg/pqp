import { describe, expect, it } from "vitest";
import {
  openPublicJam,
  openPublicJamById,
  peekPublicJamRequest,
  takePublicJamPlay,
} from "./jam-public-nav";

const SONG = "3f1c2a54-7b0e-4d0a-9a53-0c2f6f1d9e11";

describe("asking a public jam to play", () => {
  it("a plain open waits: a shelf card or a link never starts the music", () => {
    openPublicJamById(SONG);
    expect(peekPublicJamRequest()?.play).toBe(false);
    expect(takePublicJamPlay(SONG)).toBe(false);
  });

  it("asked to play, it plays once, for that song only", () => {
    openPublicJamById(SONG, { play: true });
    expect(takePublicJamPlay("another-song")).toBe(false);
    expect(takePublicJamPlay(SONG)).toBe(true);
    expect(takePublicJamPlay(SONG)).toBe(false);
  });

  it("a new request replaces the old one's wish", () => {
    openPublicJamById(SONG, { play: true });
    openPublicJamById(SONG);
    expect(takePublicJamPlay(SONG)).toBe(false);
  });

  it("starting a jam has nothing to play", () => {
    openPublicJam({ kind: "new" }, { play: true });
    expect(peekPublicJamRequest()?.play).toBe(false);
    expect(takePublicJamPlay("new")).toBe(false);
  });
});
