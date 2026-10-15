import type { MessageForward } from "@pqp/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { ForwardCardView } from "./forward-card";

const ID = "11111111-1111-4111-8111-111111111111";

function forward(over: Partial<MessageForward> = {}): MessageForward {
  return {
    v: 1,
    kind: "bau_post",
    sourceServerId: ID,
    sourceServerName: "QG",
    sourceServerIconUrl: null,
    sourceId: ID,
    authorDisplayName: "Rafa",
    title: "Sessão 11",
    excerpt: "o clip inteiro, com tudo que rolou",
    url: `https://pqp.gg/app/server/${ID}/bau/${ID}`,
    createdAt: "2026-10-15T12:00:00.000Z",
    ...over,
  };
}

function render(value: MessageForward, external = false): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <ForwardCardView
        forward={value}
        href={value.url}
        external={external}
        onOpen={() => undefined}
      />
    </I18nProvider>,
  );
}

describe("ForwardCardView", () => {
  it("names where it came from, the title, the excerpt and the author", () => {
    const html = render(forward());
    expect(html).toContain("data-forward-card");
    expect(html).toContain("QG");
    expect(html).toContain("Sessão 11");
    expect(html).toContain("o clip inteiro, com tudo que rolou");
    expect(html).toContain("Rafa");
    // A Baú post says Baú; the excerpt clamps to three lines.
    expect(html).toContain("Baú");
    expect(html).toContain("line-clamp-3");
  });

  it("a message names its channel and has no title line", () => {
    const html = render(
      forward({ kind: "message", title: undefined, sourceChannelName: "geral" }),
    );
    expect(html).toContain("#geral");
    expect(html).not.toContain("data-forward-title");
  });

  it("is plain text: markup in the snapshot is escaped, never a link or a mention", () => {
    const html = render(
      forward({ title: "<img src=x onerror=alert(1)>", excerpt: "@everyone <b>oi</b>" }),
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;oi&lt;/b&gt;");
    // The only link is the card itself.
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it("shows a thumbnail only when the snapshot holds a stable one, else a kind chip", () => {
    const withThumb = render(
      forward({
        mediaKind: "youtube",
        mediaThumbUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      }),
    );
    expect(withThumb).toContain("data-forward-thumb");
    expect(withThumb).not.toContain("data-forward-media-chip");

    const noThumb = render(forward({ mediaKind: "image" }));
    expect(noThumb).not.toContain("data-forward-thumb");
    expect(noThumb).toContain("data-forward-media-chip");
  });

  it("an off-instance link opens a new tab with no opener", () => {
    const html = render(forward({ url: "https://example.com/x" }), true);
    expect(html).toContain('target="_blank"');
    expect(html).toContain("noopener");
    expect(render(forward())).not.toContain('target="_blank"');
  });

  it("a restricted card says so", () => {
    expect(render(forward({ restricted: true }))).toContain("Members of that server only");
  });
});
