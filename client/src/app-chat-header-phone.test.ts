import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * QA-052: on a phone a voice channel's header lost its name, because the join
 * pill's words took the width and the hamburger shrank to 18px. App.tsx is too
 * big to render in a unit test, so this pins the three classes that fix it.
 */
const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

describe("the channel header on a phone", () => {
  it("never shrinks the hamburger", () => {
    expect(source).toMatch(
      /aria-label=\{phoneShell \? t\("phoneTabs\.back"\) : t\("chrome\.openNav"\)\}/,
    );
    expect(source).toContain('"relative mr-2 shrink-0 rounded-md p-1.5');
  });

  it("keeps a minimum width for the channel name", () => {
    expect(source).toContain("min-w-0 redesign:max-sm:min-w-[4.5rem] redesign:flex-1");
  });

  it("turns the join pill into its glyph, with the words kept for readers", () => {
    expect(source).toContain("HEADER_JOIN_PHONE_REDESIGN");
    expect(source).toContain('<span className="redesign:max-sm:sr-only">{t("voice.join")}</span>');
  });
});
