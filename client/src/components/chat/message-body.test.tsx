import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageBody } from "./message-body";
import { CHAT_NEWLINE_FILLER, prepareChatMarkdown } from "@/lib/chat-markdown";

function render(body: string, currentUsername: string | null = null) {
  return renderToStaticMarkup(
    <MessageBody body={body} currentUsername={currentUsername} />,
  );
}

function brCount(html: string) {
  return (html.match(/<br/g) ?? []).length;
}

describe("prepareChatMarkdown", () => {
  it("fills blank lines so markdown cannot squeeze them", () => {
    expect(prepareChatMarkdown("hello\n\nworld")).toBe(
      `hello\n${CHAT_NEWLINE_FILLER}\nworld`,
    );
  });

  it("leaves empty lines inside a fenced block alone", () => {
    const source = "```\ncode\n\nstill\n```";
    expect(prepareChatMarkdown(source)).toBe(source);
  });
});

describe("MessageBody", () => {
  it("keeps a Shift+Enter newline as a line break", () => {
    const html = render("line one\nline two");
    expect(brCount(html)).toBe(1);
    expect(html).toContain("line one");
    expect(html).toContain("line two");
  });

  it("keeps a blank line as a blank line, not a tight paragraph gap", () => {
    expect(brCount(render("hello\n\nworld"))).toBe(2);
  });

  it("collapses extra blank lines so a paste cannot shove the channel down", () => {
    expect(brCount(render("hello\n\n\nworld"))).toBe(2);
    expect(brCount(render("hello\n\n\n\n\nworld"))).toBe(2);
  });

  it("renders bold, italic, strike, code, and autolinks", () => {
    const html = render(
      "**bold** *italic* ~~strike~~ `code` https://pqp.gg",
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<del>strike</del>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('href="https://pqp.gg"');
    expect(html).toContain('rel="noopener noreferrer nofollow ugc"');
  });

  it("does not eat a leading hash as a heading", () => {
    expect(render("# still a hash")).toContain("# still a hash");
  });

  it("highlights @mentions of the reader", () => {
    const html = render("hey @rafa look", "rafa");
    expect(html).toContain("pqp-mention-self");
    expect(html).toContain("@rafa");
  });

  it("keeps a fenced block, including the empty line inside it", () => {
    const html = render("```\ncode\n\nstill\n```");
    expect(html).toContain("<pre>");
    expect(html).toContain("code\n\nstill");
  });
});
