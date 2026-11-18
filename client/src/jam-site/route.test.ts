import { describe, expect, it } from "vitest";
import {
  isJamHostname,
  jamCanonicalUrl,
  jamPath,
  mainSiteOrigin,
  parseJamLocation,
} from "./route";

const ID = "0b8f2c1e-4d5a-4e6f-8a7b-1c2d3e4f5a6b";

describe("parseJamLocation", () => {
  it("reads the host mount", () => {
    expect(parseJamLocation({ hostname: "jam.pqp.gg", pathname: "/" })).toEqual({
      mount: "host",
      view: { kind: "home" },
    });
    expect(parseJamLocation({ hostname: "jam.pqp.gg", pathname: `/m/${ID}` })).toEqual({
      mount: "host",
      view: { kind: "song", songId: ID },
    });
    expect(parseJamLocation({ hostname: "jam.localhost", pathname: `/m/${ID}/` })?.view).toEqual({
      kind: "song",
      songId: ID,
    });
  });

  it("reads the path mount on any other host", () => {
    for (const hostname of ["pqp.gg", "pqp-3yr.pages.dev", "localhost"]) {
      expect(parseJamLocation({ hostname, pathname: "/jam" })).toEqual({
        mount: "path",
        view: { kind: "home" },
      });
      expect(parseJamLocation({ hostname, pathname: "/jam/" })?.view).toEqual({ kind: "home" });
      expect(parseJamLocation({ hostname, pathname: `/jam/m/${ID.toUpperCase()}` })).toEqual({
        mount: "path",
        view: { kind: "song", songId: ID },
      });
    }
  });

  it("is not the jam site anywhere else", () => {
    expect(parseJamLocation({ hostname: "pqp.gg", pathname: "/" })).toBeNull();
    expect(parseJamLocation({ hostname: "pqp.gg", pathname: "/jamais" })).toBeNull();
    expect(parseJamLocation({ hostname: "pqp.gg", pathname: "/app/jam" })).toBeNull();
    expect(parseJamLocation({ hostname: "notjam.pqp.gg", pathname: "/" })).toBeNull();
  });

  it("calls a malformed song or an unknown path unknown", () => {
    expect(parseJamLocation({ hostname: "jam.pqp.gg", pathname: "/m/nope" })?.view).toEqual({
      kind: "unknown",
    });
    expect(parseJamLocation({ hostname: "jam.pqp.gg", pathname: "/privacy" })?.view).toEqual({
      kind: "unknown",
    });
    expect(parseJamLocation({ hostname: "pqp.gg", pathname: `/jam/x/${ID}` })?.view).toEqual({
      kind: "unknown",
    });
  });
});

describe("links", () => {
  it("builds a path for the mount the visitor is on", () => {
    expect(jamPath("host", { kind: "home" })).toBe("/");
    expect(jamPath("host", { kind: "song", songId: ID })).toBe(`/m/${ID}`);
    expect(jamPath("path", { kind: "home" })).toBe("/jam");
    expect(jamPath("path", { kind: "song", songId: ID })).toBe(`/jam/m/${ID}`);
  });

  it("finds the main site from the jam host and leaves other hosts relative", () => {
    expect(mainSiteOrigin({ protocol: "https:", hostname: "jam.pqp.gg", port: "" })).toBe(
      "https://pqp.gg",
    );
    expect(mainSiteOrigin({ protocol: "http:", hostname: "jam.localhost", port: "5173" })).toBe(
      "http://localhost:5173",
    );
    expect(mainSiteOrigin({ protocol: "https:", hostname: "pqp.gg", port: "" })).toBe("");
    expect(isJamHostname("jam.pqp.gg")).toBe(true);
  });

  it("canonicalises to the hosted site", () => {
    expect(jamCanonicalUrl({ kind: "home" })).toBe("https://jam.pqp.gg/");
    expect(jamCanonicalUrl({ kind: "song", songId: ID })).toBe(`https://jam.pqp.gg/m/${ID}`);
  });
});
