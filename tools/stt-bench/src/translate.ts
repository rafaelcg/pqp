import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createOpenRouterChatTranslator, DEFAULT_KEEP_NAMES, TranslateError } from "../../../server/src/speech/translators/openrouter-chat.js";
import type { BenchKeys } from "./env.js";
import { REFERENCE_CLIPS, loadReference, refText, type Reference } from "./scoring.js";
import type { RunRecord, Store } from "./store.js";

export const TRANSLATION_MODELS = [
  "anthropic/claude-haiku-4.5",
  "google/gemini-2.5-flash",
  "google/gemini-3.1-flash-lite",
  "openai/gpt-4o-mini",
] as const;

export const TARGETS = ["en", "es"] as const;

/**
 * Five Baú-style posts about pqp, written for this bench (Portuguese first, as
 * the community would write them). Hosted-text safe: no real names but ours.
 */
export const BAU_POSTS: string[] = [
  "Fala, galera! A gente criou o pqp porque cansou de chat que vira vitrine de anúncio. Aqui você entra numa call, abre uma watch party com os amigos e pronto. Zero propaganda, zero pop-up, zero \"assine o Premium pra ouvir seu amigo\".",
  "Hoje teve watch party no QG: mais de duzentas pessoas no mesmo filme, o áudio do host sem engasgar e o chat bombando. Quem estava lá sabe que foi muito bom. Valeu a todo mundo que passou por aqui!",
  "O pqp é feito por dois irmãos, no tempo livre, sem investidor e sem pressa de virar unicórnio. Se algo quebrar, a gente conserta rápido e conta o que aconteceu, sem enrolação.",
  "Dica de ouro: no celular, toca no ícone do Baú pra ver o que a galera postou na semana. Foto, link do YouTube, vídeo do TikTok, tudo fica guardado ali e não some no meio da conversa.",
  "Atenção, galera: amanhã às 22h a gente faz um MoonKase day. Chega cedo, deixa o microfone mutado no começo pra não dar eco, e bora. Quem quiser levar pipoca, pode levar.",
];

export interface TranslationRecord {
  key: string;
  model: string;
  set: "transcript" | "bau";
  to: string;
  inputs: string[];
  outputs: string[];
  /** Source words, for cost per 1,000 words. */
  words: number;
  costUsd: number;
  latencyMs: number;
  error?: string;
  at: string;
}

export interface TranslateRunOptions {
  keys: BenchKeys;
  outDir: string;
  store: Store<TranslationRecord>;
  spentSoFar: () => number;
  spendCapUsd: number;
  log: (s: string) => void;
}

/** First 20 spoken sentences of the corrected transcript that are long enough to carry a meaning. */
export function transcriptSlice(ref: Reference, n = 20): string[] {
  const out: string[] = [];
  for (const clip of REFERENCE_CLIPS) {
    for (const seg of ref.clips[clip]?.segments ?? []) {
      const t = (seg.display ?? seg.text).trim();
      if (t.split(/\s+/).length >= 5 && !seg.unsure) out.push(t);
      if (out.length >= n) return out;
    }
  }
  return out;
}

const countWords = (xs: string[]) => xs.reduce((a, s) => a + s.split(/\s+/).filter(Boolean).length, 0);

export async function runTranslate(o: TranslateRunOptions & { runs?: RunRecord[] }): Promise<void> {
  const key = o.keys.OPENROUTER;
  if (!key) {
    o.log("translate: OPENROUTER unset, skipped");
    return;
  }
  const runsPath = join(o.outDir, "results.json");
  const runs = o.runs ?? (existsSync(runsPath) ? (JSON.parse(readFileSync(runsPath, "utf8")) as RunRecord[]) : []);
  const ref = loadReference(o.outDir, runs);
  const sentences = transcriptSlice(ref);
  if (sentences.length === 0) {
    o.log("translate: no reference sentences yet, skipped");
    return;
  }
  writeFileSync(join(o.outDir, "translation-input.json"), JSON.stringify({ sentences, bau: BAU_POSTS }, null, 1));
  const sets: Array<{ set: TranslationRecord["set"]; inputs: string[] }> = [
    { set: "transcript", inputs: sentences },
    { set: "bau", inputs: BAU_POSTS },
  ];
  for (const model of TRANSLATION_MODELS) {
    const translator = createOpenRouterChatTranslator({ apiKey: key, model, keepNames: DEFAULT_KEEP_NAMES });
    for (const to of TARGETS) {
      for (const s of sets) {
        const k = [model, s.set, to].join("|");
        if (o.store.has(k)) continue;
        if (o.spentSoFar() >= o.spendCapUsd) {
          o.log(`translate: spend cap ${o.spendCapUsd} USD reached`);
          return;
        }
        const t0 = Date.now();
        const base = { key: k, model, set: s.set, to, inputs: s.inputs, words: countWords(s.inputs), at: new Date().toISOString() };
        try {
          const r = await translator.translate(s.inputs, "pt", to);
          o.store.put({ ...base, outputs: r.texts, costUsd: r.costUsd ?? 0, latencyMs: Date.now() - t0 });
          o.log(`ok   ${model} ${s.set} pt->${to} $${(r.costUsd ?? 0).toFixed(5)} ${Date.now() - t0}ms`);
        } catch (e) {
          o.store.put({ ...base, outputs: [], costUsd: e instanceof TranslateError ? e.costUsd : 0, latencyMs: Date.now() - t0, error: (e as Error).message.slice(0, 300) });
          o.log(`FAIL ${model} ${s.set} pt->${to} ${(e as Error).message.slice(0, 120)}`);
        }
      }
    }
  }
}

export { refText };
