// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { renderBauPostEmbed, BAU_POST_EMBED_ID } from "@/lib/bau-post-meta";
import { takePublicPostEmbed } from "./public-post-embed";

const POST_ID = "aa11bb22-cc33-4dd4-8ee5-ff6677889900";

const ANSWER = {
  post: {
    id: POST_ID,
    title: "Patch </script><img src=x onerror=alert(1)>",
    body: "corpo & mais",
    teaser: null,
    media: null,
    posterUrl: null,
    coverUrl: null,
    likeCount: 1,
    commentCount: 0,
    publishedAt: null,
    channels: [],
    publicUrl: null,
  },
  community: {
    slug: "mesa-da-tues",
    name: "Mesa da Tues",
    tagline: null,
    category: "geral",
    memberCount: 3,
  },
};

/** Puts the embed in the document the way the browser would parse it. */
function mount(html: string): void {
  document.head.innerHTML = html;
}

describe("the post embedded by the edge", () => {
  afterEach(() => {
    document.head.innerHTML = "";
  });

  it("cannot be closed or confused by author-typed text", () => {
    const html = renderBauPostEmbed(ANSWER);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).not.toContain("<img");
    const inner = html.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    expect(inner).not.toMatch(/[<>&]/);
    expect(html).toContain('type="application/json"');
    expect(html).toContain(`id="${BAU_POST_EMBED_ID}"`);
    const lineSep = String.fromCharCode(0x2028);
    const paraSep = String.fromCharCode(0x2029);
    const hostile = renderBauPostEmbed({ x: `a${lineSep}b${paraSep}c` });
    expect(hostile).not.toContain(lineSep);
    expect(hostile).not.toContain(paraSep);
  });

  it("round-trips through the parser: what the edge wrote is what the page reads", () => {
    mount(renderBauPostEmbed(ANSWER));
    const taken = takePublicPostEmbed(document, "mesa-da-tues", POST_ID);
    expect(taken?.post.title).toBe("Patch </script><img src=x onerror=alert(1)>");
    expect(taken?.post.body).toBe("corpo & mais");
    // Nothing executed, nothing injected.
    expect(document.querySelector("img")).toBeNull();
  });

  it("is taken once: the block is gone after the first read", () => {
    mount(renderBauPostEmbed(ANSWER));
    expect(takePublicPostEmbed(document, "mesa-da-tues", POST_ID)).not.toBeNull();
    expect(document.getElementById(BAU_POST_EMBED_ID)).toBeNull();
    expect(takePublicPostEmbed(document, "mesa-da-tues", POST_ID)).toBeNull();
  });

  it("is ignored when it names another post or community, or is not what the schema says", () => {
    mount(renderBauPostEmbed(ANSWER));
    expect(takePublicPostEmbed(document, "mesa-da-tues", "11111111-2222-4333-8444-555555555555")).toBeNull();
    mount(renderBauPostEmbed(ANSWER));
    expect(takePublicPostEmbed(document, "outra-mesa", POST_ID)).toBeNull();
    mount(renderBauPostEmbed({ post: {}, community: {} }));
    expect(takePublicPostEmbed(document, "mesa-da-tues", POST_ID)).toBeNull();
    mount(`<script type="application/json" id="${BAU_POST_EMBED_ID}">{not json</script>`);
    expect(takePublicPostEmbed(document, "mesa-da-tues", POST_ID)).toBeNull();
    mount("");
    expect(takePublicPostEmbed(document, "mesa-da-tues", POST_ID)).toBeNull();
  });
});
