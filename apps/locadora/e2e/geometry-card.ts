/**
 * A TEST PATTERN, NOT A GAME: a SNES measuring card that CHANGES ITS OUTPUT SIZE while it runs, which is what a real
 * game does and the other patterns never do. Written from scratch (65816 machine code assembled below, no game and
 * no part of one), built in memory at test time, never committed as bytes.
 *
 * The picture is a 32x32 tile map of its own colours: a white frame on the left, right and top and at tile rows 27
 * and 29 (the last row of a 224 line picture, and of a 239 line one), and a coloured marker in each corner of BOTH
 * pictures, on a dark grey backdrop. Every press of the B button (the `X` key) takes the next of four PPU modes,
 * written to SETINI ($2133) in vertical blank, so the core's frame, and the aspect it reports, change on the
 * player's say-so, at any moment.
 */

export const SNES_GEOMETRY_MODES = [
  { name: "224", setini: 0x00, tint: 0x2108, width: 256, height: 224 },
  { name: "239", setini: 0x04, tint: 0x4000, width: 256, height: 239 },
  { name: "hires", setini: 0x08, tint: 0x0200, width: 512, height: 224 },
  { name: "hires-interlace", setini: 0x09, tint: 0x0014, width: 512, height: 448 },
] as const;

/** What the card paints at its corners and edges. */
export const GEOMETRY_COLORS = {
  topLeft: [255, 0, 0],
  topRight: [0, 255, 0],
  bottomLeft: [0, 0, 255],
  bottomRight: [255, 255, 0],
  edge: [255, 255, 255],
  field: [66, 66, 66],
} as const satisfies Record<string, readonly [number, number, number]>;

