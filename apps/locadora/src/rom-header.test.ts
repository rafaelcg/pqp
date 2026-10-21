import { describe, expect, it } from "vitest";
import { gameBoyCartridge, gbaCartridge, nesCartridge } from "./test-roms";
import {
  checkRom,
  isGameBoyColor,
  MAX_TITLE_LENGTH,
  readRomHeader,
  resolveRomTitle,
  sanitiseTitle,
  titleFromFileName,
} from "./rom-header";

/** Every buffer here is built from zeros plus a made-up title: no real cartridge bytes. */
function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

function put(buf: Uint8Array, at: number, bytes: number[]): void {
  buf.set(bytes, at);
}

function gameBoy(title: string, cgbFlag = 0): Uint8Array {
  const buf = new Uint8Array(0x8000);
  put(buf, 0x134, ascii(title));
  if (cgbFlag) buf[0x143] = cgbFlag;
  return buf;
}

function gba(title: string, code: string, size = 0x2000): Uint8Array {
  const buf = new Uint8Array(size);
  put(buf, 0xa0, ascii(title));
  put(buf, 0xac, ascii(code));
  return buf;
}

/** A SNES header block with a valid checksum pair at `at`. */
function snesHeader(buf: Uint8Array, at: number, title: string, mapMode: number): void {
  put(buf, at, ascii(title.padEnd(21, " ")));
  buf[at + 0x15] = mapMode;
  // checksum 0x1234, complement 0xEDCB
  put(buf, at + 0x1c, [0xcb, 0xed, 0x34, 0x12]);
}

