import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";
import {
  deleteAuthenticatedSocket,
  setAuthenticatedSocket,
  socketsOfUser,
  userHasAuthenticatedSocket,
} from "./sockets.js";

/**
 * The per-account index beside the socket map. A membership change reaches
 * every instance, and most hold no socket for that account: the index is what
 * lets them answer "none here" without walking every connection. It has to
 * stay exactly in step with the map, or a catch-up goes to a socket that is
 * gone or misses one that is open.
 */

const created: WebSocket[] = [];

function fakeSocket(): WebSocket {
  const socket = { readyState: 1 } as unknown as WebSocket;
  created.push(socket);
  return socket;
}

function user(id: string): DbUser {
  return { id } as DbUser;
}

afterEach(() => {
  for (const socket of created.splice(0)) {
    deleteAuthenticatedSocket(socket);
  }
});

describe("socketsOfUser", () => {
  it("lists every socket of the account and none of anybody else's", () => {
    const a1 = fakeSocket();
    const a2 = fakeSocket();
    const b1 = fakeSocket();
    setAuthenticatedSocket(a1, user("a"));
    setAuthenticatedSocket(a2, user("a"));
    setAuthenticatedSocket(b1, user("b"));

    expect(new Set(socketsOfUser("a"))).toEqual(new Set([a1, a2]));
    expect(socketsOfUser("b")).toEqual([b1]);
    expect(socketsOfUser("nobody")).toEqual([]);
  });

  it("forgets a socket on delete, and the account with its last one", () => {
    const a1 = fakeSocket();
    const a2 = fakeSocket();
    setAuthenticatedSocket(a1, user("a"));
    setAuthenticatedSocket(a2, user("a"));

    deleteAuthenticatedSocket(a1);
    expect(socketsOfUser("a")).toEqual([a2]);
    expect(userHasAuthenticatedSocket("a")).toBe(true);

    deleteAuthenticatedSocket(a2);
    expect(socketsOfUser("a")).toEqual([]);
    expect(userHasAuthenticatedSocket("a")).toBe(false);
  });

  it("moves a socket that authenticates again as somebody else", () => {
    const socket = fakeSocket();
    setAuthenticatedSocket(socket, user("a"));
    setAuthenticatedSocket(socket, user("b"));

    expect(socketsOfUser("a")).toEqual([]);
    expect(userHasAuthenticatedSocket("a")).toBe(false);
    expect(socketsOfUser("b")).toEqual([socket]);
  });

  it("returns a copy the caller may hold across a close", () => {
    const socket = fakeSocket();
    setAuthenticatedSocket(socket, user("a"));
    const held = socketsOfUser("a");
    deleteAuthenticatedSocket(socket);
    expect(held).toEqual([socket]);
  });
});