export function snesGeometryPattern(): Buffer {
  const rom = Buffer.alloc(0x8000);
  // ---- a tiny assembler: bytes, labels and short branches ----
  const out: number[] = [];
  const labels = new Map<string, number>();
  const fixups: Array<{ at: number; label: string }> = [];
  const b = (...bytes: number[]) => void out.push(...bytes);
  const label = (name: string) => void labels.set(name, out.length);
  const branch = (opcode: number, name: string) => {
    b(opcode, 0);
    fixups.push({ at: out.length - 1, label: name });
  };
  const store = (addr: number, value: number) => b(0xa9, value, 0x8d, addr & 0xff, addr >> 8); // lda #value, sta addr

  b(0x78, 0x18, 0xfb, 0xe2, 0x30); // sei, clc, xce, sep #$30 (native mode, 8-bit A and X)
  store(0x2100, 0x80); // force blank
  store(0x4200, 0x01); // auto joypad read, no NMI
  store(0x2105, 0x00); // BG mode 0
  store(0x2107, 0x00); // BG1 map at VRAM word 0, 32x32
  store(0x210b, 0x01); // BG1 characters at VRAM word 0x1000
  store(0x212c, 0x01); // main screen: BG1
  store(0x212d, 0x01); // sub screen: BG1 too (what pseudo hi-res blends)
  // colours: the backdrop, then colour 1 of palettes 0 to 4 (CGRAM 1, 5, 9, 13, 17)
  const colors: Array<[number, number]> = [
    [0, 0x2108], // backdrop: dark grey
    [1, 0x7fff], // white
    [5, 0x001f], // red
    [9, 0x03e0], // green
    [13, 0x7c00], // blue
    [17, 0x03ff], // yellow
  ];
  for (const [index, bgr] of colors) {
    store(0x2121, index);
    store(0x2122, bgr & 0xff);
    store(0x2122, bgr >> 8);
  }
  // DMA on channel 0 (two registers, A to B): the tiles to VRAM word 0x1000, the map to VRAM word 0
  const dma = (vram: number, from: number, size: number) => {
    store(0x2115, 0x80);
    store(0x2116, vram & 0xff);
    store(0x2117, vram >> 8);
    store(0x4300, 0x01);
    store(0x4301, 0x18);
    store(0x4302, from & 0xff);
    store(0x4303, from >> 8);
    store(0x4304, 0x00);
    store(0x4305, size & 0xff);
    store(0x4306, size >> 8);
    store(0x420b, 0x01);
  };
  dma(0x1000, 0x8800, 32);
  dma(0x0000, 0x9000, 2048);
  store(0x2133, 0x00);
  store(0x2100, 0x0f); // screen on
  b(0x64, 0x02); // stz $02 (frames B has been up)
  b(0x64, 0x01); // stz $01 (the mode)
  label("frame");
  label("waitVblank");
  b(0xad, 0x12, 0x42, 0x29, 0x80); // lda $4212, and #$80
  branch(0xf0, "waitVblank"); // beq
  label("waitJoy");
  b(0xad, 0x12, 0x42, 0x29, 0x01); // lda $4212, and #$01 (auto read still running)
  branch(0xd0, "waitJoy"); // bne
  b(0xad, 0x19, 0x42, 0x29, 0x80); // lda $4219 (B Y Select Start Up Down Left Right), and #$80: B
  branch(0xd0, "down"); // bne: B is down
  // B is up: count the frames it has been up (at most 8), so one press is one step however it bounces
  b(0xa5, 0x02, 0xc9, 0x08); // lda $02, cmp #8
  branch(0xb0, "noNew"); // bcs: enough already
  b(0xe6, 0x02); // inc $02
  branch(0x80, "noNew");
  label("down");
  b(0xa5, 0x02, 0xc9, 0x04); // lda $02, cmp #4: was B up for four frames before this?
  b(0x64, 0x02); // stz $02 (no flags touched)
  branch(0x90, "noNew"); // bcc: no, a bounce of the same press
  b(0xe6, 0x01); // inc $01: the next mode
  b(0xa5, 0x01, 0x29, 0x03, 0xaa); // lda $01, and #$03, tax
  b(0xbd, 0x00, 0x8a); // lda $8A00,x
  b(0x8d, 0x33, 0x21); // sta $2133
  b(0x9c, 0x21, 0x21); // stz $2121: CGRAM colour 0, the backdrop, takes the mode's own tint
  b(0xbd, 0x10, 0x8a, 0x8d, 0x22, 0x21); // lda $8A10,x, sta $2122
  b(0xbd, 0x20, 0x8a, 0x8d, 0x22, 0x21); // lda $8A20,x, sta $2122
  label("noNew");
  label("waitEnd");
  b(0xad, 0x12, 0x42, 0x29, 0x80); // lda $4212, and #$80
  branch(0xd0, "waitEnd"); // bne
  branch(0x80, "frame"); // bra
  for (const { at, label: name } of fixups) {
    const target = labels.get(name);
    if (target === undefined) throw new Error(`no label ${name}`);
    const offset = target - (at + 1);
    if (offset < -128 || offset > 127) throw new Error(`branch to ${name} out of range`);
    out[at] = offset & 0xff;
  }
  if (out.length > 0x800) throw new Error("code overflows its page");
  Buffer.from(out).copy(rom, 0);

  // tile 0 blank, tile 1 solid colour 1 (plane 0 all ones)
  for (let row = 0; row < 8; row++) rom[0x800 + 16 + row * 2] = 0xff;
  SNES_GEOMETRY_MODES.forEach((mode, i) => {
    rom[0xa00 + i] = mode.setini;
    rom[0xa10 + i] = mode.tint & 0xff;
    rom[0xa20 + i] = mode.tint >> 8;
  });

  // the map: the frame, and the four corners of both the 224 and the 239 line pictures (entry = tile 1 | palette << 10)
  const WHITE = 0x0001;
  const RED = 0x0401;
  const GREEN = 0x0801;
  const BLUE = 0x0c01;
  const YELLOW = 0x1001;
  const set = (col: number, row: number, entry: number) => rom.writeUInt16LE(entry, 0x1000 + (row * 32 + col) * 2);
  for (let i = 0; i < 32; i++) for (const row of [0, 27, 29]) set(i, row, WHITE);
  for (let row = 0; row < 30; row++) {
    set(0, row, WHITE);
    set(31, row, WHITE);
  }
  set(0, 0, RED);
  set(31, 0, GREEN);
  for (const row of [27, 29]) {
    set(0, row, BLUE);
    set(31, row, YELLOW);
  }

  // the header: a title of our own, LoROM, no RAM, a checksum pair that agrees, every vector at an RTI but reset
  Buffer.from("PQP GEOMETRY CARD".padEnd(21, " "), "ascii").copy(rom, 0x7fc0);
  rom[0x7fd5] = 0x20;
  rom[0x7fd6] = 0x00;
  rom[0x7fd7] = 0x05;
  rom[0x7fd8] = 0x00;
  rom[0x7fd9] = 0x01;
  const ret = 0x7f00;
  rom[ret] = 0x40;
  for (let at = 0x7fe4; at < 0x8000; at += 2) rom.writeUInt16LE(0x8000 + ret, at);
  rom.writeUInt16LE(0x8000, 0x7ffc);
  rom.writeUInt16LE(0xffff, 0x7fdc);
  rom.writeUInt16LE(0x0000, 0x7fde);
  let sum = 0;
  for (const byte of rom) sum = (sum + byte) & 0xffff;
  rom.writeUInt16LE(sum ^ 0xffff, 0x7fdc);
  rom.writeUInt16LE(sum, 0x7fde);
  return rom;
}
