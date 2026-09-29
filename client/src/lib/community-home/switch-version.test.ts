import { describe, expect, it } from "vitest";
import type { Server } from "@pqp/shared";
import {
  applyCommunityHomeRead,
  applyCommunityHomeSwitch,
  mergeServerUpdate,
} from "./switch-version";

function server(overrides: Partial<Server> = {}): Server {
  return {
    id: "s1",
    name: "Hall",
    ownerId: "owner",
    role: "member",
    createdAt: "2026-09-01T00:00:00.000Z",
    messageRetentionDays: null,
    ssoEmailDomain: null,
    iconUrl: null,
    bannerUrl: null,
    isCommunity: false,
    communityHomeEnabled: false,
    communityHomeVersion: 2,
    communityTagline: null,
    communityAbout: null,
    communityLinks: [],
    communitySlug: null,
    showOnProfile: true,
    ...overrides,
  } as Server;
}

describe("applyCommunityHomeSwitch", () => {
  it("applies a newer value", () => {
    const rows = [server()];
    const next = applyCommunityHomeSwitch(rows, "s1", {
      enabled: true,
      version: 3,
    });
    expect(next[0]).toMatchObject({
      communityHomeEnabled: true,
      communityHomeVersion: 3,
    });
  });

  it("ignores an older frame that arrives after a newer one", () => {
    let rows: Server[] = [server()];
    rows = applyCommunityHomeSwitch(rows, "s1", { enabled: true, version: 4 });
    rows = applyCommunityHomeSwitch(rows, "s1", { enabled: false, version: 3 });
    expect(rows[0]).toMatchObject({
      communityHomeEnabled: true,
      communityHomeVersion: 4,
    });
  });

  it("returns the same array for a duplicate", () => {
    const rows = [server({ communityHomeEnabled: true, communityHomeVersion: 3 })];
    expect(
      applyCommunityHomeSwitch(rows, "s1", { enabled: true, version: 3 }),
    ).toBe(rows);
  });

  it("returns the same array for a server the viewer does not have", () => {
    const rows = [server()];
    expect(
      applyCommunityHomeSwitch(rows, "other", { enabled: true, version: 9 }),
    ).toBe(rows);
  });

  it("reads a row with no version as version 0", () => {
    const rows = [server({ communityHomeVersion: undefined })];
    expect(
      applyCommunityHomeSwitch(rows, "s1", { enabled: true, version: 1 })[0],
    ).toMatchObject({ communityHomeEnabled: true, communityHomeVersion: 1 });
  });

  it("leaves other servers alone", () => {
    const other = server({ id: "s2", communityHomeVersion: 0 });
    const next = applyCommunityHomeSwitch([server(), other], "s1", {
      enabled: true,
      version: 3,
    });
    expect(next[1]).toBe(other);
  });
});

describe("applyCommunityHomeRead", () => {
  it("guards a versioned read like a frame", () => {
    const rows = [server({ communityHomeEnabled: true, communityHomeVersion: 5 })];
    expect(
      applyCommunityHomeRead(rows, "s1", { enabled: false, version: 4 }, 5),
    ).toBe(rows);
    expect(
      applyCommunityHomeRead(rows, "s1", { enabled: false, version: 6 }, 5)[0],
    ).toMatchObject({ communityHomeEnabled: false, communityHomeVersion: 6 });
  });

  it("applies a read from an API without versions and keeps the row's version", () => {
    const rows = [server({ communityHomeEnabled: false, communityHomeVersion: 2 })];
    const next = applyCommunityHomeRead(rows, "s1", { enabled: true }, 2);
    expect(next[0]).toMatchObject({
      communityHomeEnabled: true,
      communityHomeVersion: 2,
    });
    // A later versioned frame still has to be newer than the row's version.
    expect(
      applyCommunityHomeSwitch(next, "s1", { enabled: false, version: 2 }),
    ).toBe(next);
  });

  it("returns the same array when an unversioned read agrees", () => {
    const rows = [server({ communityHomeEnabled: true })];
    expect(applyCommunityHomeRead(rows, "s1", { enabled: true }, 2)).toBe(rows);
  });

  it("drops an unversioned read when a versioned frame landed while it was in flight", () => {
    // Read sent at version 2; the owner's newer flip arrived as a v3 frame.
    let rows: Server[] = [server({ communityHomeEnabled: false, communityHomeVersion: 2 })];
    rows = applyCommunityHomeSwitch(rows, "s1", { enabled: true, version: 3 });
    const next = applyCommunityHomeRead(rows, "s1", { enabled: false }, 2);
    expect(next).toBe(rows);
    expect(next[0]).toMatchObject({
      communityHomeEnabled: true,
      communityHomeVersion: 3,
    });
  });
});

describe("mergeServerUpdate", () => {
  it("takes the write's fields and keeps the viewer's membership", () => {
    const current = server({ role: "admin", showOnProfile: false });
    const merged = mergeServerUpdate(
      current,
      server({ name: "Renamed", role: "owner", showOnProfile: true }),
    );
    expect(merged).toMatchObject({
      name: "Renamed",
      role: "admin",
      showOnProfile: false,
    });
  });

  it("keeps a newer switch over an older one in a slow response", () => {
    const current = server({ communityHomeEnabled: false, communityHomeVersion: 5 });
    const merged = mergeServerUpdate(
      current,
      server({ name: "Renamed", communityHomeEnabled: true, communityHomeVersion: 4 }),
    );
    expect(merged).toMatchObject({
      name: "Renamed",
      communityHomeEnabled: false,
      communityHomeVersion: 5,
    });
  });

  it("takes a newer switch from the write", () => {
    const merged = mergeServerUpdate(
      server(),
      server({ communityHomeEnabled: true, communityHomeVersion: 3 }),
    );
    expect(merged).toMatchObject({
      communityHomeEnabled: true,
      communityHomeVersion: 3,
    });
  });
});