describe("sanitiseTitle", () => {
  it("keeps printable text and stops at a NUL", () => {
    expect(sanitiseTitle(new Uint8Array([...ascii("FIXTURE"), 0, ...ascii("HIDDEN")]))).toBe("FIXTURE");
  });

  it("turns control and high bytes into single spaces and trims", () => {
    expect(sanitiseTitle(new Uint8Array([0x01, ...ascii("A"), 0xff, 0x80, ...ascii("B"), 0x07]))).toBe("A B");
  });

  it("caps at 24 characters without a trailing space", () => {
    const out = sanitiseTitle("ABCDEFGHIJKLMNOPQRSTUVW YZ0123");
    expect(out.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(out).toBe("ABCDEFGHIJKLMNOPQRSTUVW");
  });

  it("returns an empty string for nothing printable", () => {
    expect(sanitiseTitle(new Uint8Array(16))).toBe("");
    expect(sanitiseTitle(new Uint8Array([0xff, 0xfe, 0x01]))).toBe("");
  });
});

describe("Game Boy", () => {
  it("reads the title at 0x134", () => {
    expect(readRomHeader(gameBoy("TEST CART"), "gb")).toEqual({ title: "TEST CART" });
  });

  it("leaves the CGB flag byte out of a Color cart's title", () => {
    const buf = gameBoy("FIXTURE ONE", 0x80);
    buf[0x142] = 0; // manufacturer area stays blank
    expect(isGameBoyColor(buf)).toBe(true);
    expect(readRomHeader(buf, "gbc")).toEqual({ title: "FIXTURE ONE" });
    // a 15 byte title must not swallow the flag byte as a character
    const full = gameBoy("ABCDEFGHIJKLMNO", 0x80);
    expect(readRomHeader(full, "gbc")?.title).toBe("ABCDEFGHIJKLMNO");
  });

  it("reads all 16 bytes when it is not a Color cart", () => {
    expect(readRomHeader(gameBoy("ABCDEFGHIJKLMNOP"), "gb")?.title).toBe("ABCDEFGHIJKLMNOP");
  });

  it("is null for a blank header and for a file that is too short", () => {
    expect(readRomHeader(new Uint8Array(0x8000), "gb")).toBeNull();
    expect(readRomHeader(new Uint8Array(0x100), "gb")).toBeNull();
    expect(readRomHeader(new Uint8Array(0), "gbc")).toBeNull();
  });
});

describe("GBA", () => {
  it("reads the title at 0xA0 and the game code at 0xAC", () => {
    expect(readRomHeader(gba("TEST ADV", "ZZZE"), "gba")).toEqual({ title: "TEST ADV", gameCode: "ZZZE" });
  });

  it("falls back to the game code when the title is blank", () => {
    expect(readRomHeader(gba("", "ZZZE"), "gba")).toEqual({ title: "ZZZE", gameCode: "ZZZE" });
  });

  it("is null for a blank header and a short file", () => {
    expect(readRomHeader(new Uint8Array(0x2000), "gba")).toBeNull();
    expect(readRomHeader(new Uint8Array(0x40), "gba")).toBeNull();
  });
});

describe("SNES", () => {
  it("reads a LoROM header at 0x7FC0", () => {
    const buf = new Uint8Array(0x10000);
    snesHeader(buf, 0x7fc0, "FIXTURE LOROM", 0x20);
    expect(readRomHeader(buf, "snes")).toEqual({ title: "FIXTURE LOROM" });
  });

  it("reads a HiROM header at 0xFFC0", () => {
    const buf = new Uint8Array(0x20000);
    snesHeader(buf, 0xffc0, "FIXTURE HIROM", 0x21);
    expect(readRomHeader(buf, "snes")).toEqual({ title: "FIXTURE HIROM" });
  });

  it("shifts by 512 when a copier header leads the file", () => {
    const buf = new Uint8Array(0x10000 + 512);
    snesHeader(buf, 0x7fc0 + 512, "COPIER LOROM", 0x20);
    expect(readRomHeader(buf, "snes")).toEqual({ title: "COPIER LOROM" });

    const hi = new Uint8Array(0x20000 + 512);
    snesHeader(hi, 0xffc0 + 512, "COPIER HIROM", 0x21);
    expect(readRomHeader(hi, "snes")).toEqual({ title: "COPIER HIROM" });
  });

  it("prefers the candidate whose checksum pair holds", () => {
    const buf = new Uint8Array(0x20000);
    // junk text at the LoROM spot, a real header at the HiROM spot
    put(buf, 0x7fc0, ascii("NOT A HEADER AT ALL!"));
    snesHeader(buf, 0xffc0, "THE REAL ONE", 0x21);
    expect(readRomHeader(buf, "snes")?.title).toBe("THE REAL ONE");
  });

  it("is null for zeroed bytes and for a file too small to hold a header", () => {
    expect(readRomHeader(new Uint8Array(0x20000), "snes")).toBeNull();
    expect(readRomHeader(new Uint8Array(0x1000), "snes")).toBeNull();
  });
});

describe("NES", () => {
  it("has no title to read, whatever the bytes say", () => {
    const buf = new Uint8Array(0x4010);
    put(buf, 0, [0x4e, 0x45, 0x53, 0x1a]);
    put(buf, 0x134, ascii("NOT A TITLE"));
    expect(readRomHeader(buf, "nes")).toBeNull();
  });
});

describe("file name fallback", () => {
  it("drops folder and extension and turns underscores into spaces", () => {
    expect(titleFromFileName("C:\\tapes\\my_homebrew_game.gb")).toBe("my homebrew game");
    expect(titleFromFileName("a/b/Some Game.nes")).toBe("Some Game");
  });

  it("resolves header first, then file name, then the fallback", () => {
    expect(resolveRomTitle(gameBoy("FROM HEADER"), "gb", "file.gb", "Fita")).toBe("FROM HEADER");
    expect(resolveRomTitle(new Uint8Array(0x8000), "gb", "from_file.gb", "Fita")).toBe("from file");
    expect(resolveRomTitle(new Uint8Array(0x8000), "gb", ".gb", "Fita")).toBe("Fita");
  });
});

describe("checkRom: is this a cartridge at all", () => {
  it("takes the header each console reads first, and a homebrew without a checksum", () => {
    expect(checkRom(nesCartridge(), "nes")).toEqual({ ok: true });
    expect(checkRom(gameBoyCartridge(), "gb")).toEqual({ ok: true });
    expect(checkRom(gameBoyCartridge(), "gbc")).toEqual({ ok: true });
    // the GBA header's complement byte was never filled in: still a cartridge
    expect(checkRom(gbaCartridge(), "gba")).toEqual({ ok: true });
  });

  it("never takes an empty file", () => {
    for (const platform of ["nes", "gb", "gbc", "gba", "snes"] as const) {
      expect(checkRom(new Uint8Array(0), platform)).toEqual({ ok: false, reason: "empty" });
    }
  });

  it("never takes a text file, whatever its extension says", () => {
    const text = new TextEncoder().encode("Dear diary, this is not a game.\n".repeat(2000));
    for (const platform of ["nes", "gb", "gbc", "gba"] as const) {
      expect(checkRom(text, platform).ok, platform).toBe(false);
    }
  });

  it("never takes a file of zeros, however big", () => {
    expect(checkRom(new Uint8Array(24 * 1024 * 1024), "gba")).toEqual({ ok: false, reason: "header" });
    expect(checkRom(new Uint8Array(0x8000), "gb")).toEqual({ ok: false, reason: "header" });
    expect(checkRom(new Uint8Array(32 * 1024), "nes")).toEqual({ ok: false, reason: "header" });
  });

  it("refuses sizes no cartridge of the system has", () => {
    expect(checkRom(nesCartridge().subarray(0, 4000), "nes")).toEqual({ ok: false, reason: "size" });
    expect(checkRom(gbaCartridge().subarray(0, 0x40), "gba")).toEqual({ ok: false, reason: "size" });
    expect(checkRom(gameBoyCartridge().subarray(0, 0x100), "gb")).toEqual({ ok: false, reason: "size" });
    const huge = new Uint8Array(33 * 1024 * 1024);
    huge[0xb2] = 0x96;
    expect(checkRom(huge, "gba")).toEqual({ ok: false, reason: "size" });
  });

  it("wants each console's own marker: a NES header is no Game Boy image", () => {
    expect(checkRom(nesCartridge(), "gb").ok).toBe(false);
    expect(checkRom(gameBoyCartridge(), "nes").ok).toBe(false);
    const almost = gameBoyCartridge();
    almost[0x110] ^= 0xff;
    expect(checkRom(almost, "gb")).toEqual({ ok: false, reason: "header" });
    const noFixed = gbaCartridge();
    noFixed[0xb2] = 0;
    expect(checkRom(noFixed, "gba")).toEqual({ ok: false, reason: "header" });
  });
});
