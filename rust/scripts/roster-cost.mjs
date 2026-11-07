#!/usr/bin/env node
/**
 * What the one frame worth compressing actually costs.
 *
 * `server/src/lib/ws-compression.ts` says `permessage-deflate` is what makes a
 * 250-person `voice-roster` affordable — 84.4 KB down to about 15 KB, on a
 * machine whose scarce resource is bandwidth — and the mainstream Rust
 * WebSocket stacks do not implement RFC 7692 (see `docs/RUST.md`). So the
 * question a Rust fan-out path has to answer is not "is Rust faster", it is
 * "what is that compression worth, and what does checking this frame cost".
 * This measures both, on the frame itself rather than on a guess.
 *
 * THE PEOPLE IN THE ROSTER COST MORE THAN THE FIELD NAMES.
 *
 * Deflate buys repeats. A roster whose ids are `peer-1`, `peer-2`, `peer-3` is
 * one word repeated two hundred and fifty times, and it collapses to about a
 * tenth of its size — a number that flatters compression by close to a factor
 * of two, and that would have gone into the plan had this script not noticed.
 * Production ids do not look like that: `userId` has to be a uuid
 * (`packages/shared/src/signaling.ts:54`), `peerId` is filled with
 * `randomUUID()` (`server/src/ws/voice.ts:8878`), an avatar is a long random CDN
 * path, and nobody in a hall is called `Player 7`. Both variants are
 * reported: `realistic`, which is the number to quote, and `sequential`, which
 * is what a lazy fixture measures and by how much it lies.
 *
 * The roster is built from the vector fixture's own participant shape, so it is
 * schema-valid by construction and `safeParse` asserts that before any number
 * is reported. Compression uses the shipped parameters (`level 3`,
 * `memLevel 6`); `ws` additionally strips the sync-flush tail, which is a
 * handful of bytes, so the ratio here is a hair pessimistic.
 *
 * The Rust column times the shadow audit over N copies of the frame against 2N,
 * which cancels the process start and the one-off parse of the rule table.
 *
 * Usage: node --experimental-strip-types --no-warnings \
 *          --import ./rust/scripts/ts-register.mjs rust/scripts/roster-cost.mjs
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const sig = await import(resolve(root, "packages/shared/src/signaling.ts"));
const vectors = JSON.parse(
  readFileSync(resolve(root, "rust/fixtures/proto-vectors.json"), "utf8"),
);

const ROSTER = 250;
const REPEATS = 2_000;

/** These numbers go into a document, so a rerun has to produce them again. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEX = "0123456789abcdef";
const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

function chars(rnd, n, alphabet) {
  let out = "";
  for (let i = 0; i < n; i += 1) out += alphabet[Math.floor(rnd() * alphabet.length)];
  return out;
}

/** The shape `randomUUID()` produces, from the seeded stream. */
function uuidV4(rnd) {
  const group = (n) => chars(rnd, n, HEX);
  return `${group(8)}-${group(4)}-4${group(3)}-8${group(3)}-${group(12)}`;
}

/** A distinct uuid that runs in order: the lazy fixture's idea of an id, kept
 *  schema-valid on purpose so the comparison is about entropy and not about
 *  one variant being illegal. */
function uuidSequential(index) {
  const group = (k) => (index * 16 + k).toString(16).padStart(4, "0").slice(-4);
  return `${group(0)}${group(1)}-${group(2)}-4${group(3).slice(1)}-8${group(4).slice(1)}-${group(5)}${group(6)}${group(7)}`;
}

/** Handles people actually bring into a hall: short, uneven, some accented. */
const HANDLES = [
  "rafa", "juuh", "cacique", "O Blasfemo", "MrZenitude", "dudu", "Nightbloom",
  "KTLO", "m4ria", "Tonho", "Pao de Queijo", "ze", "Bibi", "Ghost", "pipoca",
  "Arskin", "Lari", "tom", "Kapella", "Bode", "Nyx", "voli", "Drops", "Rato",
];

function handle(rnd, i) {
  const base = HANDLES[i % HANDLES.length];
  return i < HANDLES.length ? base : `${base}${10 + Math.floor(rnd() * 9990)}`;
}

