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
