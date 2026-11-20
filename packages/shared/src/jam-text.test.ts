import { describe, expect, it } from "vitest";
import { addJamTrackSchema, createJamSongSchema, updateJamSongSchema, updateJamTrackSchema } from "./jam.js";

/**
 * Text a stranger can put in front of other people (jam persona QA, 2026-11-19):
 * a bidi override in an artist or a label reversed the app's own sentence around
 * it ("started by you" became "uoy yb detrats"), and a title of zero-width
 * characters was accepted and drew as nothing. What must keep working is every
 * real script, so each rule here has its twin that must still pass.
 *
 * Invisible characters are written as escapes on purpose: a literal one in this
 * file would be as invisible to the reviewer as it is on screen.
 */

const ID = "11111111-1111-4111-8111-111111111111";
const RLO = "‮";
const LRE = "‪";
const PDF = "‬";
const RLI = "⁧";
const PDI = "⁩";
const ZWSP = "​";
const ZWJ = "‍";
const ZWNJ = "‌";
const BOM = "﻿";
const WJ = "⁠";
const REFUSED = "REFUSED";

function title(value: string): string | null {
  const parsed = createJamSongSchema.safeParse({ title: value });
  return parsed.success ? parsed.data.title : null;
}
function artist(value: string | null): string | null {
  const parsed = createJamSongSchema.safeParse({ title: "x", artist: value });
  return parsed.success ? (parsed.data.artist ?? null) : REFUSED;
}
function label(value: string | null): string | null | undefined {
  const parsed = updateJamTrackSchema.safeParse({ label: value });
  return parsed.success ? parsed.data.label : REFUSED;
}

describe("bidi controls", () => {
  it("are stripped from a title, an artist and a label", () => {
    for (const control of [RLO, LRE, PDF, RLI, PDI, "‫", "‭", "⁦", "⁨"]) {
      expect(title(`evil${control}exe`)).toBe("evilexe");
      expect(artist(`${control}RTL artist`)).toBe("RTL artist");
      expect(label(`${control}take 2${control}`)).toBe("take 2");
    }
    expect(updateJamSongSchema.parse({ artist: `${RLO}Gabi` }).artist).toBe("Gabi");
    expect(updateJamSongSchema.parse({ title: `a${RLO}b` }).title).toBe("ab");
  });

  it("are stripped from the label that comes with an uploaded take", () => {
    const parsed = addJamTrackSchema.parse({
      instrument: "bass",
      label: `groove${RLO}`,
      audioUploadId: ID,
      durationMs: 5000,
    });
    expect(parsed.label).toBe("groove");
  });

  it("are not counted against the length cap, and cannot be used to pass it", () => {
    expect(title(RLO.repeat(500) + "ok")).toBe("ok");
    expect(createJamSongSchema.safeParse({ title: "a".repeat(100) + RLO }).success).toBe(true);
    expect(createJamSongSchema.safeParse({ title: "a".repeat(101) }).success).toBe(false);
  });
});

describe("text that draws nothing", () => {
  const blanks = [
    ZWSP,
    ZWSP + ZWSP,
    `${ZWSP} ${ZWJ}${ZWNJ}`,
    WJ,
    "­",
    "⠀",
    "ㅤ",
    "ᅟ",
    "️",
    "́",
    "‎‏",
  ];

  it("is refused as a title, an artist and a label", () => {
    for (const blank of blanks) {
      expect(title(blank), JSON.stringify(blank)).toBeNull();
      expect(artist(blank), JSON.stringify(blank)).toBe(REFUSED);
      expect(label(blank), JSON.stringify(blank)).toBe(REFUSED);
    }
  });

  it("keeps the old meaning of empty", () => {
    expect(title("   \t ")).toBeNull();
    expect(artist("   ")).toBeNull();
    expect(artist("")).toBeNull();
    expect(artist(null)).toBeNull();
    expect(label("  ")).toBeNull();
    expect(label(null)).toBeNull();
    // The byte-order mark is whitespace to JavaScript: trimmed away like a space.
    expect(title(BOM)).toBeNull();
    expect(artist(BOM)).toBeNull();
    // A bidi control alone is stripped to nothing: an artist cleared, a title refused.
    expect(artist(RLO)).toBeNull();
    expect(title(RLO)).toBeNull();
  });
});

describe("real text that must keep working", () => {
  it("right-to-left: Arabic, Hebrew, Persian, harakat and the implicit marks", () => {
    const arabic = "مرحبا بالعالم";
    const hebrew = "שלום עולם";
    expect(title(arabic)).toBe(arabic);
    expect(title(hebrew)).toBe(hebrew);
    expect(artist(arabic)).toBe(arabic);
    expect(label(hebrew)).toBe(hebrew);
    const mixed = `Wonderwall ‏(${arabic})‎ live`;
    expect(title(mixed)).toBe(mixed);
    const persian = `می${ZWNJ}خواهم`;
    expect(title(persian)).toBe(persian);
    const harakat = "السَّلَامُ عَلَيْكُمْ";
    expect(title(harakat)).toBe(harakat);
    expect(title(`؜${arabic}`)).toBe(`؜${arabic}`);
  });

  it("emoji: a ZWJ family, a flag, a ZWJ flag, a skin tone", () => {
    const family = `\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}${ZWJ}\u{1F466}`;
    const flag = "\u{1F1E7}\u{1F1F7}";
    const rainbow = `\u{1F3F3}️${ZWJ}\u{1F308}`;
    const skin = "\u{1F44D}\u{1F3FD}";
    expect(title(family)).toBe(family);
    expect(title(`${family} Rock`)).toBe(`${family} Rock`);
    expect(title(flag)).toBe(flag);
    expect(title(rainbow)).toBe(rainbow);
    expect(title(skin)).toBe(skin);
    expect(artist(flag)).toBe(flag);
    expect(label(family)).toBe(family);
  });

  it("combining marks: Vietnamese (composed and decomposed), Devanagari, Thai, Portuguese", () => {
    const vietnamese = "Nguyễn Văn Ạnh, Tiếng Việt";
    const decomposed = vietnamese.normalize("NFD");
    expect(decomposed).not.toBe(vietnamese);
    expect(title(vietnamese)).toBe(vietnamese);
    expect(title(decomposed)).toBe(decomposed);
    expect(artist(decomposed)).toBe(decomposed);
    expect(title("नमस्ते दुनिया")).toBe("नमस्ते दुनिया");
    expect(title("ภาษาไทย")).toBe("ภาษาไทย");
    expect(title("Açaí é bom, não é?")).toBe("Açaí é bom, não é?");
  });

  it("a hidden character beside a visible one is left as the person typed it", () => {
    expect(title(`a${ZWSP}b`)).toBe(`a${ZWSP}b`);
  });
});
