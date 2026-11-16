import { JAM_ARTIST_MAX, JAM_TITLE_MAX } from "@pqp/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkCoverPicture, cleanSongTitle, isCoverPicture, JAM_COVER_MIN_SIDE, planJamEdit } from "./jam-cover";

const SONG = { title: "In Bloom", artist: "Nirvana" as string | null, coverUrl: null as string | null };
const KEEP = { kind: "keep" } as const;

describe("which files a cover takes", () => {
  it("takes the three picture types the server takes, and nothing else", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp"]) {
      expect(isCoverPicture({ type }), type).toBe(true);
    }
    for (const type of ["image/gif", "image/svg+xml", "image/heic", "video/mp4", "application/pdf", "text/plain"]) {
      expect(isCoverPicture({ type }), type).toBe(false);
    }
  });

  it("reads the extension when a drop carries no type", () => {
    expect(isCoverPicture({ type: "", name: "capa.JPG" })).toBe(true);
    expect(isCoverPicture({ type: "", name: "capa.webp" })).toBe(true);
    expect(isCoverPicture({ type: "", name: "capa.exe" })).toBe(false);
    expect(isCoverPicture({ type: "", name: "capa" })).toBe(false);
    // A type that is known and wrong is not rescued by a name.
    expect(isCoverPicture({ type: "text/plain", name: "capa.png" })).toBe(false);
  });
});

describe("the title the sheet sends", () => {
  it("is one line, trimmed, and never empty or over the limit", () => {
    expect(cleanSongTitle("  In   Bloom \n")).toBe("In Bloom");
    expect(cleanSongTitle("   ")).toBeNull();
    expect(cleanSongTitle("x".repeat(JAM_TITLE_MAX))).toHaveLength(JAM_TITLE_MAX);
    expect(cleanSongTitle("x".repeat(JAM_TITLE_MAX + 1))).toBeNull();
  });
});

describe("what saving the sheet writes", () => {
  it("is nothing when nothing changed, however the words were spaced", () => {
    expect(planJamEdit(SONG, { title: "In Bloom", artist: "Nirvana", cover: KEEP })).toEqual({
      patch: null,
      cover: null,
      empty: true,
    });
    expect(planJamEdit(SONG, { title: "  In  Bloom ", artist: " Nirvana", cover: KEEP }).empty).toBe(true);
  });

  it("sends only the field that changed", () => {
    expect(planJamEdit(SONG, { title: "Come as You Are", artist: "Nirvana", cover: KEEP }).patch).toEqual({
      title: "Come as You Are",
    });
    expect(planJamEdit(SONG, { title: "In Bloom", artist: "Os Cometas", cover: KEEP }).patch).toEqual({
      artist: "Os Cometas",
    });
  });

  it("clears the artist with null: the song is the person's own", () => {
    expect(planJamEdit(SONG, { title: "In Bloom", artist: "   ", cover: KEEP }).patch).toEqual({ artist: null });
    // An original that stays one is not a write.
    expect(planJamEdit({ ...SONG, artist: null }, { title: "In Bloom", artist: "", cover: KEEP }).empty).toBe(true);
  });

  it("never sends an empty title: the song keeps its name", () => {
    expect(planJamEdit(SONG, { title: "   ", artist: "Nirvana", cover: KEEP })).toMatchObject({ patch: null, empty: true });
    expect(planJamEdit(SONG, { title: "", artist: "Outra", cover: KEEP }).patch).toEqual({ artist: "Outra" });
  });

  it("cuts an artist at the contract's limit instead of sending one the server refuses", () => {
    const long = "a".repeat(JAM_ARTIST_MAX + 20);
    const plan = planJamEdit(SONG, { title: "In Bloom", artist: long, cover: KEEP });
    expect(plan.patch?.artist).toHaveLength(JAM_ARTIST_MAX);
  });

  it("claims a picked photo, and takes the photo off only a song that has one", () => {
    const withCover = { ...SONG, coverUrl: "https://bucket.test/jam/a.jpg?X-Amz-Signature=1" };
    const upload = "11111111-1111-4111-8111-111111111111";
    expect(planJamEdit(SONG, { title: "In Bloom", artist: "Nirvana", cover: { kind: "new", uploadId: upload } })).toEqual({
      patch: null,
      cover: { op: "set", uploadId: upload },
      empty: false,
    });
    expect(planJamEdit(withCover, { title: "In Bloom", artist: "Nirvana", cover: { kind: "remove" } }).cover).toEqual({
      op: "remove",
    });
    // Removing what is not there is not a write.
    expect(planJamEdit(SONG, { title: "In Bloom", artist: "Nirvana", cover: { kind: "remove" } }).empty).toBe(true);
    // Text and picture together: both, the text first in the sheet's order.
    const both = planJamEdit(withCover, { title: "Outro", artist: "Nirvana", cover: { kind: "new", uploadId: upload } });
    expect(both.patch).toEqual({ title: "Outro" });
    expect(both.cover).toEqual({ op: "set", uploadId: upload });
  });
});

describe("looking inside a picked photo before the crop step opens", () => {
  /** An `<img>` that says what it decoded to (or that it could not), the way a browser would. */
  function fakeImage(outcome: { width: number; height: number } | "error") {
    return class {
      naturalWidth = 0;
      naturalHeight = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => {
          if (outcome === "error") {
            this.onerror?.();
          } else {
            this.naturalWidth = outcome.width;
            this.naturalHeight = outcome.height;
            this.onload?.();
          }
        });
      }
    };
  }
  const revoke = vi.fn();
  function stub(outcome: { width: number; height: number } | "error") {
    vi.stubGlobal("Image", fakeImage(outcome));
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: revoke });
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    revoke.mockClear();
  });

  it("takes a picture big enough, and lets go of its temporary address", async () => {
    stub({ width: 1600, height: 1200 });
    await expect(checkCoverPicture(new Blob(["x"]))).resolves.toEqual({ ok: true, width: 1600, height: 1200 });
    expect(revoke).toHaveBeenCalledWith("blob:x");
  });

  it("refuses one that is too small, saying how small it is (a 40 px square is a blur on a big card)", async () => {
    stub({ width: 40, height: 40 });
    await expect(checkCoverPicture(new Blob(["x"]))).resolves.toEqual({ ok: false, reason: "small", width: 40, height: 40 });
    // judged on the SHORTER side: a wide strip with a thin edge is still too small
    stub({ width: 3000, height: JAM_COVER_MIN_SIDE - 1 });
    expect(await checkCoverPicture(new Blob(["x"]))).toMatchObject({ ok: false, reason: "small" });
    stub({ width: JAM_COVER_MIN_SIDE, height: JAM_COVER_MIN_SIDE });
    expect(await checkCoverPicture(new Blob(["x"]))).toMatchObject({ ok: true });
  });

  it("refuses a file that is not a picture at all (text renamed .jpg), before anybody frames it", async () => {
    stub("error");
    await expect(checkCoverPicture(new Blob(["just text"], { type: "image/jpeg" }))).resolves.toMatchObject({
      ok: false,
      reason: "unreadable",
    });
    expect(revoke).toHaveBeenCalledWith("blob:x");
  });
});
