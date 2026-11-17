import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { jamPublicErrorKind, publicJamListPath } from "./jam-public-api";
import { jamSiteHomeUrl, parsePublicJamPath, publicJamAppPath, publicJamShareUrl } from "./jam-public-links";
import { openPublicJam, openPublicJamById, peekPublicJamRequest, publicJamRequestPath, takePublicJamIntent } from "./jam-public-nav";
import { isPublicJamKey, publicJamKey } from "./jam-store";

const ID = "0b8f1c52-3e0a-4a55-9c1e-6a1f0c2d9e77";

describe("public jam addresses", () => {
  it("parses /app/jam/<id> and /app/jam/new, and nothing else", () => {
    expect(parsePublicJamPath(`/app/jam/${ID}`)).toEqual({ kind: "song", songId: ID });
    expect(parsePublicJamPath(`/app/jam/${ID.toUpperCase()}/`)).toEqual({ kind: "song", songId: ID });
    expect(parsePublicJamPath("/app/jam/new")).toEqual({ kind: "new" });
    expect(parsePublicJamPath("/app/jam/nope")).toBeNull();
    expect(parsePublicJamPath(`/app/server/${ID}`)).toBeNull();
    expect(parsePublicJamPath("/app")).toBeNull();
    expect(publicJamAppPath(ID)).toBe(`/app/jam/${ID}`);
  });

  it("shares jam.pqp.gg on the hosted instance and /jam anywhere else", () => {
    const hosted = { protocol: "https:", hostname: "pqp.gg", host: "pqp.gg" };
    const local = { protocol: "http:", hostname: "localhost", host: "localhost:5173" };
    expect(publicJamShareUrl(ID, hosted)).toBe(`https://jam.pqp.gg/m/${ID}`);
    expect(jamSiteHomeUrl(hosted)).toBe("https://jam.pqp.gg/");
    expect(publicJamShareUrl(ID, local)).toBe(`http://localhost:5173/jam/m/${ID}`);
    expect(jamSiteHomeUrl(local)).toBe("http://localhost:5173/jam");
  });
});

describe("public jam requests", () => {
  it("carries the intent to the view once, and then drops it", () => {
    openPublicJam({ kind: "song", songId: ID, record: true, instrument: "bass" });
    expect(publicJamRequestPath(peekPublicJamRequest()!)).toBe(`/app/jam/${ID}`);
    expect(takePublicJamIntent("somebody-else")).toBeNull();
    expect(takePublicJamIntent(ID)).toEqual({ kind: "song", songId: ID, record: true, instrument: "bass" });
    expect(takePublicJamIntent(ID)).toBeNull();
  });

  it("opens a new jam, and a plain card opens a song with no intent to act on", () => {
    openPublicJam({ kind: "new" });
    expect(publicJamRequestPath(peekPublicJamRequest()!)).toBe("/app/jam/new");
    const before = peekPublicJamRequest()!.nonce;
    openPublicJamById(ID);
    expect(peekPublicJamRequest()!.nonce).toBeGreaterThan(before);
    expect(takePublicJamIntent(ID)).toEqual({ kind: "song", songId: ID, record: false, instrument: null });
  });
});

describe("public jam api", () => {
  it("builds the list query", () => {
    expect(publicJamListPath()).toBe("/api/public/jams");
    expect(publicJamListPath({ sort: "top", limit: 8, needs: "bass" })).toBe("/api/public/jams?sort=top&needs=bass&limit=8");
  });

  it("says what a failure means", () => {
    expect(jamPublicErrorKind(new ApiError(403, "jam_public_off"))).toBe("off");
    expect(jamPublicErrorKind(new ApiError(403, "jam_public_blocked"))).toBe("blocked");
    expect(jamPublicErrorKind(new ApiError(409, "jam_public_removed"))).toBe("removed");
    expect(jamPublicErrorKind(new ApiError(429, "jam_public_rate_limited"))).toBe("rateLimited");
    expect(jamPublicErrorKind(new ApiError(404, "Not found"))).toBe("gone");
    expect(jamPublicErrorKind(new ApiError(0, "net"))).toBe("network");
    expect(jamPublicErrorKind(new ApiError(500, "boom"))).toBe("other");
  });
});

describe("the key a public jam is held under", () => {
  it("is never a channel id", () => {
    expect(isPublicJamKey(publicJamKey(ID))).toBe(true);
    expect(isPublicJamKey(ID)).toBe(false);
  });
});
