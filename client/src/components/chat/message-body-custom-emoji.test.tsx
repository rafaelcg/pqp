import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ServerEmojiList } from "@pqp/shared";
import { CustomEmojiProvider } from "./custom-emoji";
import { MessageBody } from "./message-body";
import { setServerEmojiList } from "@/lib/server-emoji";

const SERVER = "11111111-1111-4111-8111-111111111111";
const POG = "3f2a1c9e-0b1d-4c5e-8f6a-7b8c9d0e1f2a";
const GONE = "7b8c9d0e-1f2a-4c5e-8f6a-3f2a1c9e0b1d";

const LIST: ServerEmojiList = {
  emoji: [
    {
      id: POG,
      serverId: SERVER,
      name: "pog",
      url: `/api/emoji/${POG}?v=abcd1234`,
      createdBy: null,
      createdAt: "2026-10-12T00:00:00.000Z",
    },
  ],
  limit: 50,
  uploadEnabled: true,
  maxBytes: 262144,
  size: 128,
};

setServerEmojiList(SERVER, LIST);

function render(body: string, serverId: string | null = SERVER) {
  return renderToStaticMarkup(
    <CustomEmojiProvider serverId={serverId}>
      <MessageBody body={body} currentUsername={null} />
    </CustomEmojiProvider>,
  );
}

describe("custom emoji in a message", () => {
  it("draws a known token as the server's picture, with :name: as its text", () => {
    const html = render(`gg <:pog:${POG}> wp`);
    expect(html).toMatch(new RegExp(`<img[^>]+src="[^"]*/api/emoji/${POG}\\?v=abcd1234"`));
    expect(html).toContain('alt=":pog:"');
    expect(html).toContain("gg ");
    expect(html).not.toContain("&lt;:pog:");
  });

  it("shows an emoji this server no longer has as :name: text", () => {
    const html = render(`<:kek:${GONE}>`);
    expect(html).not.toContain("<img");
    expect(html).toContain(":kek:");
  });

  it("shows every token as text outside a server", () => {
    const html = render(`<:pog:${POG}>`, null);
    expect(html).not.toContain("<img");
    expect(html).toContain(":pog:");
  });

  it("leaves a token inside code literal", () => {
    const html = render(`\`<:pog:${POG}>\``);
    expect(html).not.toContain("<img");
    expect(html).toContain("<code>");
  });

  it("never turns markdown image syntax into an image", () => {
    const html = render(`![x](https://evil.example/p.png) <:pog:${POG}>`);
    expect(html).not.toContain("evil.example/p.png\"");
    expect(html.match(/<img/g)).toHaveLength(1);
  });

  it("keeps mentions working beside an emoji", () => {
    const html = render(`@rafa <:pog:${POG}>`);
    expect(html).toContain("pqp-mention");
    expect(html).toContain("<img");
  });
});