function roster(participants, realistic) {
  const rnd = prng(20_261_107);
  const base = vectors.server.vectors.find((v) => v.type === "voice-roster");
  // Every field the shipped participant schema declares, not just the ones the
  // small vector happens to carry: a 250-person roster in a room where people
  // have cameras on is the frame that costs bandwidth, and a lean stand-in
  // would understate both its size and what compression is worth.
  const keys = Object.keys(sig.voiceParticipantSchema.shape);
  const list = [];
  for (let i = 0; i < participants; i += 1) {
    const camera = i % 4 === 0;
    const sharing = i % 25 === 0;
    const one = {
      peerId: realistic ? uuidV4(rnd) : `peer-${i}`,
      userId: realistic ? uuidV4(rnd) : uuidSequential(i + 1),
      displayName: realistic ? handle(rnd, i) : `Player ${i}`,
      avatarUrl: !realistic || i % 5 === 0
        ? null
        : `https://img.clerk.com/imageworks/FieldUpload_${chars(rnd, 26, ALNUM)}`,
      sharingScreen: sharing,
      muted: i % 3 === 0,
      deafened: false,
      canSpeak: true,
    };
    if (camera) one.cameraStreamId = realistic ? chars(rnd, 20, ALNUM) : `cam-${i}`;
    if (sharing) one.screenAudioStreamId = realistic ? chars(rnd, 20, ALNUM) : `scr-${i}`;
    if (i % 4 === 0) one.handRaisedAt = 1_700_000_000_000 + i;
    list.push(one);
  }
  // Fields the fixture does not exercise still arrive on the wire when the room
  // uses them. Rather than guess each one's type, ask zod: the first candidate
  // that keeps the whole frame valid is the one that goes in. A wrong guess here
  // would silently shrink the frame and flatter the compression ratio, which is
  // the exact bias this script exists to avoid.
  const template = { ...list[0] };
  const skipped = [];
  for (const key of keys) {
    if (key in template) continue;
    let chosen;
    for (const candidate of [true, 0, "x", null]) {
      const probe = { ...base.input, participants: [{ ...template, [key]: candidate }], seq: 12 };
      if (sig.voiceSignalingMessageSchema.safeParse(probe).success) {
        chosen = candidate;
        break;
      }
    }
    if (chosen === undefined) skipped.push(key);
    else template[key] = chosen;
  }
  if (skipped.length) console.log(`(left out of the roster: ${skipped.join(", ")})`);
  return { ...base.input, participants: list.map((p) => ({ ...template, ...p })), seq: 12 };
}

/** Size and the shipped deflate ratio for one built frame. */
function sizes(frame) {
  const parsed = sig.voiceSignalingMessageSchema.safeParse(frame);
  if (!parsed.success) {
    console.error("the synthetic roster is not schema-valid:", parsed.error.issues[0]);
    process.exit(1);
  }
  const text = JSON.stringify(frame);
  const bytes = Buffer.byteLength(text);
  // `ws` negotiates raw deflate; the shipped policy is level 3 / memLevel 6.
  const deflate = (level, memLevel = 6) => deflateRawSync(text, { level, memLevel }).length;
  return {
    frame,
    text,
    bytes,
    levels: [1, 3, 6, 9].map((level) => ({ level, size: deflate(level) })),
  };
}

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function timeRepeated(total, work) {
  const warm = work();
  if (warm === undefined) throw new Error("nothing measured");
  const runs = [];
  for (let run = 0; run < 3; run += 1) {
    const started = process.hrtime.bigint();
    for (let i = 0; i < total; i += 1) work();
    runs.push(Number(process.hrtime.bigint() - started) / total / 1_000);
  }
  return median(runs);
}

function runShadow(stdin) {
  const out = spawnSync(
    "cargo",
    ["run", "-q", "--release", "--manifest-path", "rust/Cargo.toml", "--example", "shadow", "--", "server"],
    { cwd: root, input: stdin, encoding: "utf8" },
  );
  if (out.status !== 0) {
    console.error(out.stderr);
    throw new Error("the shadow audit failed on a frame zod accepts");
  }
  return out.stdout;
}

