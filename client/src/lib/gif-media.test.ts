import { describe, expect, it } from "vitest";
import { gifMessageMedia } from "./gif-media";

const GIPHY = "https://media3.giphy.com/media/abc123/giphy.gif";
const TENOR = "https://media.tenor.com/x8v1o/excited-happy-dance-gif-9912.gif";
const KLIPY = "https://static.klipy.com/ii/abc123/14/af/um0L4dFH.gif";

describe("gifMessageMedia", () => {
  it("reads a body that is nothing but an allowlisted URL as media", () => {
    expect(gifMessageMedia(GIPHY)).toEqual({
      url: GIPHY,
      stillUrl: "https://media3.giphy.com/media/abc123/giphy_s.gif",
      alt: "GIF",
    });
  });

  it("ignores surrounding whitespace, which a paste always leaves", () => {
    expect(gifMessageMedia(`  ${GIPHY}\n`)?.url).toBe(GIPHY);
  });

  it("leaves a sentence containing a link as text", () => {
    // The author wrote prose around it; rendering only the image would drop
    // everything they actually said.
    expect(gifMessageMedia(`look at this ${GIPHY}`)).toBeNull();
    expect(gifMessageMedia(`${GIPHY} lol`)).toBeNull();
  });

  it("leaves a non-allowlisted host as text", () => {
    expect(gifMessageMedia("https://evil.example/tracker.gif")).toBeNull();
  });

  it("leaves an empty body alone", () => {
    expect(gifMessageMedia("   ")).toBeNull();
  });

  it("reports no still for a host that publishes none", () => {
    expect(gifMessageMedia(TENOR)?.stillUrl).toBeNull();
    expect(gifMessageMedia(KLIPY)?.stillUrl).toBeNull();
  });

  it("reads a Klipy picker result as media", () => {
    expect(gifMessageMedia(KLIPY)).toEqual({
      url: KLIPY,
      stillUrl: null,
      // Klipy filenames are random ids, so nothing readable can come of them.
      alt: "GIF",
    });
  });
});

describe("gifMessageMedia alt text", () => {
  it("reads words out of a slug, dropping the id and the trailing 'gif'", () => {
    expect(gifMessageMedia(TENOR)?.alt).toBe("excited happy dance GIF");
  });

  it("falls back to 'GIF' for a filename every GIF on the host shares", () => {
    expect(gifMessageMedia(GIPHY)?.alt).toBe("GIF");
  });

  it("falls back to 'GIF' rather than announcing a hash", () => {
    // A screen reader saying "aHR0cHM6 GIF" is worse than saying nothing.
    expect(
      gifMessageMedia("https://media.tenor.com/x/8f21a4c9b7e30d15.gif")?.alt,
    ).toBe("GIF");
  });

  it("never returns an empty name", () => {
    expect(gifMessageMedia("https://i.giphy.com/-_-.gif")?.alt).toBe("GIF");
  });
});
