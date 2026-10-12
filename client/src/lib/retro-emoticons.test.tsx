import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import { remarkMentions } from "./remark-mentions";
import { RETRO_EMOTICONS, remarkRetroEmoticons, replaceEmoticons } from "./retro-emoticons";

describe("replaceEmoticons", () => {
  it("reads the classic codes as emoji", () => {
    expect(replaceEmoticons("vai jogar hj?? (H)")).toBe("vai jogar hj?? 😎");
    expect(replaceEmoticons("te amo (L) (K)")).toBe("te amo ❤️ 💋");
    expect(replaceEmoticons("oi :) tudo bem :D ;)")).toBe("oi 🙂 tudo bem 😃 😉");
    expect(replaceEmoticons(":'( e :(")).toBe("😢 e 🙁");
    expect(replaceEmoticons("(sn) (bah) (pi)")).toBe("🐌 🐑 🍕");
  });

  it("is not picky about case", () => {
    expect(replaceEmoticons("(h) (y) :p")).toBe("😎 👍 😛");
  });

  it("needs a gap around a punctuation code", () => {
    expect(replaceEmoticons("a:)b")).toBe("a:)b");
    expect(replaceEmoticons("às 10:30")).toBe("às 10:30");
    expect(replaceEmoticons("x[:D]")).toBe("x[:D]");
    expect(replaceEmoticons("valeu:)")).toBe("valeu:)");
    expect(replaceEmoticons("valeu :).")).toBe("valeu 🙂.");
    expect(replaceEmoticons("(oi :))")).toBe("(oi 🙂)");
  });

  it("leaves a bracket code that touches a word alone", () => {
    expect(replaceEmoticons("f(x) e abc(L)")).toBe("f(x) e abc(L)");
    expect(replaceEmoticons("(L)abc")).toBe("(L)abc");
  });

  it("never touches a URL", () => {
    expect(replaceEmoticons("olha http://x.com/(L) (L)")).toBe("olha http://x.com/(L) ❤️");
    expect(replaceEmoticons("www.x.com/:D/(H) ok")).toBe("www.x.com/:D/(H) ok");
  });

  it("has only Unicode emoji, one per code", () => {
    const codes = RETRO_EMOTICONS.map(([code]) => code.toLowerCase());
    expect(new Set(codes).size).toBe(codes.length);
    for (const [, emoji] of RETRO_EMOTICONS) {
      expect(emoji).toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

describe("remarkRetroEmoticons", () => {
  function render(body: string) {
    return renderToStaticMarkup(
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMentions("ana"), remarkRetroEmoticons]}>
        {body}
      </ReactMarkdown>,
    );
  }

  it("replaces in prose but not in code spans, code blocks or links", () => {
    const html = render("fechou (Y) `(H)` [(L)](http://x.com) http://y.com/(L)\n\n```\n:)\n```");
    expect(html).toContain("fechou 👍");
    expect(html).toContain("<code>(H)</code>");
    expect(html).toContain(">(L)</a>");
    expect(html).toContain('href="http://y.com/(L)"');
    expect(html).toContain(":)");
  });

  it("leaves a mention as typed", () => {
    expect(render("@ana (H)")).toContain("@ana");
    expect(render("@ana (H)")).toContain("😎");
  });
});
