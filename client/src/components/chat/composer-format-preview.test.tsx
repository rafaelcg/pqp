import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComposerFormatPreview } from "./composer-format-preview";

function render(body: string) {
  return renderToStaticMarkup(
    <ComposerFormatPreview body={body} label="Preview" onActivate={() => {}} />,
  );
}

describe("ComposerFormatPreview", () => {
  it("paints bold, italic, strike and inline code instead of the markers", () => {
    const html = render("**bold** *italic* ~~strike~~ `code`");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<del>strike</del>");
    expect(html).toContain("<code>code</code>");
    expect(html).not.toContain("**");
    expect(html).not.toContain("~~");
    expect(html).not.toContain("`");
  });

  it("paints a fence as a code block, not the ticks", () => {
    const html = render("```\nconst x = 1\n```");
    expect(html).toContain("<pre>");
    expect(html).toContain("const x = 1");
    expect(html).not.toContain("```");
  });

  it("leaves the markdown source with the caller; empty drafts hide the preview", () => {
    const source = "**keep the markers**";
    const html = render(source);
    expect(source).toBe("**keep the markers**");
    expect(html).toContain("<strong>keep the markers</strong>");
    expect(render("")).toBe("");
  });
});
