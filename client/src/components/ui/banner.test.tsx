// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { Banner, BannerAction, type BannerTone } from "@/components/ui/banner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function draw(element: ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => createRoot(host).render(element));
  return host;
}

/** The classes that apply with the toggle off: everything but `redesign:`. */
function offClasses(el: Element): string[] {
  return [...el.classList].filter((c) => !c.startsWith("redesign:")).sort();
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).sort();

describe("Banner with the toggle off draws the bar each strip drew", () => {
  it.each<[BannerTone, string]>([
    ["danger", "flex items-start gap-3 border-b border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger"],
    ["warning", "flex items-start gap-3 border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning"],
    ["success", "flex items-start gap-3 border-b border-success/40 bg-success/10 px-4 py-2 text-sm text-success"],
  ])("the App bars: %s", (tone, old) => {
    const host = draw(<Banner tone={tone}>x</Banner>);
    expect(offClasses(host.firstElementChild!)).toEqual(words(old));
  });

  it("the connection strip", () => {
    const host = draw(
      <Banner
        tone="warning"
        className="flex-wrap items-center justify-center gap-x-3 gap-y-1 border-warning/30 py-1.5 text-xs"
      >
        x
      </Banner>,
    );
    const off = offClasses(host.firstElementChild!);
    for (const c of words(
      "flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-warning/30 bg-warning/10 px-4 py-1.5 text-xs text-warning",
    )) {
      expect(off).toContain(c);
    }
    expect(off).not.toContain("items-start");
    expect(off).not.toContain("border-warning/40");
  });

  it("the sanction strip sits on the composer's edge", () => {
    const host = draw(
      <Banner tone="warning" edge="bottom" className="shrink-0 gap-2 border-warning/30 px-3 text-xs">
        x
      </Banner>,
    );
    expect(offClasses(host.firstElementChild!)).toEqual(
      words("flex shrink-0 items-start gap-2 border-t border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"),
    );
  });

  it("the dev strip stays a centred block", () => {
    const host = draw(
      <Banner tone="warning" role="note" className="block border-warning/30 px-3 py-1 text-center text-xs">
        x
      </Banner>,
    );
    const el = host.firstElementChild!;
    expect(el.getAttribute("role")).toBe("note");
    const off = offClasses(el);
    expect(off).toContain("block");
    expect(off).not.toContain("flex");
  });

  it("an action keeps the plain link, or the tone's fill", () => {
    const host = draw(
      <Banner tone="warning">
        <BannerAction>Dispensar</BannerAction>
        <BannerAction emphasis="fill">Tentar agora</BannerAction>
      </Banner>,
    );
    const [link, fill] = host.querySelectorAll("button");
    expect(offClasses(link!)).toEqual(words("shrink-0 text-xs underline underline-offset-2"));
    expect(offClasses(fill!)).toEqual(
      words("rounded-[var(--radius-control)] px-2 py-0.5 font-semibold bg-warning/20 hover:bg-warning/30"),
    );
    expect(link!.getAttribute("type")).toBe("button");
  });
});

describe("Banner under the redesign", () => {
  it("is an inset card on the tone's soft fill, with its icon", () => {
    const Glyph = (() => <svg data-glyph="" />) as never;
    const host = draw(
      <Banner tone="danger" icon={Glyph}>
        x
      </Banner>,
    );
    const el = host.firstElementChild!;
    expect(el.className).toContain("redesign:rounded-[var(--banner-radius)]");
    expect(el.className).toContain("redesign:[--banner-fill:var(--color-danger-soft)]");
    expect(el.className).toContain("redesign:text-text");
    expect(el.getAttribute("data-banner")).toBe("danger");
  });

  it("a bottom strip keeps its gap above the composer", () => {
    const host = draw(<Banner tone="warning" edge="bottom">x</Banner>);
    expect(host.firstElementChild!.className).toContain("redesign:mb-2");
  });
});
