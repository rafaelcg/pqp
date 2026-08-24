import { describe, expect, it } from "vitest";
import {
  applyMention,
  filterMentionCandidates,
  findMentionQuery,
  type MentionCandidate,
} from "./mention-autocomplete";

describe("findMentionQuery", () => {
  it("finds a bare @ at the start of the draft", () => {
    expect(findMentionQuery("@", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  it("finds a token mid-sentence, which is the whole point", () => {
    const value = "hey @raf";
    expect(findMentionQuery(value, value.length)).toEqual({
      start: 4,
      end: 8,
      query: "raf",
    });
  });

  it("reads the token at the caret, not the last one in the draft", () => {
    const value = "@one and @two";
    expect(findMentionQuery(value, 4)).toEqual({
      start: 0,
      end: 4,
      query: "one",
    });
  });

  it("ignores an @ that does not start a word", () => {
    expect(findMentionQuery("mail me@example", 15)).toBeNull();
  });

  it("ignores a caret that has moved past the token", () => {
    expect(findMentionQuery("@raf hello", 10)).toBeNull();
  });

  it("gives up rather than scanning an unbounded run of word characters", () => {
    const value = `@${"a".repeat(40)}`;
    expect(findMentionQuery(value, value.length)).toBeNull();
  });

  it("returns nothing when there is no @ at all", () => {
    expect(findMentionQuery("plain text", 10)).toBeNull();
  });
});

const members: MentionCandidate[] = [
  { id: "1", displayName: "Rafael", username: "rafael", avatarUrl: null },
  { id: "2", displayName: "Bea", username: "beatriz", avatarUrl: null },
  { id: "3", displayName: "Rafa Junior", username: "junior", avatarUrl: null },
  { id: "4", displayName: "No Handle", username: null, avatarUrl: null },
];

describe("filterMentionCandidates", () => {
  it("matches on username and display name", () => {
    expect(
      filterMentionCandidates(members, "rafa").map((m) => m.id),
    ).toEqual(["1", "3"]);
    expect(filterMentionCandidates(members, "bea").map((m) => m.id)).toEqual([
      "2",
    ]);
  });

  it("matches a nickname prefix", () => {
    const withNick: MentionCandidate[] = [
      ...members,
      {
        id: "5",
        displayName: "Carla",
        username: "carla",
        nickname: "Ju",
        avatarUrl: null,
      },
    ];
    expect(
      filterMentionCandidates(withNick, "ju").map((m) => m.id),
    ).toEqual(["3", "5"]);
  });

  it("ranks a username prefix above a display-name prefix", () => {
    expect(
      filterMentionCandidates(members, "ju").map((m) => m.username),
    ).toEqual(["junior"]);
    expect(
      filterMentionCandidates(members, "b").map((m) => m.username),
    ).toEqual(["beatriz"]);
  });

  it("drops members with no username, since @nothing cannot be sent", () => {
    expect(filterMentionCandidates(members, "").map((m) => m.id)).not.toContain(
      "4",
    );
  });

  it("caps the list", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      id: `${index}`,
      displayName: `User ${index}`,
      username: `user${index}`,
      avatarUrl: null,
    }));
    expect(filterMentionCandidates(many, "user")).toHaveLength(8);
  });
});

describe("applyMention", () => {
  it("replaces the token in place and leaves the caret after it", () => {
    const value = "hey @raf, look";
    const active = findMentionQuery(value, 8)!;
    expect(applyMention(value, active, "rafael")).toEqual({
      value: "hey @rafael , look",
      caret: 12,
    });
  });
});
