import { describe, expect, it } from "vitest";
import {
  KONAMI_GAP_MS,
  KONAMI_SEQUENCE,
  createKonamiMatcher,
  isEditableTarget,
  konamiKey,
} from "./konami";

function feed(keys: readonly string[], start = 0, step = 100) {
  const matcher = createKonamiMatcher();
  return keys.map((key, index) => matcher.push(key, start + index * step));
}

describe("konami matcher", () => {
  it("fires on the last key of the sequence, once", () => {
    const results = feed(KONAMI_SEQUENCE);
    expect(results.at(-1)).toBe(true);
    expect(results.slice(0, -1).every((hit) => !hit)).toBe(true);
  });

  it("a wrong key in the middle starts over", () => {
    const keys = [...KONAMI_SEQUENCE.slice(0, 5), "x", ...KONAMI_SEQUENCE.slice(5)];
    expect(feed(keys).some(Boolean)).toBe(false);
  });

  it("recovers when the wrong key is itself the first key", () => {
    // up, up, up, down, down... : the third up is the start of a fresh run.
    const keys = ["arrowup", ...KONAMI_SEQUENCE];
    expect(feed(keys).at(-1)).toBe(true);
  });

  it("a long pause between keys starts over", () => {
    const matcher = createKonamiMatcher();
    let now = 0;
    for (const key of KONAMI_SEQUENCE.slice(0, 9)) {
      matcher.push(key, (now += 100));
    }
    expect(matcher.push("a", now + KONAMI_GAP_MS + 1)).toBe(false);
  });

  it("can be entered twice in a row", () => {
    const results = feed([...KONAMI_SEQUENCE, ...KONAMI_SEQUENCE]);
    expect(results.filter(Boolean)).toHaveLength(2);
  });

  it("reads B and A by position, whatever the layout types there", () => {
    expect(konamiKey("ArrowUp")).toBe("arrowup");
    expect(konamiKey("B")).toBe("b");
    expect(konamiKey("б", "KeyB")).toBe("b");
    expect(konamiKey("ф", "KeyA")).toBe("a");
  });
});

describe("isEditableTarget", () => {
  function element(tag: string, opts: { editable?: boolean; inside?: string } = {}) {
    return {
      tagName: tag.toUpperCase(),
      isContentEditable: opts.editable ?? false,
      closest: (selector: string) =>
        selector.includes(tag) || (opts.inside && selector.includes(opts.inside))
          ? {}
          : null,
    } as unknown as EventTarget;
  }

  it("ignores keys typed into a field", () => {
    expect(isEditableTarget(element("textarea"))).toBe(true);
    expect(isEditableTarget(element("input"))).toBe(true);
    expect(isEditableTarget(element("div", { editable: true }))).toBe(true);
    expect(isEditableTarget(element("span", { inside: '[role="textbox"]' }))).toBe(true);
  });

  it("listens everywhere else", () => {
    expect(isEditableTarget(element("button"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
