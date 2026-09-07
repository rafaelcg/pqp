import { describe, expect, it } from "vitest";
import { sfuIceServers } from "./sfu-ice-servers";

const STUN = { urls: "stun:stun.l.google.com:19302" };
const TURN = {
  urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:5349"],
  username: "u",
  credential: "c",
};

describe("sfuIceServers", () => {
  it("hands the list over when it carries a TURN entry", () => {
    expect(sfuIceServers([STUN, TURN])).toEqual([STUN, TURN]);
  });

  it("accepts a single-string turns: url", () => {
    const relay = { urls: "TURNS:relay.example:443?transport=tcp", username: "u", credential: "c" };
    expect(sfuIceServers([relay])).toEqual([relay]);
  });

  it("passes nothing for a STUN-only list, so the server's relays stay in play", () => {
    expect(sfuIceServers([STUN, { urls: ["stun:a", "stun:b"] }])).toBeUndefined();
  });

  it("passes nothing for an empty or missing list", () => {
    expect(sfuIceServers([])).toBeUndefined();
    expect(sfuIceServers(undefined)).toBeUndefined();
    expect(sfuIceServers(null)).toBeUndefined();
  });

  it("returns a copy, not the caller's array", () => {
    const list = [TURN];
    const out = sfuIceServers(list);
    expect(out).not.toBe(list);
  });
});
