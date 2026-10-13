import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StoryCallLive, StoryLayer } from "@pqp/shared";
import en from "@/locales/en/translation.json";
import { StoryCallCard, callCardState } from "./story-call-card";
import { StoryContent, type StoryDisplay } from "./story-content";
import { displayLayerFrom, type DisplayLayer } from "./story-layers";

const SERVER = "11111111-1111-4111-8111-111111111111";
const CHANNEL = "22222222-2222-4222-8222-222222222222";
const ana = { id: "a1", displayName: "Ana Souza", avatarUrl: null, handle: null };
const bia = { id: "b1", displayName: "Bia", avatarUrl: null, handle: null };

function live(patch: Partial<StoryCallLive> = {}): StoryCallLive {
  return {
    serverId: SERVER,
    channelId: CHANNEL,
    channelName: "Lobby",
    participants: [ana, bia],
    count: 2,
    state: "live",
    joinable: true,
    ...patch,
  };
}

const geometry = { x: 0.5, y: 0.5, scale: 1, rotation: 0 };
const baseDisplay: StoryDisplay = {
  id: "s1",
  kind: "image",
  text: null,
  background: null,
  caption: null,
  mediaUrl: "https://example.test/p.jpg",
  posterUrl: null,
  call: null,
};

describe("callCardState", () => {
  it("is live with people in, empty with nobody, and the server's word for full and ended", () => {
    expect(callCardState(live(), 2)).toBe("live");
    expect(callCardState(live({ count: 0, participants: [] }), 0)).toBe("empty");
    expect(callCardState(live({ state: "full" }), 2)).toBe("full");
    expect(callCardState(live({ state: "ended", count: 0, participants: [] }), 0)).toBe("ended");
  });

  it("reads the author's preview by how many people are in the room now", () => {
    expect(callCardState(null, 0)).toBe("empty");
    expect(callCardState(null, 3)).toBe("live");
  });
});

describe("StoryCallCard", () => {
  const server = { name: "QG do pqp", iconUrl: null };
  const render = (call: StoryCallLive | null, preview = null as { channelName: string; names: string[]; authorAway?: boolean } | null) =>
    renderToStaticMarkup(<StoryCallCard call={call} preview={preview} server={server} onJoin={() => {}} />);

  it("a live room: the room and server, the faces, the count, a pulsing dot and Entrar", () => {
    const html = render(live());
    expect(html).toContain("Lobby");
    expect(html).toContain("QG do pqp");
    expect(html).toContain("story-live-dot");
    expect(html).toContain('data-story-call-faces=""');
    expect(html).toContain("2 in the call");
    expect(html).toContain('data-story-join=""');
    expect(html).toContain(en["stories.call.enter"]);
  });

  it("an empty room says so and does not pulse", () => {
    const html = render(live({ count: 0, participants: [] }));
    expect(html).toContain(en["stories.call.empty"]);
    expect(html).not.toContain("story-live-dot");
    expect(html).not.toContain('data-story-call-faces=""');
  });

  it("an ended room is a quiet card with no button and no faces", () => {
    const html = render(live({ state: "ended", count: 0, participants: [], joinable: false }));
    expect(html).toContain(en["stories.call.ended"]);
    expect(html).toContain('data-story-call-state="ended"');
    expect(html).not.toContain('data-story-join=""');
    expect(html).not.toContain('data-story-call-faces=""');
  });

  it("a full room offers no way in", () => {
    const html = render(live({ state: "full", joinable: false }));
    expect(html).toContain(en["stories.call.full"]);
    expect(html).not.toContain('data-story-join=""');
  });

  it("a room the viewer may not connect to has no button either", () => {
    expect(render(live({ joinable: false }))).not.toContain('data-story-join=""');
  });

  it("falls back to the first letter when the server has no icon", () => {
    expect(render(live())).toContain(">Q<");
  });

  it("shows the author's preview with initials and the button the card will have", () => {
    const html = render(null, { channelName: "Sala", names: ["Ana", "Bia"] });
    expect(html).toContain("Sala");
    expect(html).toContain("2 in the call");
    expect(html).toContain(en["stories.call.enter"]);
  });

  it("shows the author's preview as viewers will see it: over, when the author is not in the room", () => {
    const html = render(null, { channelName: "Sala", names: ["Bia"], authorAway: true });
    expect(html).toContain('data-story-call-state="ended"');
    expect(html).toContain(en["stories.call.ended"]);
    expect(html).not.toContain("story-live-dot");
  });

  it("sizes everything in canvas units, so it is the same card at any size", () => {
    const html = render(live());
    expect(html).toMatch(/cqw/);
    expect(html).not.toMatch(/font-size:\d+(\.\d+)?px/);
  });

  it("keeps the story's own accent, never the theme's", () => {
    const html = render(live());
    expect(html).toContain("var(--story-accent)");
    expect(html).not.toMatch(/\btext-accent\b|\bbg-accent\b/);
  });
});

