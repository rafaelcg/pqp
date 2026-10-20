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

/**
 * SNES: 32 KB of LoROM. The reset code (65816, at $00:8000, file offset 0) blanks the screen, writes colour 0 of
 * the palette (the backdrop) as green (BGR555 0x03E0) and turns the screen on at full brightness, then loops. No
 * layer is enabled, so the whole picture is the backdrop. The header at 0x7FC0 has a title of our own, map mode
 * 0x20 (LoROM), 2 KB of battery RAM and a checksum pair that agree, computed here.
 */
export function snesPattern(): Buffer {
  const rom = Buffer.alloc(0x8000);
  const code = Buffer.from([
    0x78, // sei
    0x18, // clc
    0xfb, // xce (native mode)
    0xe2, 0x20, // sep #$20 (8-bit A)
    0xa9, 0x80, 0x8d, 0x00, 0x21, // lda #$80, sta $2100 (force blank)
    0x9c, 0x21, 0x21, // stz $2121 (CGRAM address 0)
    0xa9, 0xe0, 0x8d, 0x22, 0x21, // lda #$E0, sta $2122 (colour 0, low byte)
    0xa9, 0x03, 0x8d, 0x22, 0x21, // lda #$03, sta $2122 (colour 0, high byte)
    0xa9, 0x0f, 0x8d, 0x00, 0x21, // lda #$0F, sta $2100 (screen on, full brightness)
    0x80, 0xfe, // bra * (loop forever)
  ]);
  code.copy(rom, 0);
  const ret = 0x7f00;
  rom[ret] = 0x40; // rti, for every vector but reset
  Buffer.from("PQP TEST PATTERN".padEnd(21, " "), "ascii").copy(rom, 0x7fc0);
  rom[0x7fd5] = 0x20; // LoROM
  rom[0x7fd6] = 0x02; // ROM + RAM + battery
  rom[0x7fd7] = 0x05; // 32 KB
  rom[0x7fd8] = 0x01; // 2 KB of RAM
  rom[0x7fd9] = 0x01; // NTSC
  // native vectors (COP, BRK, ABORT, NMI, unused, IRQ) and emulation vectors (COP, unused, ABORT, NMI, RESET, IRQ)
  for (let at = 0x7fe4; at < 0x8000; at += 2) rom.writeUInt16LE(0x8000 + ret, at);
  rom.writeUInt16LE(0x8000, 0x7ffc); // reset: $8000
  // checksum: the sum of every byte with the pair set to 0xFFFF and 0x0000, which sums the same as any agreeing pair
  rom.writeUInt16LE(0xffff, 0x7fdc);
  rom.writeUInt16LE(0x0000, 0x7fde);
  let sum = 0;
  for (const byte of rom) sum = (sum + byte) & 0xffff;
  rom.writeUInt16LE(sum ^ 0xffff, 0x7fdc);
  rom.writeUInt16LE(sum, 0x7fde);
  return rom;
}

/** What the frame pattern paints: a corner marker in each corner, a white 1px frame, a grey field. */
export const FRAME_COLORS = {
  topLeft: [255, 0, 0],
  topRight: [0, 255, 0],
  bottomLeft: [0, 0, 255],
  bottomRight: [255, 255, 0],
  edge: [255, 255, 255],
  field: [66, 66, 66],
} as const satisfies Record<string, readonly [number, number, number]>;

type Rgb = readonly [number, number, number];

/**
 * GBA, a measuring card: a 240x160 picture copied from the image into the screen's memory (mode 3), with a 1px
 * white frame round the edge and an 8x8 marker of its own colour in each corner, so a test can tell from the
 * pixels of a screenshot that all four corners and all four edges reached the display. Generated here, never a game.
 */
export function gbaFramePattern(): Buffer {
  const W = 240;
  const H = 160;
  const rom = Buffer.alloc(0x200 + W * H * 2);
  u32(0xea00002e).copy(rom, 0); // b 0xC0
  rom[0xb2] = 0x96;
  u32(
    0xe3a00404, // mov r0, #0x04000000
    0xe3a01c04, // mov r1, #0x400
    0xe3811003, // orr r1, r1, #3
    0xe1c010b0, // strh r1, [r0]       (mode 3, BG2 on)
    0xe3a02406, // mov r2, #0x06000000 (the screen)
    0xe3a05408, // mov r5, #0x08000000
    0xe3855c02, // orr r5, r5, #0x200  (the picture, in this image)
    0xe3a04c4b, // mov r4, #19200      (words)
    0xe4953004, // loop: ldr r3, [r5], #4
    0xe4823004, // str r3, [r2], #4
    0xe2544001, // subs r4, r4, #1
    0x1afffffb, // bne loop
    0xeafffffe, // b .
  ).copy(rom, 0xc0);
  const bgr = ([r, g, b]: Rgb) => ((b >> 3) << 10) | ((g >> 3) << 5) | (r >> 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let color: Rgb = FRAME_COLORS.field;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) color = FRAME_COLORS.edge;
      if (x < 8 && y < 8) color = FRAME_COLORS.topLeft;
      if (x >= W - 8 && y < 8) color = FRAME_COLORS.topRight;
      if (x < 8 && y >= H - 8) color = FRAME_COLORS.bottomLeft;
      if (x >= W - 8 && y >= H - 8) color = FRAME_COLORS.bottomRight;
      rom.writeUInt16LE(bgr(color), 0x200 + (y * W + x) * 2);
    }
  }
  return rom;
}

/** What each pattern paints, as measured in the spike (Chromium, WebKit, Firefox). */
export const GBA_GREEN = { r: 0, g: 251, b: 0 } as const;
export const NES_GREEN = { r: 74, g: 223, b: 74 } as const;
export const SNES_GREEN = { r: 0, g: 255, b: 0 } as const;
