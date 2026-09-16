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

  it("draws the compact-player edge as a square top fill", () => {
    const html = renderToStaticMarkup(
      <Slider variant="edge" readOnly value={40} max={100} aria-label="Andamento" />,
    );
    expect(html).toContain("data-slider=\"edge\"");
    expect(html).toContain("rounded-none");
    expect(html).toContain("bg-border");
  });
});