describe("StoryContent layers", () => {
  const text: DisplayLayer = {
    ...geometry,
    id: "t1",
    type: "text",
    text: "bora de cs?",
    font: "bold",
    color: "lime",
    background: "solid",
    align: "left",
    size: 1.5,
  };
  const render = (story: Partial<StoryDisplay>, props: Record<string, unknown> = {}) =>
    renderToStaticMarkup(<StoryContent story={{ ...baseDisplay, ...story }} {...props} />);

  it("draws a layer where it was put: its center, then scale and rotation about it", () => {
    const html = render({ layers: [{ ...text, x: 0.25, y: 0.75, scale: 2, rotation: 0.5 }] });
    expect(html).toContain("left:25%");
    expect(html).toContain("top:75%");
    expect(html).toContain("rotate(0.5rad) scale(2)");
    expect(html).toContain("bora de cs?");
  });

  it("fits the 9:16 canvas INSIDE the card, so a tall phone never crops what the author placed", () => {
    const html = render({ layers: [text] });
    expect(html).toContain("data-story-layer-canvas");
    expect(html).toContain("aspect-ratio:9 / 16");
    expect(html).toContain("min(100cqw, calc(100cqh * 9 / 16))");
    expect(html).not.toContain("max(100cqw");
  });

  it("sets text in the layer's own font, color, background, alignment and size", () => {
    const html = render({ layers: [text] });
    expect(html).toContain('data-font="bold"');
    expect(html).toContain('data-color="lime"');
    expect(html).toContain('data-bg="solid"');
    expect(html).toContain("--tl-align:left");
    expect(html).toContain("--tl-size:1.5");
  });

  it("draws the words once: a story with text layers hides the caption and text copies older builds read", () => {
    const html = render({ caption: "bora de cs?", layers: [text] });
    expect(html.match(/bora de cs\?/g)).toHaveLength(1);
  });

  it("a story from before layers still shows its caption", () => {
    expect(render({ caption: "tudo bem?" })).toContain("tudo bem?");
  });

  it("a text card from before layers still shows its text", () => {
    const html = render({ kind: "text", text: "salve", background: "grape" });
    expect(html).toContain("salve");
  });

  it("draws the live call card from the call layer, and only once", () => {
    const html = render({ call: live(), layers: [{ ...geometry, id: "c1", type: "call" }] });
    expect(html.match(/data-story-call-state=/g)).toHaveLength(1);
    expect(html).toContain("Lobby");
  });

  it("an older story with a call and no call layer still gets its card", () => {
    const html = render({ kind: "text", background: "lime", text: "bora?", call: live() });
    expect(html.match(/data-story-call-state=/g)).toHaveLength(1);
  });

  it("a mention is a button in the viewer and a plain chip elsewhere", () => {
    const mention: DisplayLayer = { ...geometry, id: "m1", type: "mention", userId: "u1", name: "Bia", avatarUrl: null };
    const tappable = render({ layers: [mention] }, { onOpenMention: () => {} });
    expect(tappable).toMatch(/<button[^>]*data-story-mention/);
    expect(render({ layers: [mention] })).not.toMatch(/<button[^>]*data-story-mention/);
    // A frozen card (a thumbnail, the outgoing deck card) is never tappable.
    expect(render({ layers: [mention] }, { onOpenMention: () => {}, still: true })).not.toMatch(/<button/);
  });

  it("gives a screen reader the story: the alt text on a photo, and as the card's name on all of them", () => {
    const photo = render({ altText: "Um gato no sofá" });
    expect(photo).toContain('alt="Um gato no sofá"');
    expect(photo).toContain('role="group" aria-label="Um gato no sofá"');
    const card = render({ kind: "text", background: "night", altText: "bora de cs?", layers: [text] });
    expect(card).toContain('aria-label="bora de cs?"');
    // A label, not a second copy of the words: they are on the page once.
    expect(card.match(/bora de cs\?/g)).toHaveLength(2);
    expect(render({})).not.toContain("aria-label=");
  });

  it("draws only the base when asked (the editor draws its own layers)", () => {
    expect(render({ layers: [text] }, { withLayers: false })).not.toContain("bora de cs?");
  });

  it("does not let a photo or drawing layer catch the pointer, so taps still go to the story", () => {
    const image: DisplayLayer = { ...geometry, id: "i1", type: "image", src: "https://example.test/x.png", width: 100, height: 100, shape: "circle" };
    const html = render({ layers: [image] });
    expect(html).toContain("pointer-events:none");
    expect(html).toContain("border-radius:50%");
  });
});

