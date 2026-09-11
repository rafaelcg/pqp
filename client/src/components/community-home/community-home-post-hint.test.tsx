import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CommunityHomePostHint } from "./community-home-post-hint";

function renderHint(node: ReactElement) {
  return renderToStaticMarkup(node);
}

describe("CommunityHomePostHint", () => {
  it("paints the CTA when it holds the corner", () => {
    const html = renderHint(
      <CommunityHomePostHint
        enabled
        serverName="Mesa da Tues"
        onOpen={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain("data-corner-card=\"community-home-post\"");
    expect(html).toContain("Open Baú");
    expect(html).toContain("Mesa da Tues");
  });

  it("renders nothing when the corner belongs to someone else", () => {
    const html = renderHint(
      <CommunityHomePostHint
        enabled={false}
        serverName="Mesa da Tues"
        onOpen={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(html).toBe("");
  });
});
