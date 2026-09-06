import { renderToStaticMarkup } from "react-dom/server";
import type { Channel } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import { ChannelIcon, isChannelImageUrl } from "./channel-icon";

const BASE: Channel = {
  id: "11111111-1111-4111-8111-111111111111",
  serverId: "22222222-2222-4222-8222-222222222222",
  kind: "server",
  name: "general",
  type: "text",
  position: 0,
  isPrivate: false,
  topic: null,
  imageUrl: null,
  parentId: null,
  slowmodeSeconds: 0,
  voiceTransport: null,
};

describe("isChannelImageUrl", () => {
  it("accepts absolute http(s) URLs and root-relative paths", () => {
    expect(isChannelImageUrl("https://cdn.example.com/a.png")).toBe(true);
    expect(isChannelImageUrl("http://cdn.example.com/a.png")).toBe(true);
    expect(isChannelImageUrl("/local/a.png")).toBe(true);
  });

  it("rejects an emoji or short label — the pre-existing icon shorthand", () => {
    expect(isChannelImageUrl("📡")).toBe(false);
    expect(isChannelImageUrl("chat")).toBe(false);
  });
});

describe("ChannelIcon", () => {
  // Most channels never set an image, so this is the common case, not the
  // edge case — it has to look like a deliberate default, not a blank slot.
  it("falls back to the hash glyph for a public text channel with no image", () => {
    const html = renderToStaticMarkup(<ChannelIcon channel={BASE} />);
    expect(html).toContain("lucide-hash");
    expect(html).not.toContain("<img");
  });

  it("falls back to the mic glyph for a voice channel with no image", () => {
    const html = renderToStaticMarkup(
      <ChannelIcon channel={{ ...BASE, type: "voice" }} />,
    );
    expect(html).toContain("lucide-mic");
  });

  it("falls back to the lock glyph for a private channel with no image", () => {
    const html = renderToStaticMarkup(
      <ChannelIcon channel={{ ...BASE, isPrivate: true }} />,
    );
    expect(html).toContain("lucide-lock");
  });

  it("renders an https image as an <img>, not the fallback glyph", () => {
    const html = renderToStaticMarkup(
      <ChannelIcon
        channel={{ ...BASE, imageUrl: "https://cdn.example.com/a.png" }}
      />,
    );
    expect(html).toContain('src="https://cdn.example.com/a.png"');
    expect(html).not.toContain("lucide-hash");
  });

  it("sends no referrer with the image request", () => {
    // A hostile channel image is one credible way to run a tracking pixel
    // against everyone in the server; stripping the referrer at least keeps
    // it from also learning which page linked to it.
    const html = renderToStaticMarkup(
      <ChannelIcon
        channel={{ ...BASE, imageUrl: "https://cdn.example.com/a.png" }}
      />,
    );
    expect(html).toContain('referrerPolicy="no-referrer"');
  });

  it("renders a short emoji icon as text, not an <img>", () => {
    const html = renderToStaticMarkup(
      <ChannelIcon channel={{ ...BASE, imageUrl: "📡" }} />,
    );
    expect(html).toContain("📡");
    expect(html).not.toContain("<img");
  });
});
