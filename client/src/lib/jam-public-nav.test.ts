import { describe, expect, it } from "vitest";
import {
  listenToPublicJam,
  openMyJams,
  openPublicJam,
  openPublicJamById,
  peekPublicJamRequest,
  publicJamRequestPath,
  recordOnPublicJam,
  startPublicJam,
  takePublicJamIntent,
} from "./jam-public-nav";

const SONG = "3f1c2a54-7b0e-4d0a-9a53-0c2f6f1d9e11";

describe("the three things a door offers", () => {
  it("listening opens the song and asks for nothing else: no record, no music", () => {
    listenToPublicJam(SONG);
    const request = peekPublicJamRequest();
    expect(request).not.toHaveProperty("play");
    expect(request?.target).toBe(SONG);
    expect(request?.intent).toEqual({ kind: "song", songId: SONG, record: false, instrument: null });
  });

  it("a plain open by id is the same: sound starts on the person's tap", () => {
    openPublicJamById(SONG);
    expect(peekPublicJamRequest()?.intent).toMatchObject({ kind: "song", record: false });
  });

  it("recording opens the song with the studio asked for, once", () => {
    recordOnPublicJam(SONG);
    expect(peekPublicJamRequest()?.intent).toMatchObject({ kind: "song", songId: SONG, record: true });
    expect(takePublicJamIntent("another-song")).toBeNull();
    expect(takePublicJamIntent(SONG)).toMatchObject({ record: true });
    expect(takePublicJamIntent(SONG)).toBeNull();
  });

  it("starting one opens the new-song sheet, at its own address", () => {
    startPublicJam();
    const request = peekPublicJamRequest();
    expect(request?.target).toBe("new");
    expect(request && publicJamRequestPath(request)).toBe("/app/jam/new");
  });

  it("\"Tuas músicas\" opens at its own address and has no song to act on (round 3, N-3)", () => {
    openMyJams();
    const request = peekPublicJamRequest();
    expect(request?.target).toBe("mine");
    expect(request?.intent).toEqual({ kind: "mine" });
    expect(request && publicJamRequestPath(request)).toBe("/app/jam/mine");
    expect(takePublicJamIntent("mine")).toEqual({ kind: "mine" });
    expect(takePublicJamIntent("mine")).toBeNull();
  });

  it("every request moves the nonce, so asking twice for the same song still opens it", () => {
    openPublicJam({ kind: "new" });
    const first = peekPublicJamRequest()?.nonce ?? 0;
    openPublicJam({ kind: "new" });
    expect(peekPublicJamRequest()?.nonce).toBeGreaterThan(first);
  });
});