describe("StoryContent base fit", () => {
  const render = (story: Partial<StoryDisplay>) =>
    renderToStaticMarkup(<StoryContent story={{ ...baseDisplay, ...story }} />);

  it("fills the canvas with a picture that is 9:16, or within 12% of it", () => {
    for (const [w, h] of [[1080, 1920], [1080, 2160], [1000, 1700]] as const) {
      const html = render({ mediaWidth: w, mediaHeight: h });
      // The picture fills the canvas; its blurred copy only shows on a card that is not 9:16
      // (a container query), so it is not marked as always on.
      expect(html).not.toContain("data-always");
      expect(html).toContain("object-cover");
      expect(html).not.toContain("object-contain");
    }
  });

  it("shows a landscape photo whole, inside the canvas, over a blurred copy of itself", () => {
    const html = render({ mediaWidth: 1920, mediaHeight: 1080 });
    expect(html).toContain("data-story-base-blur");
    expect(html).toContain("data-always");
    expect(html).toContain("blur-[28px]");
    expect(html).toContain("object-contain");
    expect(html).toContain("min(100cqw, calc(100cqh * 9 / 16))");
  });

  it("fills a card that is not 9:16 with the blurred picture even when the picture fills the canvas", () => {
    const html = render({ mediaWidth: 1080, mediaHeight: 1920 });
    expect(html).toContain("data-story-base-blur");
    expect(html).toContain("story-backdrop");
  });

  it("fills around a text card's canvas with its own background, not the camera of anything", () => {
    const html = render({ kind: "text", mediaUrl: null, background: "grape", text: "salve" });
    expect(html).toContain('class="story-text-card absolute inset-0" data-bg="grape"');
    expect(html).not.toContain("data-story-base-blur");
  });

  it("an unknown size fills, as every story from before this did", () => {
    expect(render({})).not.toContain("data-always");
  });

  it("shows a landscape poster whole, over the poster blurred (a video's blurred copy is its poster)", () => {
    const html = render({ kind: "video", posterUrl: "https://example.test/p.jpg", mediaWidth: 1920, mediaHeight: 1080 });
    expect(html).toContain("object-contain");
    expect(html).toContain("data-always");
  });

  it("a video with no poster has nothing to blur: the card's own dark shows around it", () => {
    const html = render({ kind: "video", posterUrl: null, mediaUrl: null, mediaWidth: 1920, mediaHeight: 1080 });
    expect(html).not.toContain("data-story-base-blur");
  });
});

describe("displayLayerFrom", () => {
  it("maps what the server sends, mention name and photo url included", () => {
    const mention: StoryLayer = {
      ...geometry,
      id: "00000000-0000-4000-8000-000000000001",
      type: "mention",
      userId: "00000000-0000-4000-8000-000000000002",
      user: { id: "00000000-0000-4000-8000-000000000002", displayName: "Bia", avatarUrl: null, handle: null },
    };
    expect(displayLayerFrom(mention)).toMatchObject({ type: "mention", name: "Bia" });
    const image: StoryLayer = {
      ...geometry,
      id: "00000000-0000-4000-8000-000000000003",
      type: "image",
      shape: "rounded",
      url: "https://example.test/i.png",
      width: 10,
      height: 20,
    };
    expect(displayLayerFrom(image)).toMatchObject({ type: "image", src: "https://example.test/i.png", shape: "rounded" });
  });
});
