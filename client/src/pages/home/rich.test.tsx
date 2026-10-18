import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { translateMessage, useTranslation } from "@/lib/i18n";
import { rich, slotNames } from "./rich";

const html = (node: ReturnType<typeof rich>) => renderToStaticMarkup(<>{node}</>);

describe("t() with no values", () => {
  it("returns the {slot} text unchanged, so rich() can fill it", () => {
    // `blog.article.updated` is "Updated {date}" in English. If i18next ever
    // starts blanking a placeholder it has no value for, every home headline
    // loses its highlighted phrase: rich() would then have to pass each slot
    // name back as its own value.
    expect(translateMessage("blog.article.updated")).toBe("Updated {date}");
  });

  it("fills straight from a translation", () => {
    const out = rich(translateMessage("blog.article.updated"), {
      date: <time dateTime="2026-10-17">October 17, 2026</time>,
    });
    expect(html(out)).toBe('Updated <time dateTime="2026-10-17">October 17, 2026</time>');
  });

  it("works the same through useTranslation(), the t() the sections call", () => {
    function Updated() {
      const { t } = useTranslation();
      return <>{rich(t("blog.article.updated"), { date: <b>today</b> })}</>;
    }
    expect(renderToStaticMarkup(<Updated />)).toBe("Updated <b>today</b>");
  });
});

describe("rich", () => {
  it("puts a node where the slot is", () => {
    const out = rich("Sua galera numa sala que é {accent}.", {
      accent: <span className="text-signal">de vocês</span>,
    });
    expect(html(out)).toBe('Sua galera numa sala que é <span class="text-signal">de vocês</span>.');
  });

  it("follows each language's word order", () => {
    const slots = { a: <b>A</b>, b: <i>B</i> };
    expect(html(rich("{a} then {b}", slots))).toBe("<b>A</b> then <i>B</i>");
    expect(html(rich("{b}, after {a}", slots))).toBe("<i>B</i>, after <b>A</b>");
  });

  it("handles a slot at either end, and the same slot twice", () => {
    expect(html(rich("{x}", { x: <em>x</em> }))).toBe("<em>x</em>");
    expect(html(rich("{x} and {x}", { x: <em>x</em> }))).toBe("<em>x</em> and <em>x</em>");
  });

  it("takes plain strings as slot values", () => {
    expect(html(rich("Checked {age}.", { age: "3 min. ago" }))).toBe("Checked 3 min. ago.");
  });

  it("returns a string with no slots as the same string", () => {
    expect(rich("No slots here.", { accent: <b>never</b> })).toBe("No slots here.");
  });

  it("leaves an unfilled slot visible, so a render test can catch it", () => {
    expect(html(rich("Hi {name}, {missing}.", { name: "Bia" }))).toBe("Hi Bia, {missing}.");
  });

  it("ignores braces that are not a slot", () => {
    expect(rich("{} and { x }", {})).toBe("{} and { x }");
  });
});

describe("slotNames", () => {
  it("lists the slots sorted, like check-i18n", () => {
    expect(slotNames("{b} then {a}, {b}")).toEqual(["a", "b", "b"]);
    expect(slotNames("Sua galera numa sala que é {accent}.")).toEqual(["accent"]);
    expect(slotNames("none")).toEqual([]);
  });
});
