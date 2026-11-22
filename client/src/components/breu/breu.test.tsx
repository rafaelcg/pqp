// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { resetRedesignForTests, setRedesignFlag } from "@/lib/redesign";
import { EmptyState } from "@/components/ui/empty-state";
import { Breu } from "./breu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

afterEach(() => {
  resetRedesignForTests();
});

/** A client render: the server snapshot of the toggle is always off. */
function clientMarkup(node: React.ReactElement): string {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(node));
  const html = host.innerHTML;
  act(() => root.unmount());
  return html;
}

describe("Breu", () => {
  it("draws the lime character with the face for the mood", () => {
    const html = renderToStaticMarkup(<Breu mood="sad" />);
    expect(html).toContain('data-variant="full"');
    expect(html).toContain('data-face="triste"');
    expect(html).toContain("<svg");
  });

  it("takes the icon's place in an empty state under the redesign, decorative", () => {
    setRedesignFlag(true);
    const html = clientMarkup(
      <EmptyState mascot="hello" icon={<i data-glyph="" />} title="Nada aqui" />,
    );
    expect(html).toContain('data-empty-mascot="hello"');
    expect(html).toContain('data-face="oi"');
    expect(html).not.toContain("data-glyph");
    expect(html).toMatch(/data-empty-mascot="hello"[^>]*aria-hidden="true"|aria-hidden="true"[^>]*data-empty-mascot="hello"/);
  });

  it("leaves the empty state's own icon with the toggle off", () => {
    const html = clientMarkup(
      <EmptyState mascot="hello" icon={<i data-glyph="" />} title="Nada aqui" />,
    );
    expect(html).toContain("data-glyph");
    expect(html).not.toContain("data-empty-mascot");
  });

  it("moves only when asked, on wrappers the compositor can run, and holds still for reduced motion", () => {
    const still = renderToStaticMarkup(<Breu mood="focused" />);
    expect(still).not.toContain("data-breu-motion");
    expect(still).not.toContain("breu-work");

    const working = renderToStaticMarkup(<Breu mood="focused" motion="working" />);
    expect(working).toContain('data-breu-motion="working"');
    expect(working).toContain("animate-[breu-work-bob_");
    expect(working).toContain("animate-[breu-work-lean_");
    expect(working.match(/motion-reduce:animate-none/g)).toHaveLength(2);
    // The face inside is held still, so its SVG breathing does not fight the hop.
    expect(working).not.toContain("bot-face-live");
  });
});
