import { describe, expect, it } from "vitest";
import { messageMentionsYou, messagePingsYou } from "./message-mentions-you";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("messageMentionsYou", () => {
  it("lights a fired @everyone or @here regardless of handle", () => {
    expect(
      messageMentionsYou(
        { body: "hi", authorId: OTHER, mentionEveryone: true },
        null,
        ME,
      ),
    ).toBe(true);
    expect(
      messageMentionsYou(
        { body: "hi", authorId: OTHER, mentionHere: true },
        "rafa",
        ME,
      ),
    ).toBe(true);
  });

  it("lights an @username that is the reader", () => {
    expect(
      messageMentionsYou(
        { body: "hey @Rafa look", authorId: OTHER },
        "rafa",
        ME,
      ),
    ).toBe(true);
  });

  it("does not light a typed @everyone that was not allowed to ping", () => {
    expect(
      messageMentionsYou(
        { body: "hey @everyone", authorId: OTHER, mentionEveryone: false },
        "rafa",
        ME,
      ),
    ).toBe(false);
  });

  it("does not light someone else's handle", () => {
    expect(
      messageMentionsYou({ body: "hey @bo", authorId: OTHER }, "rafa", ME),
    ).toBe(false);
    expect(
      messageMentionsYou({ body: "plain text", authorId: OTHER }, "rafa", ME),
    ).toBe(false);
  });

  it("does not light your own message, even self-mentions and mass pings", () => {
    expect(
      messageMentionsYou({ body: "ping @rafa", authorId: ME }, "rafa", ME),
    ).toBe(false);
    expect(
      messageMentionsYou(
        { body: "hey @everyone", authorId: ME, mentionEveryone: true },
        "rafa",
        ME,
      ),
    ).toBe(false);
    expect(
      messageMentionsYou(
        { body: "hey @here", authorId: ME, mentionHere: true },
        "rafa",
        ME,
      ),
    ).toBe(false);
  });
});

describe("messagePingsYou", () => {
  it("pings a fired @everyone or @here from someone else", () => {
    expect(
      messagePingsYou(
        { body: "hi", authorId: OTHER, mentionEveryone: true },
        "rafa",
        ME,
      ),
    ).toBe(true);
    expect(
      messagePingsYou(
        { body: "hi", authorId: OTHER, mentionHere: true },
        "rafa",
        ME,
      ),
    ).toBe(true);
  });

  it("pings when someone else tags the reader by username", () => {
    expect(
      messagePingsYou({ body: "hey @rafa", authorId: OTHER }, "rafa", ME),
    ).toBe(true);
  });

  it("pings when someone else replies to the reader", () => {
    expect(
      messagePingsYou(
        { body: "ok", authorId: OTHER, replyTo: { authorId: ME } },
        "rafa",
        ME,
      ),
    ).toBe(true);
  });

  it("does not ping a typed @everyone that was not allowed to fire", () => {
    expect(
      messagePingsYou(
        { body: "hey @everyone", authorId: OTHER, mentionEveryone: false },
        "rafa",
        ME,
      ),
    ).toBe(false);
  });

  it("does not ping your own messages", () => {
    expect(
      messagePingsYou({ body: "ping @rafa", authorId: ME }, "rafa", ME),
    ).toBe(false);
    expect(
      messagePingsYou(
        { body: "hey @everyone", authorId: ME, mentionEveryone: true },
        "rafa",
        ME,
      ),
    ).toBe(false);
    expect(
      messagePingsYou(
        { body: "ok", authorId: ME, replyTo: { authorId: ME } },
        "rafa",
        ME,
      ),
    ).toBe(false);
  });
});
