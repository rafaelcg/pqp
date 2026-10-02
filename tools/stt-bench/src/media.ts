import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const SAMPLE_RATE = 16_000;

/** Decode anything ffmpeg reads to mono 16 kHz s16 PCM, in memory. */
export async function decodePcm16k(path: string): Promise<Int16Array> {
  const { stdout } = await execFileP(
    "ffmpeg",
    ["-v", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", String(SAMPLE_RATE), "pipe:1"],
    { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 },
  );
  const buf = stdout as unknown as Buffer;
  return new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength - (buf.byteLength % 2)));
}

export function pcmToWav(pcm: Int16Array, sampleRate = SAMPLE_RATE): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function slicePcm(pcm: Int16Array, startMs: number, endMs: number): Int16Array {
  const a = Math.floor((startMs / 1000) * SAMPLE_RATE);
  const b = Math.min(pcm.length, Math.floor((endMs / 1000) * SAMPLE_RATE));
  return pcm.subarray(a, b);
}

export interface ClipSpec {
  id: string;
  seconds: number;
  /** Where it comes from. `noise` is synthetic pink noise, the rest are cut from the party recording. */
  source: "mic" | "film" | "mix" | "noise" | "say";
  startSeconds: number;
  /** What the clip is for. */
  purpose: "speech" | "speech-with-film" | "hallucination" | "glossary";
  note: string;
}

/**
 * The bench's clip recipe. Offsets are into `attempt-2141Z-mic.ogg`, whose first
 * 769 s is digital silence (nothing was said yet), so speech lives in 769 to 1307 s.
 */
export const CLIPS: ClipSpec[] = [
  { id: "dense1", seconds: 180, source: "mic", startSeconds: 765, purpose: "speech", note: "host mic, 765 to 945 s, densest stretch" },
  { id: "dense2", seconds: 180, source: "mic", startSeconds: 945, purpose: "speech", note: "host mic, 945 to 1125 s" },
  { id: "dense3", seconds: 180, source: "mic", startSeconds: 1125, purpose: "speech", note: "host mic, 1125 to 1305 s, sparse" },
  { id: "mic60", seconds: 60, source: "mic", startSeconds: 780, purpose: "speech", note: "host mic only, 780 to 840 s" },
  { id: "mixed", seconds: 60, source: "mix", startSeconds: 780, purpose: "speech-with-film", note: "same 60 s as mic60 with the film's audio mixed in at recorded levels" },
  { id: "silence", seconds: 60, source: "mic", startSeconds: 300, purpose: "hallucination", note: "digital silence (mic gated before anybody spoke)" },
  { id: "quiet", seconds: 60, source: "mic", startSeconds: 1004, purpose: "hallucination", note: "host mic, 1004 to 1064 s, long pauses between short remarks" },
  { id: "noise", seconds: 60, source: "noise", startSeconds: 0, purpose: "hallucination", note: "synthetic pink noise at about -53 dBFS, a hot mic in a quiet room" },
  { id: "names", seconds: 20.3, source: "say", startSeconds: 0, purpose: "glossary", note: "synthetic: macOS Luciana (pt-BR) reading six sentences full of the glossary words; isolates the prompt effect because the real clips hold almost no proper nouns" },
  { id: "film", seconds: 60, source: "film", startSeconds: 1000, purpose: "hallucination", note: "the film's audio alone while the host is quiet (not what the product would send)" },
];

/** What the synthetic `names` clip says, and what a correct transcript of it looks like. */
export const NAMES_SPOKEN = [
  "Bem-vindos ao pê quê pê, hoje tem watch party no quê gê.",
  "O MoonKase vai abrir a live às dez da noite.",
  "Passa no Baú pra ver as fotos que a galera postou.",
  "Abre o Discord ou entra direto na call do pê quê pê.",
  "A gente usa o LiveKit pra fazer a call com muita gente.",
  "Manda o link no quê gê que eu entro.",
];

export const NAMES_REFERENCE = [
  "Bem-vindos ao pqp, hoje tem watch party no QG.",
  "O MoonKase vai abrir a live às dez da noite.",
  "Passa no Baú pra ver as fotos que a galera postou.",
  "Abre o Discord ou entra direto na call do pqp.",
  "A gente usa o LiveKit pra fazer a call com muita gente.",
  "Manda o link no QG que eu entro.",
].join(" ");

export interface ClipSources {
  mic: string;
  /** The party's shared-tab audio (a video file is fine). */
  film: string;
}

/** Cut every clip as 16 kHz mono FLAC under `dir`. Originals are only read. */
export async function cutClips(src: ClipSources, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const run = (args: string[]) => execFileP("ffmpeg", ["-v", "error", "-y", ...args]);
  for (const c of CLIPS) {
    const out = join(dir, `${c.id}.flac`);
    const t = ["-ss", String(c.startSeconds), "-t", String(c.seconds)];
    if (c.source === "mic") await run([...t, "-i", src.mic, "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", out]);
    else if (c.source === "film") await run([...t, "-i", src.film, "-vn", "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", out]);
    else if (c.source === "mix") {
      await run([
        ...t, "-i", src.mic, ...t, "-i", src.film,
        "-filter_complex", "[0:a]aformat=sample_rates=16000:channel_layouts=mono[a];[1:a]aformat=sample_rates=16000:channel_layouts=mono[b];[a][b]amix=inputs=2:duration=first:normalize=0",
        "-vn", "-sample_fmt", "s16", out,
      ]);
    } else if (c.source === "say") {
      // macOS only. Spoken forms ("pê quê pê") are what a person says; the reference writes the names.
      const aiff = join(dir, "names.aiff");
      await execFileP("say", ["-v", "Luciana", "-o", aiff, NAMES_SPOKEN.join(" ")]);
      await run(["-i", aiff, "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", out]);
    } else {
      await run(["-f", "lavfi", "-i", `anoisesrc=color=pink:amplitude=0.012:sample_rate=16000:duration=${c.seconds}`, "-ac", "1", "-sample_fmt", "s16", out]);
    }
  }
}
