import { describe, expect, it } from "vitest";
import { filterPeople, mergePeople, type MentionPerson } from "./mention-people";

const person = (id: string, displayName: string): MentionPerson => ({ id, displayName, avatarUrl: null });

describe("mergePeople", () => {
  it("lists each person once, never the author, alphabetically", () => {
    const merged = mergePeople(
      [
        [person("2", "Bia"), person("1", "Ana"), person("me", "Eu")],
        [person("2", "Bia"), person("3", "Caio")],
      ],
      "me",
    );
    expect(merged.map((entry) => entry.displayName)).toEqual(["Ana", "Bia", "Caio"]);
  });
});

describe("filterPeople", () => {
  const people = [person("1", "Ana Paula"), person("2", "Bruno"), person("3", "Joana")];
  it("matches anywhere in the name, ignoring case and a leading @", () => {
    expect(filterPeople(people, "ana").map((entry) => entry.id)).toEqual(["1", "3"]);
    expect(filterPeople(people, "@BRU").map((entry) => entry.id)).toEqual(["2"]);
  });
  it("returns everyone for an empty query", () => {
    expect(filterPeople(people, "  ")).toHaveLength(3);
  });
});
