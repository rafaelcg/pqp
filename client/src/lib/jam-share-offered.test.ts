import { describe, expect, it } from "vitest";
import { jamShareOffered } from "./jam-share-link";

/** Only a song a stranger can open gets a public share; a private channel song keeps today's behaviour (none). */
describe("jamShareOffered", () => {
  const base = {
    publicEnabled: true,
    publicAccess: false,
    existingSong: true,
    isStarter: false,
    createdStatus: null as string | null,
    publicationStatus: undefined as string | null | undefined,
  };

  it("never with jam_public off", () => {
    expect(jamShareOffered({ ...base, publicEnabled: false, publicAccess: true, existingSong: false, createdStatus: "live" })).toBe(false);
  });

  it("a private channel song gets nothing", () => {
    expect(jamShareOffered({ ...base, publicationStatus: null })).toBe(false);
    expect(jamShareOffered({ ...base, publicationStatus: undefined })).toBe(false);
    expect(jamShareOffered({ ...base, publicationStatus: "unpublished" })).toBe(false);
    // a song being made in a channel is private until its starter publishes it
    expect(jamShareOffered({ ...base, existingSong: false })).toBe(false);
  });

  it("a channel song that is live gets it; one in review or hidden does not", () => {
    expect(jamShareOffered({ ...base, publicationStatus: "live" })).toBe(true);
    expect(jamShareOffered({ ...base, publicationStatus: "review" })).toBe(false);
    expect(jamShareOffered({ ...base, publicationStatus: "hidden" })).toBe(false);
  });

  it("a jam just created in the public flow, only when the server says live", () => {
    const created = { ...base, publicAccess: true, existingSong: false };
    expect(jamShareOffered({ ...created, createdStatus: "live" })).toBe(true);
    expect(jamShareOffered({ ...created, createdStatus: "review" })).toBe(false);
    expect(jamShareOffered({ ...created, createdStatus: null })).toBe(false);
  });

  it("an outside take on somebody else's public jam, and the starter's own live one", () => {
    expect(jamShareOffered({ ...base, publicAccess: true })).toBe(true);
    expect(jamShareOffered({ ...base, publicAccess: true, isStarter: true, publicationStatus: "live" })).toBe(true);
    expect(jamShareOffered({ ...base, publicAccess: true, isStarter: true, publicationStatus: "review" })).toBe(false);
  });
});
