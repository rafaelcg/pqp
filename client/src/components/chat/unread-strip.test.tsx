import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UnreadStrip } from "./unread-strip";

describe("UnreadStrip", () => {
  it("names the mentions only when there are some", () => {
    const quiet = renderToStaticMarkup(
      <UnreadStrip count={6} mentions={0} since="21:30" onJump={() => {}} onDismiss={() => {}} />,
    );
    const loud = renderToStaticMarkup(
      <UnreadStrip count={6} mentions={1} since="21:30" onJump={() => {}} onDismiss={() => {}} />,
    );
    expect(quiet).not.toContain("on-warning-soft");
    expect(loud).toContain("on-warning-soft");
  });
});

describe("UnreadStrip width", () => {
  const html = renderToStaticMarkup(
    <UnreadStrip count={6} mentions={0} since="21:30" onJump={() => {}} onDismiss={() => {}} />,
  );
  const classOf = (attribute: string) => {
    const tag = new RegExp(`<[^>]*${attribute}=""[^>]*>`).exec(html)?.[0] ?? "";
    return /class="([^"]*)"/.exec(tag)?.[1] ?? "";
  };

  it("measures its own width, not the window's", () => {
    expect(html).toMatch(/class="@container /);
  });

  it("drops the Esc hint first, in a thread's 416px column", () => {
    expect(classOf("data-unread-esc-hint")).toContain("@max-[36rem]:hidden");
  });

  it("keeps the jump down to a narrow column, and still hides it on a phone", () => {
    const jump = classOf("data-unread-jump");
    expect(jump).toContain("@max-[20rem]:hidden");
    expect(jump).toContain("max-sm:hidden");
  });
});
