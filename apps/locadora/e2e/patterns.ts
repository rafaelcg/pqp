/**
 * TEST PATTERNS, NOT GAMES.
 *
 * Two tiny images written from scratch for this test (from the S0 spike's
 * `gen-roms.mjs`): a Game Boy Advance image of a few hundred bytes that fills the
 * screen with green, and an NES image that sets its backdrop colour and turns the
 * picture on. They exist so a real core has something to run, and they are
 * built in memory at test time. They are never committed, never given a name
 * that refers to anything, and never written anywhere but a temp folder the
 * test removes. No game, no game image and no part of one is used or kept here.
 */

const u32 = (...words: number[]): Buffer => Buffer.from(new Uint32Array(words).buffer);

/** GBA: a 192 byte header, then ARM code. Mode 3, BG2 on, fill VRAM with green (BGR555 0x03E0). */
export function gbaPattern(): Buffer {
  const rom = Buffer.alloc(0x200);
  u32(0xea00002e).copy(rom, 0); // b 0xC0
  rom[0xb2] = 0x96; // the header's fixed value byte
  const code = u32(
    0xe3a00404, // mov r0, #0x04000000
    0xe3a01c04, // mov r1, #0x400
    0xe3811003, // orr r1, r1, #3
    0xe1c010b0, // strh r1, [r0]
    0xe3a02406, // mov r2, #0x06000000
    0xe3a03e3e, // mov r3, #0x3E0
    0xe1833803, // orr r3, r3, r3, lsl #16
    0xe3a04c4b, // mov r4, #19200
    0xe4823004, // loop: str r3, [r2], #4
    0xe2544001, // subs r4, r4, #1
    0x1afffffc, // bne loop
    0xeafffffe, // b .
  );
  code.copy(rom, 0xc0);
  return rom;
}

/** NES: iNES header, 16 KB PRG, 8 KB CHR (zeros). Backdrop colour 0x2A (green), rendering on. */
export function nesPattern(): Buffer {
  const rom = Buffer.alloc(16 + 16384 + 8192);
  Buffer.from([0x4e, 0x45, 0x53, 0x1a, 1, 1, 0, 0]).copy(rom, 0);
  const prg = Buffer.from([
    0x78, 0xd8, // sei, cld
    0xa9, 0x3f, 0x8d, 0x06, 0x20, // lda #$3F, sta $2006
    0xa9, 0x00, 0x8d, 0x06, 0x20, // lda #$00, sta $2006
    0xa9, 0x2a, 0x8d, 0x07, 0x20, // lda #$2A, sta $2007
    0xa9, 0x00, 0x8d, 0x05, 0x20, 0x8d, 0x05, 0x20, 0x8d, 0x00, 0x20, // scroll 0,0, ctrl 0
    0xa9, 0x0a, 0x8d, 0x01, 0x20, // lda #$0A, sta $2001 (background on)
    0x4c, 0x21, 0xc0, // jmp * (0xC021)
  ]);
  prg.copy(rom, 16);
  // vectors at the end of PRG: NMI, RESET, IRQ all 0xC000
  for (const offset of [0x3ffa, 0x3ffc, 0x3ffe]) rom.writeUInt16LE(0xc000, 16 + offset);
  return rom;
}

/** What each pattern paints, as measured in the spike (Chromium, WebKit, Firefox). */
export const GBA_GREEN = { r: 0, g: 251, b: 0 } as const;
export const NES_GREEN = { r: 74, g: 223, b: 74 } as const;
