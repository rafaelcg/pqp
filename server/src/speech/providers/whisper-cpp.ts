import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadAudio } from "../audio.js";
import type { SttOptions, SttProvider, SttResult, SttSegment } from "../types.js";

const execFileP = promisify(execFile);

export interface WhisperCppOptions {
  /** Path to a ggml model from the official ggerganov/whisper.cpp repository. */
  modelPath: string;
  /** Label used in `id`, e.g. "large-v3-turbo". */
  modelName?: string;
  bin?: string;
  threads?: number;
  /** Test seam: replaces the child process. Receives argv, resolves once the JSON file exists. */
  run?: (bin: string, args: string[], signal?: AbortSignal) => Promise<void>;
}

/** Pure argv builder, exported so the offline tests pin the command line. */
export function buildWhisperCppArgs(
  o: Pick<WhisperCppOptions, "modelPath" | "threads">,
  inputPath: string,
  outputBase: string,
  opts: SttOptions,
): string[] {
  return [
    "-m",
    o.modelPath,
    "-f",
    inputPath,
    "-l",
    opts.language ?? "auto",
    "-t",
    String(o.threads ?? 8),
    "-oj",
    "-of",
    outputBase,
    "-np",
    ...(opts.prompt ? ["--prompt", opts.prompt] : []),
  ];
}

interface WhisperCppJson {
  result?: { language?: string };
  transcription?: Array<{ offsets?: { from?: number; to?: number }; text?: string }>;
}

export function parseWhisperCppJson(body: WhisperCppJson): Pick<SttResult, "text" | "segments" | "language"> & {
  lastEndMs: number;
} {
  const segments: SttSegment[] = (body.transcription ?? [])
    .map((t) => ({
      start: (t.offsets?.from ?? 0) / 1000,
      end: (t.offsets?.to ?? 0) / 1000,
      text: (t.text ?? "").trim(),
    }))
    .filter((s) => s.text.length > 0);
  return {
    text: segments.map((s) => s.text).join(" "),
    segments,
    language: body.result?.language,
    lastEndMs: Math.round((segments.at(-1)?.end ?? 0) * 1000),
  };
}

const defaultRun: NonNullable<WhisperCppOptions["run"]> = async (bin, args, signal) => {
  await execFileP(bin, args, { signal, maxBuffer: 64 * 1024 * 1024 });
};

/** Local whisper.cpp. Free, offline, and the speed baseline: cost is always 0. */
export function createWhisperCppProvider(o: WhisperCppOptions): SttProvider {
  const bin = o.bin ?? "whisper-cli";
  const run = o.run ?? defaultRun;
  return {
    id: `whisper-cpp/${o.modelName ?? "model"}`,
    async transcribe(audio, opts: SttOptions): Promise<SttResult> {
      const a = await loadAudio(audio, opts.format);
      const dir = await mkdtemp(join(tmpdir(), "pqp-whispercpp-"));
      try {
        const input = join(dir, `in.${a.format}`);
        await writeFile(input, a.bytes);
        const base = join(dir, "out");
        await run(bin, buildWhisperCppArgs(o, input, base, opts), opts.signal);
        const parsed = parseWhisperCppJson(JSON.parse(await readFile(`${base}.json`, "utf8")) as WhisperCppJson);
        return {
          text: parsed.text,
          segments: parsed.segments,
          language: parsed.language,
          durationMs: parsed.lastEndMs,
          costUsd: 0,
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
