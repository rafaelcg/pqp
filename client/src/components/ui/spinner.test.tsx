import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";

describe("Spinner", () => {
  it("draws the Lucide glyph with the toggle off and the ring under the redesign, both with the caller's classes", () => {
    const html = renderToStaticMarkup(<Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />);
    const classes = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]);
    expect(classes).toHaveLength(2);
    expect(classes[0]).toContain("lucide");
    expect(classes[0]).toContain("h-3.5 w-3.5 motion-safe:animate-spin redesign:hidden");
    // The ring keeps the size and drops the caller's motion: it owns its own.
    expect(classes[1]).toMatch(/^h-3\.5 w-3\.5 hidden redesign:block/);
    expect(classes[1]).not.toMatch(/(^| )(motion-safe:)?animate-spin/);
    expect(classes[1]).toContain("redesign:motion-safe:animate-spin");
    expect(classes[1]).toContain("redesign:motion-reduce:animate-pulse");
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(2);
  });

  it("drops a bare animate-spin from the ring, so the reduced-motion pulse never depends on CSS order", () => {
    const html = renderToStaticMarkup(<Spinner className="h-4 w-4 animate-spin text-accent" />);
    const ring = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1])[1]!;
    expect(ring).toContain("h-4 w-4 text-accent");
    expect(ring.split(" ").filter((name) => /(^|:)animate-/.test(name) && !name.startsWith("redesign:"))).toEqual([]);
    expect(ring).toContain("redesign:min-h-3.5 redesign:min-w-3.5");
  });

  it("names itself for a screen reader only when given a label", () => {
    expect(renderToStaticMarkup(<Spinner />)).not.toContain("sr-only");
    expect(renderToStaticMarkup(<Spinner label="Buscando" />)).toContain('<span class="sr-only">Buscando</span>');
  });
});

describe("Skeleton", () => {
  it("keeps today's wash and takes a text tint under the redesign", () => {
    const html = renderToStaticMarkup(<Skeleton className="h-3 w-12" />);
    expect(html).toContain("bg-surface-3/50");
    expect(html).toContain("redesign:bg-[color:var(--skeleton-bg)]");
    expect(html).toContain("redesign:motion-reduce:animate-none");
  });
});
