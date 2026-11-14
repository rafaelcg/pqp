import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Slider } from "@/components/ui/slider";

describe("Slider", () => {
  it("draws a read-only scrubber as a progress bar", () => {
    const html = renderToStaticMarkup(
      <Slider variant="scrub" readOnly value={30} max={100} aria-label="Andamento" />,
    );
    expect(html).toContain("role=\"progressbar\"");
    expect(html).toContain("data-readonly");
    expect(html).toContain("Andamento");
    expect(html).toContain("aria-valuenow=\"30\"");
  });

  it("draws an indeterminate scrubber as a track with no fill", () => {
    const html = renderToStaticMarkup(
      <Slider
        variant="scrub"
        readOnly
        indeterminate
        value={0}
        max={1}
        aria-label="Andamento"
      />,
    );
    expect(html).toContain("data-indeterminate");
    expect(html).not.toContain("aria-valuenow");
    expect(html).not.toContain("bg-accent");
  });

  it("keeps the volume variant interactive", () => {
    const html = renderToStaticMarkup(
      <Slider variant="volume" value={70} max={100} aria-label="Volume" />,
    );
    expect(html).toContain("data-slider=\"volume\"");
    expect(html).toContain("Volume");
    expect(html).not.toContain("data-readonly");
  });

  it("names the thumb, the element a screen reader calls a slider", () => {
    const html = renderToStaticMarkup(
      <Slider value={12} max={40} aria-label="Posição" aria-valuetext="0:12 / 0:40" />,
    );
    const thumb = /<span[^>]*role="slider"[^>]*>/.exec(html)?.[0] ?? "";
    expect(thumb).toContain('aria-label="Posição"');
    expect(thumb).toContain('aria-valuetext="0:12 / 0:40"');
  });

  it("draws the compact-player edge as a square top fill", () => {
    const html = renderToStaticMarkup(
      <Slider variant="edge" readOnly value={40} max={100} aria-label="Andamento" />,
    );
    expect(html).toContain("data-slider=\"edge\"");
    expect(html).toContain("bg-border");
    expect(html).not.toContain("rounded-full");
  });

  it("draws today's track and thumb when the tokens are unset", () => {
    const html = renderToStaticMarkup(
      <Slider variant="volume" value={70} max={100} aria-label="Volume" />,
    );
    expect(html).toContain("h-[var(--slider-volume-h,0.25rem)]");
    expect(html).toContain("bg-[color:var(--slider-track,var(--color-surface-3))]");
    const thumb = /<span[^>]*role="slider"[^>]*>/.exec(html)?.[0] ?? "";
    expect(thumb).toContain("size-[var(--slider-thumb,0.75rem)]");
    expect(thumb).toContain("bg-[color:var(--slider-thumb-bg,var(--color-text))]");
    expect(thumb).toContain("border-[color:var(--slider-thumb-border,var(--color-border-strong))]");
    expect(thumb).toContain("shadow-[var(--slider-thumb-shadow,0_0_transparent)]");
  });

  it("thickens a scrub track on hover and focus only under the redesign", () => {
    const html = renderToStaticMarkup(
      <Slider variant="scrub" value={20} max={100} aria-label="Andamento" />,
    );
    expect(html).toContain("h-[var(--slider-scrub-h,0.125rem)]");
    expect(html).toContain("redesign:group-hover:h-[var(--slider-scrub-h-hover)]");
    expect(html).toContain("redesign:group-focus-within:h-[var(--slider-scrub-h-hover)]");
    expect(html).not.toMatch(/(^|\s)group-hover:h-/);
  });

  it("fades a disabled slider through a token, 0.4 by default", () => {
    const html = renderToStaticMarkup(
      <Slider variant="volume" value={70} max={100} disabled aria-label="Volume" />,
    );
    expect(html).toContain("data-[disabled]:opacity-[var(--slider-disabled-opacity,0.4)]");
  });

  it("keeps the hue thumb in the accent with its on-accent rim", () => {
    const html = renderToStaticMarkup(
      <Slider variant="hue" value={96} max={360} aria-label="Matiz" />,
    );
    const thumb = /<span[^>]*role="slider"[^>]*>/.exec(html)?.[0] ?? "";
    expect(thumb).toContain("size-[var(--slider-thumb-hue,1rem)]");
    expect(thumb).toContain("border-on-accent");
    expect(thumb).toContain("bg-accent");
    expect(thumb).not.toContain("bg-[color:var(--slider-thumb-bg");
    // twMerge keeps the variant's disabled fill over the base's grey one.
    expect(thumb).toContain("redesign:group-data-[disabled]:bg-accent");
    expect(thumb).not.toContain("--slider-thumb-disabled-bg");
  });

  it("keeps a read-only scrub thin on hover, so it never looks seekable", () => {
    const html = renderToStaticMarkup(
      <Slider variant="scrub" readOnly value={30} max={100} aria-label="Andamento" />,
    );
    expect(html).toContain("redesign:group-data-[readonly]:h-[var(--slider-scrub-h)]");
  });

  it("grows the knob while the slider is held anywhere, and rings in the slider token", () => {
    const html = renderToStaticMarkup(
      <Slider variant="volume" value={70} max={100} aria-label="Volume" />,
    );
    const thumb = /<span[^>]*role="slider"[^>]*>/.exec(html)?.[0] ?? "";
    expect(thumb).toContain("redesign:group-active:scale-[var(--slider-thumb-press)]");
    expect(thumb).toContain("focus-visible:ring-[color:var(--slider-ring,var(--color-focus-ring))]");
    expect(thumb).toContain("redesign:focus-visible:ring-offset-[color:var(--slider-ring-offset-color)]");
    expect(thumb).toContain("redesign:group-data-[disabled]:bg-[color:var(--slider-thumb-disabled-bg,var(--slider-thumb-bg))]");
  });

  it("keeps the edge knob at its old size", () => {
    const html = renderToStaticMarkup(
      <Slider variant="edge" value={40} max={100} aria-label="Andamento" />,
    );
    expect(html).toContain("size-[var(--slider-thumb-edge,0.75rem)]");
  });
});
