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

  it("keeps the volume variant interactive", () => {
    const html = renderToStaticMarkup(
      <Slider variant="volume" value={70} max={100} aria-label="Volume" />,
    );
    expect(html).toContain("data-slider=\"volume\"");
    expect(html).toContain("Volume");
    expect(html).not.toContain("data-readonly");
  });
});
