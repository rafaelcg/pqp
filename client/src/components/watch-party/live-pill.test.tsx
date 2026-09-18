import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LivePill } from "./live-pill";

/**
 * One rule, written down where it cannot drift: the pulse is on the dot,
 * never on the text, and only under `motion-safe`.
 *
 * With reduced motion the badge sits there red and still reads as live,
 * because the colour and the word carry it and the movement is a garnish.
 * Pulsing the text would make a label somebody reads flicker, which is the
 * version people turn off rather than enjoy.
 */
describe("the AO VIVO pill", () => {
  const html = renderToStaticMarkup(<LivePill />);

  it("pulses, and only under motion-safe", () => {
    expect(html).toContain("motion-safe:animate-pulse");
    // Never the bare class: that would keep moving for somebody who asked the
    // whole operating system to stop moving things.
    expect(html).not.toMatch(/class="[^"]*(?<!motion-safe:)animate-pulse/);
  });

  it("puts the animation on the dot and not on the label", () => {
    // The dot is the empty `aria-hidden` span; the label is the text node
    // beside it. Only the first may carry the class.
    const dot = html.slice(html.indexOf("aria-hidden"));
    expect(dot).toContain("motion-safe:animate-pulse");
    const outer = html.slice(0, html.indexOf("aria-hidden"));
    expect(outer).not.toContain("animate-pulse");
  });

  it("keeps the dot out of the accessible name", () => {
    expect(html).toContain('aria-hidden="true"');
  });

  it("is red without depending on the animation to say so", () => {
    expect(html).toContain("text-danger");
    expect(html).toContain("bg-danger");
  });
});

/**
 * The presenter's own truthful state after their screen publish drops. It is
 * NOT live and must not read as red "AO VIVO" — that was the 35-minute lie.
 */
describe("the reconnecting pill", () => {
  const html = renderToStaticMarkup(<LivePill variant="recovering" />);

  it("marks itself recovering, not live", () => {
    expect(html).toContain('data-watch-party-live-pill="recovering"');
  });

  it("is amber, never the live red", () => {
    expect(html).toContain("text-warning");
    expect(html).toContain("bg-warning");
    expect(html).not.toContain("text-danger");
    expect(html).not.toContain("bg-danger");
  });

  it("still pulses only the dot, only under motion-safe", () => {
    expect(html).toContain("motion-safe:animate-pulse");
    const outer = html.slice(0, html.indexOf("aria-hidden"));
    expect(outer).not.toContain("animate-pulse");
  });
});
