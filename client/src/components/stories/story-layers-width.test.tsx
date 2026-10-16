// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StoryCallLive } from "@pqp/shared";
import { layerStyle } from "@/lib/stories/layers";
import { StoryContent, type StoryDisplay } from "./story-content";
import { layerBoxStyle, type DisplayLayer } from "./story-layers";

const ana = { id: "a1", displayName: "Ana Souza", avatarUrl: null, handle: null };
const live = (): StoryCallLive => ({
  serverId: "11111111-1111-4111-8111-111111111111",
  channelId: "22222222-2222-4222-8222-222222222222",
  channelName: "Lobby",
  participants: [ana],
  count: 1,
  state: "live",
  joinable: true,
});
const geometry = { x: 0.5, y: 0.5, scale: 1, rotation: 0 };
const baseDisplay: StoryDisplay = {
  id: "s1",
  kind: "text",
  text: null,
  background: "night",
  caption: null,
  mediaUrl: null,
  posterUrl: null,
  call: null,
};

describe("a layer's width does not depend on where it sits", () => {
  // jsdom has no layout, so this pins the CSS that makes the width independent of `left`; the real
  // geometry at 390x844 and 1440x900 is `e2e/stories-editor.spec.ts`. The bug it guards: an
  // absolutely positioned box with an auto width shrinks to the room left before the container's
  // right edge, so a photo at x = 0.8 drew at 0.20 of the canvas instead of 0.40.
  const XS = [0.1, 0.5, 0.8, 0.95];
  const at = (x: number): DisplayLayer[] => [
    { ...geometry, x, id: "t", type: "text", text: "uma frase bem comprida que quebra em varias linhas", font: "bold", color: "white", background: "none", align: "center", size: 1 },
    { ...geometry, x, id: "i", type: "image", src: "https://example.test/x.png", width: 1080, height: 810, shape: "rect" },
    { ...geometry, x, id: "m", type: "mention", userId: "u1", name: "Bia", avatarUrl: null },
    { ...geometry, x, id: "c", type: "call" },
  ];
  const widths = (x: number) => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<StoryContent story={{ ...baseDisplay, kind: "text", mediaUrl: null, background: "night", call: live(), layers: at(x) }} />);
    const out: Record<string, { box: string; inner: string; maxWidth: string }> = {};
    for (const id of ["t", "i", "m", "c"]) {
      const box = host.querySelector<HTMLElement>(`[data-story-layer="${id}"]`)!;
      const inner = box.firstElementChild as HTMLElement;
      out[id] = {
        box: getComputedStyle(box).width,
        inner: getComputedStyle(inner).width,
        maxWidth: getComputedStyle(inner).maxWidth,
      };
      expect(getComputedStyle(box).left).toBe(`${x * 100}%`);
    }
    return out;
  };

  it("gives every layer type the same width style at x = 0.1, 0.5, 0.8 and 0.95", () => {
    const reference = widths(0.5);
    for (const x of XS) {
      expect(widths(x)).toEqual(reference);
    }
  });

  it("sizes a layer's box from its content, never from the room left to the right edge", () => {
    for (const layer of at(0.8)) {
      expect(layerBoxStyle(layer).width, layer.type).toBe("max-content");
    }
    expect(layerStyle({ ...geometry, id: "edit", x: 0.95 }).width).toBe("max-content");
  });

  it("keeps a photo at 40cqw, uncapped by the reset's max-width: 100% of a shrunken box", () => {
    const photo = widths(0.95)["i"];
    expect(photo.inner).toBe("40cqw");
    expect(photo.maxWidth).toBe("none");
  });

  it("keeps the call card at 82cqw wherever it sits (text wraps at 84cqw by .story-tl, measured in the e2e)", () => {
    expect(widths(0.95)["c"].inner).toBe("82cqw");
  });

  it("a drawing still covers the whole canvas", () => {
    const drawing: DisplayLayer = { ...geometry, x: 0.95, id: "d", type: "drawing", src: "https://example.test/d.png" };
    expect(layerBoxStyle(drawing)).toMatchObject({ width: "100cqw", height: "100cqh" });
  });
});
