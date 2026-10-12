import { describe, expect, it } from "vitest";
import {
  canonicalItemLink,
  deriveWebhookPostTitle,
  foldTagName,
  resolveWebhookTags,
  webhookDedupeKey,
} from "./forum-webhooks.js";

/**
 * The pure halves of forum PR 4: the title a feed item gets, how its tags
 * resolve, and the dedupe key. The HTTP path is `api/forum-webhooks.test.ts`.
 */

describe("deriveWebhookPostTitle", () => {
  it("prefers thread_name, trimmed and flattened", () => {
    expect(
      deriveWebhookPostTitle({ thread_name: "  Patch\n 1.4  ", content: "outra coisa" }),
    ).toBe("Patch 1.4");
  });

  it("cuts at 100 code points and never splits an emoji", () => {
    const title = deriveWebhookPostTitle({ thread_name: `${"a".repeat(99)}🎮🎮`, content: "x" });
    expect(Array.from(title!)).toHaveLength(100);
    expect(title!.endsWith("🎮")).toBe(true);
  });

  it("a blank thread_name falls back to the embed title, then to content", () => {
    expect(
      deriveWebhookPostTitle({ thread_name: "   ", embeds: [{ title: "Do embed" }], content: "x" }),
    ).toBe("Do embed");
    expect(deriveWebhookPostTitle({ thread_name: null, content: "Linha um\nlinha dois" })).toBe(
      "Linha um",
    );
  });

  it("reads a headline out of markdown: heading marks, bold, links", () => {
    expect(deriveWebhookPostTitle({ content: "## Nova versão\ncorpo" })).toBe("Nova versão");
    expect(deriveWebhookPostTitle({ content: "**Patch notes**\nhttps://x.example.com" })).toBe(
      "Patch notes",
    );
    expect(
      deriveWebhookPostTitle({ content: "[Trailer novo](https://x.example.com/t) saiu" }),
    ).toBe("Trailer novo saiu");
    expect(deriveWebhookPostTitle({ content: "> citação no topo" })).toBe("citação no topo");
  });

  it("skips a line that is only a link", () => {
    expect(
      deriveWebhookPostTitle({ content: "https://x.example.com/a\n<https://x.example.com/b>\nO título" }),
    ).toBe("O título");
  });

  it("is null when nothing is a headline", () => {
    expect(deriveWebhookPostTitle({ embeds: [{ description: "só descrição" }] })).toBeNull();
    expect(deriveWebhookPostTitle({ content: "https://x.example.com" })).toBeNull();
  });

  it("cleans control characters instead of refusing", () => {
    expect(deriveWebhookPostTitle({ thread_name: "a\u0000b\u0007c" })).toBe("a b c");
  });
});

describe("resolveWebhookTags", () => {
  const forumTags = [
    { id: "11111111-1111-4111-8111-111111111111", name: "Notícias", moderated: false },
    { id: "22222222-2222-4222-8222-222222222222", name: "Lançamento", moderated: false },
    { id: "33333333-3333-4333-8333-333333333333", name: "Oficial", moderated: true },
    { id: "44444444-4444-4444-8444-444444444444", name: "Dúvida", moderated: false },
    { id: "55555555-5555-4555-8555-555555555555", name: "Bug", moderated: false },
    { id: "66666666-6666-4666-8666-666666666666", name: "Guia", moderated: false },
    { id: "77777777-7777-4777-8777-777777777777", name: "Evento", moderated: false },
  ];
  const [noticias, lancamento, oficial, duvida, bug, guia, evento] = forumTags.map((tag) => tag.id);
  const open = { allowedTagIds: null, defaultTagIds: [], dedupeWindowHours: 72 };

  it("matches ids and names, whatever the case and accents", () => {
    expect(
      resolveWebhookTags([noticias!.toUpperCase(), " lancamento "], forumTags, open),
    ).toEqual({ tagIds: [noticias, lancamento], ignored: [] });
    expect(foldTagName("  LANÇAMENTO ")).toBe("lancamento");
  });

  it("ignores unknown entries, numbers included, and a staff-only tag by default", () => {
    expect(resolveWebhookTags([1092873465, "Oficial", "nada"], forumTags, open)).toEqual({
      tagIds: [],
      ignored: ["1092873465", "Oficial", "nada"],
    });
  });

  it("an allowlist admits a staff-only tag and refuses what it leaves out", () => {
    const listed = { ...open, allowedTagIds: [oficial!] };
    expect(resolveWebhookTags(["Oficial", "Notícias"], forumTags, listed)).toEqual({
      tagIds: [oficial],
      ignored: ["Notícias"],
    });
  });

  it("keeps the first five, drops repeats silently, reports the overflow", () => {
    const result = resolveWebhookTags(
      ["Notícias", "noticias", "Lançamento", "Dúvida", "Bug", "Guia", "Evento"],
      forumTags,
      open,
    );
    expect(result.tagIds).toEqual([noticias, lancamento, duvida, bug, guia]);
    expect(result.ignored).toEqual(["Evento"]);
    expect(evento).toBeTruthy();
  });

  it("the defaults apply only when nothing resolved, and only tags that still exist", () => {
    const withDefaults = {
      ...open,
      defaultTagIds: [noticias!, "99999999-9999-4999-8999-999999999999"],
    };
    expect(resolveWebhookTags(["nada"], forumTags, withDefaults)).toEqual({
      tagIds: [noticias],
      ignored: ["nada"],
    });
    expect(resolveWebhookTags(["Bug"], forumTags, withDefaults).tagIds).toEqual([bug]);
    expect(resolveWebhookTags(undefined, forumTags, withDefaults).tagIds).toEqual([noticias]);
  });
});

describe("the dedupe key", () => {
  it("canonical link: no fragment, no utm_*, parameters in a fixed order", () => {
    expect(
      canonicalItemLink("https://Blog.Example.com/a?utm_source=rss&b=2&a=1&UTM_Medium=x#top"),
    ).toBe("https://blog.example.com/a?a=1&b=2");
    expect(canonicalItemLink("<https://x.example.com/p>")).toBe("https://x.example.com/p");
    expect(canonicalItemLink("not a url")).toBe("not a url");
  });

  it("the header wins; the folded title and canonical link otherwise", () => {
    const body = { content: "https://x.example.com/p?utm_source=a" };
    const key = webhookDedupeKey("Título", body, null);
    expect(webhookDedupeKey("  titulo ", { content: "veja https://x.example.com/p#c" }, null)).toBe(
      key,
    );
    expect(webhookDedupeKey("Título", { content: "https://x.example.com/q" }, null)).not.toBe(key);
    expect(webhookDedupeKey("Título", body, "guid-1")).toBe(webhookDedupeKey("Outro", {}, "guid-1"));
    expect(webhookDedupeKey("Título", body, "guid-1")).not.toBe(key);
    expect(webhookDedupeKey("Título", body, "   ")).toBe(key);
  });

  it("the embed's url is the item's link before any link in content", () => {
    const fromEmbed = webhookDedupeKey(
      "T",
      { content: "https://x.example.com/other", embeds: [{ url: "https://x.example.com/item" }] },
      null,
    );
    expect(fromEmbed).toBe(
      webhookDedupeKey("T", { content: "https://x.example.com/item" }, null),
    );
  });

  it("with no link, the title plus the first 500 characters of content", () => {
    const a = webhookDedupeKey("T", { content: `${"x".repeat(500)}a` }, null);
    const b = webhookDedupeKey("T", { content: `${"x".repeat(500)}b` }, null);
    const c = webhookDedupeKey("T", { content: `${"x".repeat(499)}c` }, null);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
