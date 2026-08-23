import { beforeEach, describe, expect, it } from "vitest";
import {
  messageFromCompleteFailure,
  peekConnectionCallback,
  stashConnectionCallback,
  stashConnectionError,
  takeConnectionCallback,
  takeConnectionError,
} from "./connection-callback";
import { ApiError } from "./api";

function memoryStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage & { map: Map<string, string> };
}

describe("connection callback stash", () => {
  let storage: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    storage = memoryStorage();
  });

  it("keeps Steam OpenID fields across a later URL rewrite", () => {
    stashConnectionCallback(
      "/app/connections/callback/steam",
      "?state=abc&openid.mode=id_res&openid.claimed_id=https://steamcommunity.com/openid/id/76561198000000001",
      storage,
    );
    expect(peekConnectionCallback(storage)).toBe(true);
    const taken = takeConnectionCallback(storage);
    expect(taken).toEqual({
      provider: "steam",
      params: {
        state: "abc",
        "openid.mode": "id_res",
        "openid.claimed_id":
          "https://steamcommunity.com/openid/id/76561198000000001",
      },
    });
    expect(takeConnectionCallback(storage)).toBeNull();
  });

  it("ignores a path that is not a callback", () => {
    stashConnectionCallback("/app", "?code=stolen", storage);
    expect(peekConnectionCallback(storage)).toBe(false);
  });

  it("survives storage throwing", () => {
    const hostile = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
      removeItem() {
        throw new Error("denied");
      },
    };
    stashConnectionCallback(
      "/app/connections/callback/twitch",
      "?code=abc&state=xyz",
      hostile,
    );
    expect(takeConnectionCallback(hostile)).toBeNull();
  });
});

describe("connection complete error stash", () => {
  let storage: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    storage = memoryStorage();
  });

  it("keeps the message across a later URL rewrite, then consumes it", () => {
    stashConnectionError("Could not finish that connection.", storage);
    expect(takeConnectionError(storage)).toBe(
      "Could not finish that connection.",
    );
    expect(takeConnectionError(storage)).toBeNull();
  });

  it("survives storage throwing", () => {
    const hostile = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
      removeItem() {
        throw new Error("denied");
      },
    };
    stashConnectionError("Could not finish that connection.", hostile);
    expect(takeConnectionError(hostile)).toBeNull();
  });
});

describe("messageFromCompleteFailure", () => {
  it("keeps a distinct API reason instead of the generic fallback", () => {
    expect(
      messageFromCompleteFailure(
        new ApiError(409, "That account is already connected to another pqp user"),
        "Could not finish that connection.",
      ),
    ).toBe("That account is already connected to another pqp user");
  });

  it("falls back when the failure is not an ApiError", () => {
    expect(
      messageFromCompleteFailure(new Error("network"), "Could not finish that connection."),
    ).toBe("Could not finish that connection.");
  });
});
