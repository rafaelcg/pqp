import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeForScoring } from "../../../server/src/speech/metrics.js";
import { CLIPS } from "./media.js";
import { GLOSSARY } from "./matrix.js";
import { NAMES_REFERENCE } from "./media.js";
import { REFERENCE_CLIPS, disagreements, loadReference, pooled, refText, score, type Score } from "./scoring.js";
import type { RunRecord, Store } from "./store.js";
import { TRANSLATION_MODELS, TARGETS, type TranslationRecord } from "./translate.js";

export interface ReportOptions {
  outDir: string;
  store: Store<RunRecord>;
  tstore: Store<TranslationRecord>;
  spentUsd: number;
  priorSpendUsd: number;
  log: (s: string) => void;
}

const LANE_ORDER = ["whisper-cpp", "groq", "openrouter", "xai"];
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number, d = 4) => `$${x.toFixed(d)}`;
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] : NaN);
const p95 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.95) - 1)] : NaN);
const wordsOf = (t: string) => normalizeForScoring(t).split(" ").filter(Boolean).length;
const table = (head: string[], rows: string[][]) =>
  [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}...` : s);
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function providerOrder(runs: RunRecord[]): string[] {
  const ids = [...new Set(runs.map((r) => r.provider))];
  return ids.sort((a, b) => {
    const la = LANE_ORDER.findIndex((l) => a.startsWith(l));
    const lb = LANE_ORDER.findIndex((l) => b.startsWith(l));
    return la - lb || a.localeCompare(b);
  });
}

export async function buildReport(o: ReportOptions): Promise<void> {
  const runs = o.store.all();
  if (runs.length === 0) {
    o.log("report: no results yet");
    return;
  }
  const ref = loadReference(o.outDir, runs);
  const providers = providerOrder(runs);
  const find = (p: string, clip: string, mode: string, config: string) =>
    runs.find((r) => r.provider === p && r.clip === clip && r.mode === mode && r.config === config && !r.error);
  const failed = runs.filter((r) => r.error);

  const scoreOf = (r: RunRecord | undefined, clip: string): Score | undefined =>
    r ? score(refText(ref, clip), r.text) : undefined;

  // ---- A. whole-file accuracy, forced Portuguese ----
  const speechRows: string[][] = [];
  const pooledByProvider = new Map<string, { wer: number; werNoLoops: number; cer: number; loops: number }>();
  for (const p of providers) {
    const per = ["dense1", "dense2", "dense3"].map((c) => scoreOf(find(p, c, "whole", "pt"), c));
    const have = per.filter((s): s is Score => !!s);
    const pl = have.length === 3 ? pooled(have) : undefined;
    if (pl) pooledByProvider.set(p, pl);
    const wholeRuns = runs.filter((r) => r.provider === p && r.mode === "whole" && !r.error);
    const hours = wholeRuns.reduce((a, r) => a + r.audioMs, 0) / 3_600_000;
    const cost = wholeRuns.reduce((a, r) => a + r.costUsd, 0);
    const kind = wholeRuns[0]?.costKind ?? "computed";
    const dense = ["dense1", "dense2", "dense3"].map((c) => find(p, c, "whole", "pt")).filter((r): r is RunRecord => !!r);
    const rtf = dense.length ? dense.reduce((a, r) => a + r.latencyMs, 0) / dense.reduce((a, r) => a + r.audioMs, 0) : NaN;
    speechRows.push([
      `\`${p}\``,
      ...per.map((s) => (s ? pct(s.wer) : "n/a")),
      pl ? pct(pl.wer) : "n/a",
      pl ? `**${pct(pl.werNoLoops)}**` : "n/a",
      pl ? String(pl.loops) : "n/a",
      pl ? pct(pl.cer) : "n/a",
      Number.isFinite(rtf) ? rtf.toFixed(3) : "n/a",
      hours ? `${usd(cost / hours, 3)}${kind === "reported" ? "" : kind === "free" ? " (local)" : " (list)"}` : "n/a",
    ]);
  }

  // ---- B. language handling ----
  const cfgRows: string[][] = [];
  for (const p of providers) {
    const cells = (["auto", "pt", "gloss"] as const).map((cfg) => {
      const ss = ["dense1", "dense2", "dense3"].map((c) => scoreOf(find(p, c, "whole", cfg), c));
      return ss.every(Boolean) ? pct(pooled(ss as Score[]).werNoLoops) : "n/a";
    });
    const langs = ["dense1", "dense2", "dense3", "mic60"].map((c) => find(p, c, "whole", "auto")?.language ?? "?");
    cfgRows.push([`\`${p}\``, ...cells, langs.join(" / ")]);
  }

  // ---- C. glossary terms, on the synthetic `names` clip (the real clips hold almost no proper nouns) ----
  const NAME_TERMS: Array<[string, number]> = [["pqp", 2], ["watch party", 1], ["qg", 2], ["moonkase", 1], ["baú", 1], ["discord", 1], ["livekit", 1]];
  const NAME_TOTAL = NAME_TERMS.reduce((a, [, n]) => a + n, 0);
  const lowerNorm = (t: string) => ` ${normalizeForScoring(t)} `;
  const termHits = (text: string) =>
    NAME_TERMS.reduce((a, [t, n]) => a + Math.min(n, lowerNorm(text).split(` ${t} `).length - 1), 0);
  const termRows: string[][] = [];
  for (const p of providers) {
    const cell = (cfg: string) => {
      const r = find(p, "names", "whole", cfg);
      return r ? `${termHits(r.text)}/${NAME_TOTAL} (WER ${pct(score(NAMES_REFERENCE, r.text).werNoLoops)})` : "n/a";
    };
    termRows.push([`\`${p}\``, cell("pt"), cell("gloss")]);
  }

  // ---- D. chunked vs whole on dense1 ----
  const chunkRows: string[][] = [];
  for (const p of providers) {
    const w = scoreOf(find(p, "dense1", "whole", "pt"), "dense1");
    const cells = (["chunked", "chunked-gated"] as const).map((m) => {
      const r = find(p, "dense1", m, "pt");
      return r ? pct(scoreOf(r, "dense1")!.werNoLoops) : "n/a";
    });
    const gloss = find(p, "dense1", "chunked-gated-gloss", "gloss");
    const carry = find(p, "dense1", "chunked-gated-carry", "gloss");
    const ch = find(p, "dense1", "chunked", "pt");
    // Groq is measured on the paced run: the unpaced one's per-window time includes waiting out 429s.
    const lat = (find(p, "dense1", "chunked-paced", "pt") ?? ch)?.windowLatenciesMs ?? [];
    chunkRows.push([
      `\`${p}\``,
      w ? pct(w.werNoLoops) : "n/a",
      ...cells,
      gloss ? pct(scoreOf(gloss, "dense1")!.werNoLoops) : "-",
      carry ? pct(scoreOf(carry, "dense1")!.werNoLoops) : "-",
      ch ? String(ch.requests) : "n/a",
      lat.length ? `${Math.round(median(lat))} ms` : "n/a",
      lat.length ? `${Math.round(p95(lat))} ms` : "n/a",
      lat.length ? (median(lat) / 8000).toFixed(3) : "n/a",
      ch ? `${ch.retries429}` : "n/a",
    ]);
  }

  // ---- D2. window size sweep ----
  const sweepModes = ["chunked-w6o1", "chunked-gated", "chunked-w10o1", "chunked-w10o2"];
  const sweepRows: string[][] = [];
  for (const p of ["whisper-cpp/large-v3-turbo", "groq/whisper-large-v3-turbo"]) {
    const cells = sweepModes.map((m) => {
      const r = find(p, "dense1", m, "pt");
      return r ? `${pct(scoreOf(r, "dense1")!.werNoLoops)} (${r.requests} req)` : "n/a";
    });
    if (cells.some((c) => c !== "n/a")) sweepRows.push([`\`${p}\``, ...cells]);
  }

  // ---- D3. what the gate skipped on real speech ----
  const gateRun =
    find("whisper-cpp/large-v3-turbo", "dense1", "chunked-gated", "pt") ??
    runs.find((r) => r.clip === "dense1" && r.mode === "chunked-gated" && r.windows);
  let gateNote = "";
  if (gateRun?.windows) {
    const speechSegs = (ref.clips.dense1?.segments ?? []).filter((s) => s.text.trim());
    const overlaps = (w: { startMs: number; endMs: number }) =>
      speechSegs.some((s) => Math.min(s.end, w.endMs / 1000) - Math.max(s.start, w.startMs / 1000) >= 0.3);
    const skipped = gateRun.windows.filter((w) => w.skipped);
    const wrong = skipped.filter(overlaps);
    gateNote = `Energy gate on dense1: ${gateRun.windows.length} windows, ${skipped.length} skipped, ${wrong.length} of those overlap a reference line${wrong.length ? ` (at ${wrong.map((w) => fmtT(w.startMs / 1000)).join(", ")})` : ""}.`;
  }

  // ---- E. film audio ----
  const mixRows: string[][] = [];
  for (const p of providers) {
    const a = find(p, "mic60", "whole", "pt");
    const b = find(p, "mixed", "whole", "pt");
    if (!a || !b) continue;
    const sa = score(refText(ref, "mic60"), a.text);
    const sb = score(refText(ref, "mic60"), b.text);
    mixRows.push([`\`${p}\``, pct(sa.werNoLoops), pct(sb.werNoLoops), `${sb.werNoLoops - sa.werNoLoops >= 0 ? "+" : ""}${((sb.werNoLoops - sa.werNoLoops) * 100).toFixed(1)} pt`]);
  }

  // ---- F. hallucination ----
  const HALLU = /obrigad|legenda|thanks for watching|subscribe|inscreva|amara\.org|www\.|\.com|até a próxima|see you|thank you|\[música\]|\[som/i;
  const halluRows: string[][] = [];
  const invented = new Map<string, Set<string>>();
  for (const p of providers) {
    const cells: string[] = [];
    for (const clip of ["silence", "noise", "quiet", "film"]) {
      const w = find(p, clip, "whole", "pt");
      const a = find(p, clip, "whole", "auto");
      const c = find(p, clip, "chunked", "pt");
      const g = find(p, clip, "chunked-gated", "pt");
      // Chunked runs are counted from what each window returned, before stitching: the stitcher
      // drops some zero-length invented segments, which would hide exactly what this table is for.
      const raw = (r: RunRecord) => (r.windows ? r.windows.map((x) => x.text).join(" ") : r.text);
      const n = (r?: RunRecord) => (r ? String(wordsOf(raw(r))) : "n/a");
      cells.push(`${n(w)} / ${n(a)} / ${n(c)} / ${n(g)}`);
      for (const r of [w, a, c]) {
        if (r && clip !== "film" && clip !== "quiet" && raw(r).trim()) {
          const s = invented.get(p) ?? new Set<string>();
          s.add(`${clip} ${r.mode}/${r.config}: "${trunc(raw(r).trim(), 90)}"${HALLU.test(raw(r)) ? " (known phrase)" : ""}`);
          invented.set(p, s);
        }
      }
    }
    halluRows.push([`\`${p}\``, ...cells]);
  }

  // ---- G. 429 handling ----
  const rateRows = providers
    .map((p) => {
      const rs = runs.filter((r) => r.provider === p);
      return [`\`${p}\``, String(rs.reduce((a, r) => a + r.requests, 0)), String(rs.reduce((a, r) => a + r.retries429, 0)), String(rs.filter((r) => r.error).length)];
    })
    .filter((r) => r[2] !== "0" || r[3] !== "0");

  // ---- H. translation ----
  const trows: string[][] = [];
  const tnotes: string[] = [];
  const KEEP = ["pqp", "Baú", "QG", "MoonKase", "watch party"];
  for (const model of TRANSLATION_MODELS) {
    for (const to of TARGETS) {
      const recs = o.tstore.all().filter((r) => r.model === model && r.to === to && !r.error);
      if (recs.length === 0) continue;
      const words = recs.reduce((a, r) => a + r.words, 0);
      const cost = recs.reduce((a, r) => a + r.costUsd, 0);
      const lat = recs.reduce((a, r) => a + r.latencyMs, 0);
      const bau = recs.find((r) => r.set === "bau");
      const outTxt = (bau?.outputs ?? []).join(" ");
      const inTxt = (bau?.inputs ?? []).join(" ");
      const kept = KEEP.filter((k) => inTxt.toLowerCase().includes(k.toLowerCase()));
      const lost = kept.filter((k) => !outTxt.toLowerCase().includes(k.toLowerCase()));
      const countOk = recs.every((r) => r.outputs.length === r.inputs.length);
      const ratio = recs.reduce((a, r) => a + wordsOf(r.outputs.join(" ")), 0) / Math.max(1, recs.reduce((a, r) => a + wordsOf(r.inputs.join(" ")), 0));
      const chatter = recs.filter((r) => r.set === "bau").some((r) => r.outputs.some((t) => /^(here is|here are|here's the|sure[,!. ]|translation:|note:|claro[,!]|aqu[ií] est[aá]|la traducci[oó]n|traducci[oó]n:)/i.test(t.trim())));
      trows.push([
        `\`${model}\``,
        to,
        usd((cost / Math.max(1, words)) * 1000, 5),
        `${Math.round(lat / recs.length)} ms`,
        countOk ? "yes" : "NO",
        lost.length ? `lost: ${lost.join(", ")}` : "all kept",
        ratio.toFixed(2),
        chatter ? "YES" : "none seen",
      ]);
    }
  }
  const failedT = o.tstore.all().filter((r) => r.error);
  for (const e of failedT) tnotes.push(`- ${e.model} ${e.set} pt->${e.to}: ${e.error}`);

  // ---- I. disagreements ----
  const dis = disagreements(ref, runs).slice(0, 15);
  const disLines = dis.map((d, i) => {
    const groups = new Map<string, string[]>();
    for (const v of d.variants) groups.set(v.text, [...(groups.get(v.text) ?? []), v.provider.replace(/^openrouter\/openai\//, "or/").replace(/^openrouter\//, "or/")]);
    const body = [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([t, ps]) => `   - "${t || "(nothing)"}" : ${ps.join(", ")}`)
      .join("\n");
    return `${i + 1}. **${d.clip} ${fmtT(d.start)}** reference: "${d.reference}"${refUnsure(ref, d.clip, d.start) ? " (reference line is a guess)" : ""}\n${body}`;
  });

  // ---- clip table ----
  const clipRows = CLIPS.map((c) => [`\`${c.id}\``, `${c.seconds}s`, c.purpose, c.note]);

  const recPath = join(o.outDir, "recommendation.md");
  const rec = existsSync(recPath) ? readFileSync(recPath, "utf8").trim() : "_No recommendation.md in the output directory yet._";

  const md = [
    "# STT and translation bench, 2026-10-01",
    "",
    rec,
    "",
    "---",
    "",
    "## Method in one paragraph",
    "",
    `Audio is the host's microphone only from one real watch party: a 22 minute file whose first 13 minutes are digital silence, then sparse speech (the three 3-minute clips hold about ${["dense1", "dense2", "dense3"].reduce((a, c) => a + refText(ref, c).split(" ").filter(Boolean).length, 0)} spoken words in total), pt-BR with English game and stream words. There is **no ground truth**. The reference is a **consensus, not human-verified**: every provider's whole-file output (loops collapsed) voted word by word over a skeleton (${[...new Set(REFERENCE_CLIPS.map((c) => ref.clips[c]?.seedProvider).filter(Boolean))].join(", ")}), then I read every disputed line side by side and resolved it by majority and pt-BR judgment, flagging the ${REFERENCE_CLIPS.reduce((a, c) => a + (ref.clips[c]?.segments.filter((s) => s.unsure).length ?? 0), 0)} lines I could not settle. I am a model, not a native speaker. Reference status in this build: **${ref.status}**${ref.status === "draft" ? " (machine vote only, not yet corrected)" : ""}. Providers that seeded the vote have a small built-in advantage. WER and CER normalise case, punctuation and number formatting but not accents. Paid spend: **${usd(o.spentUsd, 3)}** (the cost each OpenRouter response reported, plus ${usd(o.priorSpendUsd, 3)} of manual probes before the run). Groq and whisper.cpp are free here (Groq free tier, local GPU), their dollar figures are list prices.`,
    "",
    "## Clips",
    "",
    table(["clip", "length", "purpose", "what it is"], clipRows),
    "",
    "## 1. Accuracy, whole file, language forced to pt",
    "",
    "WER against the consensus reference. Whole-file Whisper loops on long silences (one phrase repeated dozens of times, or an invented credit), which is what `loops` counts; `WER without loops` collapses those runs first, so the ranking is about accuracy and the loops column is about the failure. `RTF` is wall time over audio time for the whole-file request (lower is faster; includes upload and, for whisper.cpp, model load). `$/audio-h` is the measured cost per hour of audio: reported by the API where it says so, otherwise the list price.",
    "",
    table(["provider", "dense1", "dense2", "dense3", "pooled WER", "WER without loops", "loops", "pooled CER", "RTF", "$/audio-h"], speechRows),
    "",
    "## 2. Language handling and glossary",
    "",
    "Pooled WER (loops collapsed) on the three dense clips for each setting. `auto` sends no language, `pt` forces Portuguese, `gloss` forces Portuguese and sends the glossary (`" + GLOSSARY + "`) as the prompt (Whisper family) or as key terms (Grok). The last column is the language each provider reported under `auto` for dense1, dense2, dense3, mic60.",
    "",
    table(["provider", "auto", "pt", "pt + glossary", "auto-detected as"], cfgRows),
    "",
    "Proper nouns, on a synthetic clip (`names`: macOS Luciana, pt-BR, reading six sentences with pqp, QG, MoonKase, Baú, Discord, LiveKit and watch party; the real clips hold almost none, so this isolates the prompt). Exact spelling counts, `live kit` is a miss. `forced pt` vs `forced pt + glossary`:",
    "",
    table(["provider", "terms right, forced pt", "terms right, with glossary"], termRows),
    "",
    "## 3. Chunked live path vs whole file (dense1)",
    "",
    "8 s windows with 1 s overlap, sent one at a time, stitched by timestamp with the overlap de-duplicated (`server/src/speech/chunker.ts`). `gated` skips windows that fail the energy gate (20 ms frames, -45 dBFS, at least 400 ms of speech). `glossary` sends the glossary as the prompt on every window, `carry` additionally feeds the last 160 characters heard back. `req` is the number of requests for 180 s of audio. Window latency and RTF are per 8 s request. `429s` counts rate-limit retries during that run.",
    "",
    table(["provider", "whole WER", "chunked WER", "gated WER", "gated + glossary", "gated + glossary + carry", "req", "median latency", "p95 latency", "RTF (8 s)", "429s"], chunkRows),
    "",
    sweepRows.length
      ? "Window size on dense1 (gated, forced pt), 6 s / 1 s overlap, the default 8 s / 1 s, 10 s / 1 s and 10 s / 2 s:\n\n" +
        table(["provider", "6 s + 1 s", "8 s + 1 s", "10 s + 1 s", "10 s + 2 s"], sweepRows)
      : "",
    "",
    gateNote,
    "",
    "## 4. Film audio mixed in (60 s)",
    "",
    "Same 60 s as `mic60`, with the film's soundtrack mixed in at its recorded level. WER is against the `mic60` reference, so the film's own dialogue counts as errors.",
    "",
    table(["provider", "mic only", "mic + film", "delta"], mixRows),
    "",
    "## 5. Hallucination on silence and background",
    "",
    "Words returned per clip as `whole pt / whole auto / chunked / chunked + gate`. `silence` is digital zero, `noise` is synthetic pink noise at about -53 dBFS, `quiet` is real host mic with long pauses (so some real speech is expected), `film` is the film's own audio (real speech, so words there are not invented).",
    "",
    table(["provider", "silence", "noise", "quiet", "film"], halluRows),
    "",
    "What came back on `silence` and `noise`, which have no speech at all:",
    "",
    [...invented.entries()].map(([p, s]) => `- \`${p}\`\n${[...s].map((x) => `  - ${esc(x)}`).join("\n")}`).join("\n") || "- nothing: every provider returned empty text on the no-speech clips.",
    "",
    "## 6. Rate limits and failures",
    "",
    rateRows.length ? table(["provider", "requests", "429 retries", "failed runs"], rateRows) : "No 429s and no failed runs.",
    "",
    failed.length ? "Failed runs (message only, no secrets):\n\n" + failed.map((r) => `- \`${r.provider}\` ${r.clip} ${r.mode}/${r.config}: ${esc(r.error ?? "")}`).join("\n") : "",
    "",
    "## 7. Translation pt-BR to en and es",
    "",
    "20 sentences from the corrected transcript plus 5 Baú-style posts written for this bench, one batch per set. Cost is per 1,000 source words. `kept names` checks pqp, Baú, QG, MoonKase and watch party survived in the posts. `length` is output words over input words. Quality notes that need reading are in `translations.json`.",
    "",
    trows.length ? table(["model", "to", "$/1,000 words", "latency/request", "count preserved", "kept names", "length", "commentary"], trows) : "No translation results yet.",
    "",
    tnotes.length ? "Translation failures:\n\n" + tnotes.join("\n") : "",
    "",
    "## 8. The 15 lines providers disagreed on most",
    "",
    "For a two-minute spot check by a native pt-BR speaker. Each line is the reference text, then what each provider produced for the same stretch (normalised: lowercase, no punctuation), grouped by identical output. Timestamps are into the clip.",
    "",
    disLines.join("\n\n") || "_No disagreements computed yet._",
    "",
    "## Caveats",
    "",
    "- The reference is a consensus of the providers' own output read by a model, not a human transcript. Treat WER as a ranking, not an absolute error rate; a native speaker should check section 8 and correct `reference.json`, then re-run `pnpm stt:bench -- --stage report`.",
    "- One speaker, one party, one microphone and room, a few hundred spoken words in the scored clips (one wrong word moves WER by about half a point). Slang, accents and audio chain are specific to it.",
    "- A third of the scored words sit in lines the reference marks as a guess, and the film's own song leaks into the mic in dense2. Differences of a few points between providers are within that noise; the large gaps (loops, invented credits, chunked collapse, latency, cost) are not.",
    "- The mic file is gated before it reaches us: it is exact digital silence when nobody speaks. That makes real silence easy, and it is why the noise clip is synthetic.",
    "- Window latency is from one machine on one connection at one hour. whisper.cpp ran as a fresh process per request here, so its per-window latency includes loading the model; a resident `whisper-server` would be faster.",
    "- Groq's free tier caps at 20 requests a minute and 7,200 audio seconds an hour; the 429 column shows how that behaved. Per-request minimum billing is 10 s, so 8 s windows cost 25% more than their length.",
    "- Prices move. Numbers here are what the providers and OpenRouter reported on the day of the run.",
    "",
  ].join("\n");

  writeFileSync(join(o.outDir, "report.md"), md);
  o.log(`report written to ${join(o.outDir, "report.md")}`);
}

function fmtT(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * review.md: every reference line the providers did not all agree on, with each
 * distinct rendering and who produced it. This is what a human reads to turn
 * reference.draft.json into reference.json.
 */
export function writeReview(outDir: string, runs: RunRecord[]): void {
  const ref = loadReference(outDir, runs);
  const lines: string[] = ["# Lines to review", ""];
  for (const d of disagreements(ref, runs).sort((a, b) => a.clip.localeCompare(b.clip) || a.start - b.start)) {
    if (d.providersDiffering === 0) continue;
    const groups = new Map<string, string[]>();
    for (const v of d.variants) {
      groups.set(v.text, [...(groups.get(v.text) ?? []), v.provider.replace(/^openrouter\/openai\//, "or/").replace(/^openrouter\//, "or/")]);
    }
    lines.push(`## ${d.clip} ${fmtT(d.start)} (draft: "${d.reference}")`);
    for (const [t, ps] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) lines.push(`- "${t || "(nothing)"}" : ${ps.join(", ")}`);
    lines.push("");
  }
  writeFileSync(join(outDir, "review.md"), lines.join("\n"));
}

function refUnsure(ref: ReturnType<typeof loadReference>, clip: string, start: number): boolean {
  return !!ref.clips[clip]?.segments.find((s) => s.start === start)?.unsure;
}
