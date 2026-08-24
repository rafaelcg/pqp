import { describe, expect, it } from "vitest";
import { messageMentionsYou } from "./message-mentions-you";

describe("messageMentionsYou", () => {
  it("lights a fired @everyone or @here regardless of handle", () => {
    expect(
      messageMentionsYou({ body: "hi", mentionEveryone: true }, null),
    ).toBe(true);
    expect(
      messageMentionsYou({ body: "hi", mentionHere: true }, "rafa"),
    ).toBe(true);
  });

  it("lights an @username that is the reader", () => {
    expect(
      messageMentionsYou({ body: "hey @Rafa look" }, "rafa"),
    ).toBe(true);
  });

  it("does not light a typed @everyone that was not allowed to ping", () => {
    expect(
      messageMentionsYou({ body: "hey @everyone", mentionEveryone: false }, "rafa"),
    ).toBe(false);
  });

  it("does not light someone else's handle", () => {
    expect(messageMentionsYou({ body: "hey @bo" }, "rafa")).toBe(false);
    expect(messageMentionsYou({ body: "plain text" }, "rafa")).toBe(false);
  });
});
