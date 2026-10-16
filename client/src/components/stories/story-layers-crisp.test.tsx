import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LayerBox, isCrispLayer, type DisplayLayer } from "./story-layers";

const text: DisplayLayer = {
  id: "t",
  type: "text",
  x: 0.5,
  y: 0.5,
  scale: 2.4,
  rotation: 0.3,
  text: "oi",
  font: "classic",
  color: "white",
  background: "none",
  align: "center",
  size: 1,
};

afterEach(() => vi.unstubAllGlobals());

describe("crisp scaled layers", () => {
  it("text, mentions and call cards scale by zoom; pictures keep the transform", () => {
    expect(isCrispLayer(text)).toBe(true);
    expect(isCrispLayer({ ...text, type: "mention", userId: "u", name: "n" } as DisplayLayer)).toBe(true);
    expect(isCrispLayer({ ...text, type: "call" } as DisplayLayer)).toBe(true);
    expect(isCrispLayer({ ...text, type: "image", src: "x", width: 1, height: 1, shape: "rect" } as DisplayLayer)).toBe(false);
    expect(isCrispLayer({ ...text, type: "drawing", src: "x" } as DisplayLayer)).toBe(false);
  });

  it("with zoom available, the scale leaves the transform and lands on an inner box", () => {
    vi.stubGlobal("CSS", { supports: () => true });
    const html = renderToStaticMarkup(
      <LayerBox layer={text} crisp>
        hi
      </LayerBox>,
    );
    expect(html).toContain("data-crisp");
    expect(html).toContain("zoom:2.4");
    expect(html).toContain("rotate(0.3rad)");
    expect(html).not.toContain("scale(2.4)");
  });

  it("without zoom, or at scale 1, or in the editor, nothing changes", () => {
    vi.stubGlobal("CSS", { supports: () => false });
    expect(renderToStaticMarkup(<LayerBox layer={text} crisp>hi</LayerBox>)).toContain("scale(2.4)");
    vi.stubGlobal("CSS", { supports: () => true });
    expect(renderToStaticMarkup(<LayerBox layer={{ ...text, scale: 1 }} crisp>hi</LayerBox>)).not.toContain("data-crisp");
    expect(renderToStaticMarkup(<LayerBox layer={text}>hi</LayerBox>)).toContain("scale(2.4)");
  });
});
