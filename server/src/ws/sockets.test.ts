import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";
import {
  deleteAuthenticatedSocket,
  forEachSocketOfUser,
  setAuthenticatedSocket,
  userHasAuthenticatedSocket,
} from "./sockets.js";

const fakeSocket = () => ({}) as WebSocket;
const asUser = (id: string) => ({ id }) as DbUser;

function socketsOf(userId: string): WebSocket[] {
  const found: WebSocket[] = [];
  forEachSocketOfUser(userId, (socket) => found.push(socket));
  return found;
}

describe("the per-account socket index", () => {
  const opened: WebSocket[] = [];
  const open = (userId: string) => {
    const socket = fakeSocket();
    setAuthenticatedSocket(socket, asUser(userId));
    opened.push(socket);
    return socket;
  };

  afterEach(() => {
    for (const socket of opened) {
      deleteAuthenticatedSocket(socket);
    }
    opened.length = 0;
  });

  it("walks one account's sockets and nobody else's", () => {
    const first = open("ana");
    const second = open("ana");
    open("bia");

    expect(socketsOf("ana")).toEqual([first, second]);
    expect(socketsOf("nobody")).toEqual([]);
  });

  it("forgets an account once its last socket closes", () => {
    const first = open("ana");
    const second = open("ana");

    deleteAuthenticatedSocket(first);
    expect(userHasAuthenticatedSocket("ana")).toBe(true);
    expect(socketsOf("ana")).toEqual([second]);

    deleteAuthenticatedSocket(second);
    expect(userHasAuthenticatedSocket("ana")).toBe(false);
    expect(socketsOf("ana")).toEqual([]);
    // Idempotent, like the close path that calls it.
    deleteAuthenticatedSocket(second);
  });

  it("moves a socket that authenticates again as someone else", () => {
    const socket = open("ana");
    setAuthenticatedSocket(socket, asUser("bia"));

    expect(socketsOf("ana")).toEqual([]);
    expect(userHasAuthenticatedSocket("ana")).toBe(false);
    expect(socketsOf("bia")).toEqual([socket]);
  });
});
