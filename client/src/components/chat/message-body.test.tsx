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

  it("keeps a blank line as a short spacer, not a tight paragraph gap", () => {
    const html = render("hello\n\nworld");
    expect(brCount(html)).toBe(1);
    expect(html.match(/class="chat-blank"/g)?.length).toBe(1);
  });

  it("collapses extra blank lines so a paste cannot shove the channel down", () => {
    for (const body of ["hello\n\n\nworld", "hello\n\n\n\n\nworld"]) {
      const html = render(body);
      expect(brCount(html)).toBe(1);
      expect(html.match(/class="chat-blank"/g)?.length).toBe(1);
    }
  });

  it("drops a trailing blank line instead of leaving a spacer", () => {
    const html = render("hello\n\n");
    expect(html).not.toContain("chat-blank");
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

  // The renderer is a user-content surface: these pin what a sender cannot get
  // onto a reader's page, whatever version of react-markdown draws it.
  describe("untrusted content", () => {
    it("never renders a markdown image, so no remote pixel", () => {
      const html = render("![pixel](https://evil.example/p.png) after");
      expect(html).not.toContain("<img");
      expect(html).not.toContain("evil.example");
    });

    it("shows raw HTML as text, never as elements", () => {
      const html = render(
        '<script>alert(1)</script> <img src=x onerror=alert(1)> <div style="position:fixed">x</div>',
      );
      expect(html).not.toContain("<script");
      expect(html).not.toContain("<img");
      expect(html).not.toContain("<div");
      expect(html).toContain("&lt;script&gt;");
    });

    it("drops the target of a javascript: or data: link", () => {
      const html = render(
        "[js](javascript:alert(1)) [data](data:text/html;base64,PHNjcmlwdD4=)",
      );
      expect(html).not.toContain("javascript:");
      expect(html).not.toContain("data:text/html");
    });

    it("opens every link in a new tab without an opener or a referrer", () => {
      const html = render("[a](https://example.com) and https://example.org/x");
      const anchors = html.match(/<a [^>]*>/g) ?? [];
      expect(anchors).toHaveLength(2);
      for (const a of anchors) {
        expect(a).toContain('target="_blank"');
        expect(a).toContain('rel="noopener noreferrer nofollow ugc"');
      }
    });

    it("does not turn headings or tables into elements chat does not allow", () => {
      const html = render("# title\n\n| a | b |\n|---|---|\n| 1 | 2 |");
      expect(html).not.toContain("<h1");
      expect(html).not.toContain("<table");
    });
  });
});
