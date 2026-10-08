/**
 * STT and translation bench for pqp. Not part of the product.
 *
 *   pnpm stt:bench                      everything, resuming from results.json
 *   pnpm stt:bench -- --stage clips     cut the clips (needs the party recording)
 *   pnpm stt:bench -- --stage stt       transcribe
 *   pnpm stt:bench -- --stage translate translate (needs reference.json or the draft)
 *   pnpm stt:bench -- --stage review    write review.md: every line the providers disagree on, to correct the draft reference
 *   pnpm stt:bench -- --stage report    rebuild report.md from what is on disk
 *
 * Keys come from ~/.config/pqp/stt-bench.env (GROQ, OPENROUTER, and GROK only with --xai).
 * Nothing about a key is ever printed. Results, reference and report go to --out,
 * outside the repo. Audio is never written anywhere but --clips.
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describeKeys, loadKeys } from "./env.js";
import { buildMatrix } from "./matrix.js";
import { cutClips } from "./media.js";
import { buildReport, writeReview } from "./report.js";
import { runStt } from "./stt.js";
import { runTranslate, type TranslationRecord } from "./translate.js";
import { Store, resultsPath, type RunRecord } from "./store.js";

interface Args {
  stage: "all" | "clips" | "stt" | "translate" | "report" | "review";
  out: string;
  clips: string;
  models: string;
  mic: string;
  film: string;
  xai: boolean;
  providers?: string[];
  clipIds?: string[];
  modes?: string[];
  capUsd: number;
  priorSpendUsd: number;
}

function parseArgs(argv: string[]): Args {
  const home = homedir();
  const a: Args = {
    stage: "all",
    out: join(home, ".config", "pqp", "product", "stt-bench-2026-10-01"),
    clips: join(home, ".cache", "pqp-stt-bench", "clips"),
    models: join(home, ".cache", "pqp-stt-bench", "models"),
    mic: join(home, "Downloads", "greatest-show-2026-09-21", "attempt-2141Z-mic.ogg"),
    film: join(home, "Downloads", "greatest-show-2026-09-21", "attempt-2141Z-720p.mp4"),
    xai: false,
    capUsd: 2.5,
    priorSpendUsd: 0.015,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i] as string;
    if (k === "--") continue;
    else if (k === "--stage") a.stage = v() as Args["stage"];
    else if (k === "--out") a.out = v();
    else if (k === "--clips") a.clips = v();
    else if (k === "--models") a.models = v();
    else if (k === "--mic") a.mic = v();
    else if (k === "--film") a.film = v();
    else if (k === "--xai") a.xai = true;
    else if (k === "--providers") a.providers = v().split(",");
    else if (k === "--only-clips") a.clipIds = v().split(",");
    else if (k === "--modes") a.modes = v().split(",");
    else if (k === "--cap") a.capUsd = Number(v());
    else if (k === "--prior-spend") a.priorSpendUsd = Number(v());
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

const WHISPER_FILES = [
  { name: "small", file: "ggml-small.bin" },
  { name: "large-v3-turbo", file: "ggml-large-v3-turbo.bin" },
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = (s: string) => process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${s}\n`);
  await mkdir(args.out, { recursive: true });
  const keys = loadKeys();
  log(`keys: ${describeKeys(keys)}`);

  if (args.stage === "clips") {
    await cutClips({ mic: args.mic, film: args.film }, args.clips);
    log(`clips written to ${args.clips}`);
    return;
  }

  const store = new Store<RunRecord>(resultsPath(args.out));
  const tstore = new Store<TranslationRecord>(join(args.out, "translations.json"));
  const spent = () =>
    args.priorSpendUsd +
    store.all().filter((r) => r.provider.startsWith("openrouter/") || r.provider.startsWith("xai/")).reduce((a, r) => a + r.costUsd, 0) +
    tstore.all().reduce((a, r) => a + r.costUsd, 0);

  if (args.stage === "review") {
    writeReview(args.out, store.all());
    log(`review.md written to ${args.out}`);
    return;
  }

  if (args.stage === "all" || args.stage === "stt") {
    if (!existsSync(join(args.clips, "dense1.flac"))) {
      throw new Error(`no clips in ${args.clips}; run --stage clips first`);
    }
    const present = existsSync(args.models) ? readdirSync(args.models) : [];
    const whisperModels = WHISPER_FILES.filter((m) => present.includes(m.file));
    if (whisperModels.length === 0) {
      log(
        `no ggml models in ${args.models}; whisper.cpp is skipped. Official files: https://huggingface.co/ggerganov/whisper.cpp (ggml-small.bin, ggml-large-v3-turbo.bin)`,
      );
    }
    await runStt({
      specs: buildMatrix({ modelsDir: args.models, whisperModels, includeXai: args.xai }),
      keys,
      clipsDir: args.clips,
      store,
      spendCapUsd: args.capUsd,
      spentSoFar: spent,
      only: { providers: args.providers, clips: args.clipIds, modes: args.modes },
      log,
    });
    log(`paid spend so far: ${spent().toFixed(4)} USD (cap ${args.capUsd})`);
  }

  if (args.stage === "all" || args.stage === "translate") {
    await runTranslate({ keys, outDir: args.out, store: tstore, spentSoFar: spent, spendCapUsd: args.capUsd, log });
    log(`paid spend so far: ${spent().toFixed(4)} USD (cap ${args.capUsd})`);
  }

  await buildReport({ outDir: args.out, store, tstore, spentUsd: spent(), priorSpendUsd: args.priorSpendUsd, log });
}

main().catch((e) => {
  console.error(`stt-bench failed: ${(e as Error).message}`);
  process.exit(1);
});
