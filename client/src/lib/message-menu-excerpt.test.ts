import { describe, expect, it } from "vitest";
import { describeMessageForMenu } from "./message-menu-excerpt";

const t = (key: string, vars?: Record<string, unknown>) => `${key}${vars ? JSON.stringify(vars) : ""}`;

describe("describeMessageForMenu", () => {
  it("flattens a body into one excerpt line", () => {
    expect(describeMessageForMenu({ body: "oi\n\n  tudo bem?" }, t)).toBe("oi tudo bem?");
  });

  it("drops the marks around formatted text", () => {
    expect(describeMessageForMenu({ body: "bora às ***20h*** então" }, t)).toBe("bora às 20h então");
    expect(describeMessageForMenu({ body: "~~não~~ **sim** `/roll` ||segredo|| _talvez_" }, t)).toBe(
      "não sim /roll segredo talvez",
    );
  });

  it("leaves text that only looks like a mark", () => {
    expect(describeMessageForMenu({ body: "2 * 3 * 4 e snake_case_name" }, t)).toBe("2 * 3 * 4 e snake_case_name");
  });

  it("drops mention markup, and keeps a body that is nothing else", () => {
    expect(describeMessageForMenu({ body: "oi <@abc123> tudo bem" }, t)).toBe("oi tudo bem");
    expect(describeMessageForMenu({ body: "<@abc123>" }, t)).toBe("<@abc123>");
  });

  it("names the file of a message with only an image", () => {
    expect(describeMessageForMenu({ body: " ", attachments: [{ filename: "foto.png" }] }, t)).toBe("foto.png");
  });

  it("counts the rest when there are several files", () => {
    expect(
      describeMessageForMenu({ body: "", attachments: [{ filename: "a.png" }, { filename: "b.png" }] }, t),
    ).toBe('pins.moreAttachments{"filename":"a.png","count":1}');
  });

  it("says the message is empty when there is nothing at all", () => {
    expect(describeMessageForMenu({ body: "" }, t)).toBe("pins.emptyMessage");
  });
});