const real = sizes(roster(ROSTER, true));
const fake = sizes(roster(ROSTER, false));

const jsonNs = timeRepeated(REPEATS, () => JSON.parse(real.text)) * 1_000;
const zodNs = timeRepeated(REPEATS, () => sig.voiceSignalingMessageSchema.safeParse(real.frame)) * 1_000;
if (!sig.voiceSignalingMessageSchema.safeParse(real.frame).success) {
  throw new Error("zod is being timed on a frame it refuses; the number would be meaningless");
}

const payload = `${Array.from({ length: REPEATS }, () => real.text).join("\n")}\n`;
const report = runShadow(payload);
const refused = Number(report.match(/(\d+) would be refused/)[1]);
if (refused !== 0) {
  console.error(report);
  throw new Error(`Rust would refuse a frame zod accepts (${refused} of ${REPEATS})`);
}
// Time Rust by SLOPE, not by subtracting a startup baseline: the difference
// between N frames and 2N frames is per-frame cost with the process start and
// the one-off rule-table parse cancelled out. A single baseline subtraction was
// the first attempt here and it reported 0.0 us, which was the method being
// wrong rather than Rust being free.
function seconds(stdin) {
  const started = process.hrtime.bigint();
  runShadow(stdin);
  return Number(process.hrtime.bigint() - started);
}
const oneLine = `${real.text}\n`;
const slopeRuns = [];
for (let run = 0; run < 3; run += 1) {
  const tLow = seconds(oneLine.repeat(REPEATS));
  const tHigh = seconds(oneLine.repeat(REPEATS * 2));
  slopeRuns.push(Number(tHigh - tLow) / REPEATS / 1_000);
}
const rustUs = median(slopeRuns);
// Physical sanity, because the first version of this line printed 0.2 us for a
// 106 KB frame: microseconds divided by a thousand twice. Whatever the frame, a
// validator that parses it cannot exceed main memory, so a number that implies a
// wild throughput is a unit error and not a fast language.
const impliedGBs = real.bytes / (rustUs * 1e-6) / 1e9;
if (!(impliedGBs > 0) || impliedGBs > 20) {
  console.error(`rust validate is ${rustUs} us/frame, which implies ${impliedGBs.toFixed(1)} GB/s`);
  throw new Error("that is not a measurement, it is a unit error");
}

function printSizes(label, m, note) {
  console.log(`  ${label}`);
  console.log(`    raw                ${(m.bytes / 1024).toFixed(1)} KB`);
  for (const row of m.levels) {
    const ratio = (m.bytes / row.size).toFixed(2);
    const tag = row.level === 3 ? "   <- shipped" : "";
    console.log(
      `    deflate level ${row.level}    ${(row.size / 1024).toFixed(1)} KB` +
        `   ${ratio}x${tag}`,
    );
  }
  if (note) console.log(`    ${note}`);
}

console.log(`voice-roster with ${ROSTER} participants (schema-valid: safeParse ok)`);
console.log("");
printSizes("realistic ids, the number to quote", real);
const realRatio = real.bytes / real.levels[1].size;
const fakeRatio = fake.bytes / fake.levels[1].size;
printSizes("sequential ids, what a lazy fixture measures", fake,
  `level 3 lies by ${(fakeRatio / realRatio).toFixed(2)}x about what production deflates to`);
console.log("");
const jsonUs = jsonNs / 1_000;
const zodUs = zodNs / 1_000;
console.log(`  what one roster costs, microseconds (median of 3, n=${REPEATS})`);
console.log(`    JSON.parse            ${jsonUs.toFixed(1)}`);
console.log(`    zod safeParse         ${zodUs.toFixed(1)}   (on the object; the bus pays JSON.parse first)`);
console.log(`    Node, cluster bus     ${(jsonUs + zodUs).toFixed(1)}   what voice.ts:13159 spends on a signal frame`);
console.log(`    pqp-core, shadow      ${rustUs.toFixed(1)}   parse and value walk in one pass`);
console.log("    (neither number is the egress path: a roster written to sockets is");
console.log("     encoded and never validated, so today that path pays no checking)");
console.log("");
console.log(report.trim().split("\n")[0]);
