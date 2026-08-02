import type { PublicUser } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import { excludeUsers, readUserQuery } from "./user-search";

function person(id: string, name = id): PublicUser {
  return {
    id,
    displayName: name,
    username: name.toLowerCase(),
    tag: `${name.toLowerCase()}#0001`,
    avatarUrl: null,
  };
}

describe("readUserQuery", () => {
  it("asks for an exact lookup when given a whole handle", () => {
    expect(readUserQuery("ana#0001")).toEqual({ kind: "tag", tag: "ana#0001" });
  });

  it("takes a handle the way people actually write one", () => {
    expect(readUserQuery("  @Ana#0001 ")).toEqual({
      kind: "tag",
      tag: "ana#0001",
    });
  });

  it("falls back to a prefix search for a partial handle", () => {
    expect(readUserQuery("ana")).toEqual({ kind: "prefix", query: "ana" });
    // A number that is not four digits is not a discriminator, so this is still
    // somebody typing towards a handle rather than having finished one.
    expect(readUserQuery("ana#00")).toEqual({ kind: "prefix", query: "ana#00" });
  });

  it("strips the @ a prefix search would otherwise look for literally", () => {
    expect(readUserQuery("@ana")).toEqual({ kind: "prefix", query: "ana" });
  });

  it("asks for nothing below the length the server will answer", () => {
    expect(readUserQuery("")).toEqual({ kind: "idle" });
    expect(readUserQuery("a")).toEqual({ kind: "idle" });
    expect(readUserQuery("   ")).toEqual({ kind: "idle" });
  });

  it("asks for nothing past the length a handle can be", () => {
    expect(readUserQuery("a".repeat(33))).toEqual({ kind: "idle" });
  });

  it("still looks up a full handle at the maximum username length", () => {
    // The cap applies to a username, and a handle is a username plus five more
    // characters — measuring the whole handle against it would make the longest
    // legal handles unlookupable.
    const handle = `${"a".repeat(32)}#0001`;
    expect(readUserQuery(handle)).toEqual({ kind: "tag", tag: handle });
  });
});

describe("excludeUsers", () => {
  it("removes people already accounted for", () => {
    const users = [person("me"), person("ana"), person("bo")];
    expect(excludeUsers(users, ["me", "bo"]).map((u) => u.id)).toEqual(["ana"]);
  });

  it("returns everybody when nothing is excluded", () => {
    const users = [person("ana")];
    expect(excludeUsers(users, [])).toEqual(users);
  });
});
