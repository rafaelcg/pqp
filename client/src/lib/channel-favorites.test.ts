import { describe, expect, it } from "vitest";
import type { Channel } from "@pqp/shared";
import { FAVORITE_CHANNELS_PER_SERVER_MAX } from "@pqp/shared";
import {
  addFavorite,
  favoritesCollapseKey,
  favoritesForServer,
  isFavoriteChannel,
  moveFavorite,
  removeFavorite,
  visibleFavoriteChannels,
  writeFavoritesForServer,
} from "./channel-favorites";

const SERVER = "3c09d34c-21a3-41f7-99a9-94caf6145596";
const OTHER_SERVER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GENERAL = "11111111-1111-4111-8111-111111111111";
const LOBBY = "22222222-2222-4222-8222-222222222222";
const RANDOM = "33333333-3333-4333-8333-333333333333";
const GHOST = "44444444-4444-4444-8444-444444444444";
const CATEGORY = "55555555-5555-4555-8555-555555555555";

function channel(
  id: string,
  type: Channel["type"],
  extra: Partial<Channel> = {},
): Channel {
  return {
    id,
    serverId: SERVER,
    kind: "server",
    name: id.slice(0, 8),
    type,
    position: 0,
    isPrivate: false,
    topic: null,
    imageUrl: null,
    parentId: null,
    slowmodeSeconds: 0,
    ...extra,
  };
}

const general = channel(GENERAL, "text");
const lobby = channel(LOBBY, "voice");
const random = channel(RANDOM, "text", { parentId: CATEGORY });
const category = channel(CATEGORY, "category");

describe("favoritesForServer / writeFavoritesForServer", () => {
  it("reads one server's list and leaves the rest of the map intact on write", () => {
    const map = {
      [SERVER]: [GENERAL],
      [OTHER_SERVER]: [LOBBY],
    };
    expect(favoritesForServer(map, SERVER)).toEqual([GENERAL]);
    expect(writeFavoritesForServer(map, SERVER, [LOBBY, GENERAL])).toEqual({
      [SERVER]: [LOBBY, GENERAL],
      [OTHER_SERVER]: [LOBBY],
    });
  });

  it("drops the server key when the list is emptied", () => {
    expect(
      writeFavoritesForServer(
        { [SERVER]: [GENERAL], [OTHER_SERVER]: [LOBBY] },
        SERVER,
        [],
      ),
    ).toEqual({ [OTHER_SERVER]: [LOBBY] });
  });

  it("treats a missing map as empty", () => {
    expect(favoritesForServer(undefined, SERVER)).toEqual([]);
    expect(writeFavoritesForServer(undefined, SERVER, [GENERAL])).toEqual({
      [SERVER]: [GENERAL],
    });
  });
});

describe("visibleFavoriteChannels", () => {
  it("keeps stored order and skips missing ids, duplicates, and categories", () => {
    expect(
      visibleFavoriteChannels(
        [general, lobby, random, category],
        [GHOST, LOBBY, GENERAL, LOBBY, CATEGORY, RANDOM],
      ).map((c) => c.id),
    ).toEqual([LOBBY, GENERAL, RANDOM]);
  });
});

describe("addFavorite / removeFavorite / moveFavorite", () => {
  it("appends a new favourite and refuses a category", () => {
    expect(addFavorite([GENERAL], lobby).map(String)).toEqual([GENERAL, LOBBY]);
    expect(addFavorite([GENERAL], category)).toEqual([GENERAL]);
  });

  it("inserts before another favourite, and moves an existing one", () => {
    expect(addFavorite([GENERAL, LOBBY], random, LOBBY)).toEqual([
      GENERAL,
      RANDOM,
      LOBBY,
    ]);
    expect(addFavorite([GENERAL, LOBBY], general, LOBBY)).toEqual([
      GENERAL,
      LOBBY,
    ]);
    expect(addFavorite([GENERAL, LOBBY], general)).toEqual([LOBBY, GENERAL]);
  });

  it("does not add past the per-server cap", () => {
    const ids = Array.from(
      { length: FAVORITE_CHANNELS_PER_SERVER_MAX },
      (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
    );
    expect(addFavorite(ids, lobby)).toEqual(ids);
  });

  it("lets an already-favourited id move even when the list is at the cap", () => {
    const first = "11111111-1111-4111-8111-000000000000";
    const ids = Array.from(
      { length: FAVORITE_CHANNELS_PER_SERVER_MAX },
      (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
    );
    const moved = addFavorite(ids, { id: first, type: "text" });
    expect(moved).toHaveLength(FAVORITE_CHANNELS_PER_SERVER_MAX);
    expect(moved.at(-1)).toBe(first);
    expect(moved[0]).not.toBe(first);
  });

  it("removes one id and leaves the rest", () => {
    expect(removeFavorite([GENERAL, LOBBY, RANDOM], LOBBY)).toEqual([
      GENERAL,
      RANDOM,
    ]);
  });

  it("swaps with the neighbouring visible favourite, leaving ghosts in place", () => {
    const ids = [GHOST, GENERAL, LOBBY];
    const visible = [GENERAL, LOBBY];
    expect(moveFavorite(ids, GENERAL, 1, visible)).toEqual([
      GHOST,
      LOBBY,
      GENERAL,
    ]);
    expect(moveFavorite(ids, GENERAL, -1, visible)).toEqual(ids);
    expect(moveFavorite(ids, LOBBY, 1, visible)).toEqual(ids);
  });
});

describe("isFavoriteChannel / favoritesCollapseKey", () => {
  it("reports membership and namespaces the collapse key", () => {
    expect(isFavoriteChannel([GENERAL, LOBBY], LOBBY)).toBe(true);
    expect(isFavoriteChannel([GENERAL], LOBBY)).toBe(false);
    expect(favoritesCollapseKey(SERVER)).toBe(`favorites:${SERVER}`);
  });
});
