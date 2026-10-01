import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  alignTokens,
  cer,
  collapseLoops,
  medoid,
  normalizeForScoring,
  roverVote,
  wer,
} from "../../../server/src/speech/metrics.js";
import type { RunRecord } from "./store.js";

/** Clips that get a consensus reference. `mixed` is scored against `mic60` (same speech, no film). */
export const REFERENCE_CLIPS = ["dense1", "dense2", "dense3", "mic60"];

export interface RefSegment {
  start: number;
  end: number;
  /** What the references is scored against: lowercase, no punctuation (normalised). */
  text: string;
  /** The seed provider's own punctuated line, for reading and for the translation sample. */
  display?: string;
  /** How many of the voters agreed on the average word of this line (0 to 1). */
  agreement?: number;
  /** Set by hand when the consensus itself is a guess. */
  unsure?: boolean;
  note?: string;
}

export interface Reference {
  /** "draft" is the machine vote, "reviewed" has been read and corrected by hand. */
  status: "draft" | "reviewed";
  clips: Record<string, { seedProvider?: string; voters?: string[]; segments: RefSegment[] }>;
}

export function refText(r: Reference, clip: string): string {
  return (r.clips[clip]?.segments ?? []).map((s) => s.text).join(" ");
}

const toks = (t: string) => normalizeForScoring(t).split(" ").filter(Boolean);

/** Whole-file, forced-Portuguese runs, loops collapsed: the voters for a clip. */
export function consensusHypotheses(runs: RunRecord[], clip: string) {
  return runs
    .filter((r) => r.clip === clip && r.mode === "whole" && r.config === "pt" && !r.error && r.text.trim().length > 0)
    .map((r) => {
      const c = collapseLoops(r.text);
      return { id: r.provider, text: c.text, loops: c.loops, run: r };
    });
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * ROVER-style consensus: the skeleton is the most central loop-free provider
 * that has real segment timestamps, then every provider votes word by word.
 */
export function buildDraftReference(runs: RunRecord[]): Reference {
  const ref: Reference = { status: "draft", clips: {} };
  for (const clip of REFERENCE_CLIPS) {
    const hyps = consensusHypotheses(runs, clip);
    const candidates = hyps.filter((h) => h.loops === 0 && h.run.segments.length >= 3);
    const seed = medoid(candidates.map((h) => ({ id: h.id, text: h.text })));
    if (!seed) continue;
    const seedRun = candidates.find((h) => h.id === seed.id)!.run;
    const segs = seedRun.segments.filter((s) => toks(s.text).length > 0);
    const segTokens = segs.map((s) => toks(s.text));
    const skeleton = segTokens.flat();
    const voters = hyps.filter((h) => h.id !== seed.id);
    const votes = roverVote(skeleton, voters.map((h) => toks(h.text)));
    let at = 0;
    ref.clips[clip] = {
      seedProvider: seed.id,
      voters: voters.map((v) => v.id),
      segments: segs.map((s, si) => {
        const n = (segTokens[si] as string[]).length;
        const slice = votes.slice(at, at + n);
        at += n;
        const agreement = slice.reduce((a, v) => a + v.agree / v.voters, 0) / Math.max(1, slice.length);
        return {
          start: round(s.start),
          end: round(s.end),
          text: slice.flatMap((v) => v.tokens).join(" "),
          display: s.text.trim(),
          agreement: round(agreement),
        };
      }),
    };
  }
  return ref;
}

export function loadReference(outDir: string, runs: RunRecord[]): Reference {
  const reviewed = join(outDir, "reference.json");
  if (existsSync(reviewed)) {
    const r = JSON.parse(readFileSync(reviewed, "utf8")) as Reference;
    return { ...r, status: "reviewed" };
  }
  const draft = buildDraftReference(runs);
  writeFileSync(join(outDir, "reference.draft.json"), JSON.stringify(draft, null, 1));
  return draft;
}

export interface Score {
  wer: number;
  cer: number;
  edits: number;
  refWords: number;
  /** Same, after collapsing runaway repetition in the hypothesis. */
  werNoLoops: number;
  editsNoLoops: number;
  loops: number;
}

export function score(ref: string, hyp: string): Score {
  const w = wer(ref, hyp);
  const c = cer(ref, hyp);
  const collapsed = collapseLoops(hyp);
  const w2 = wer(ref, collapsed.text);
  return {
    wer: w.rate,
    cer: c.rate,
    edits: w.edits,
    refWords: w.refLength,
    werNoLoops: w2.rate,
    editsNoLoops: w2.edits,
    loops: collapsed.loops,
  };
}

/** Pooled over clips: total edits over total reference words, not a mean of rates. */
export function pooled(scores: Score[]): { wer: number; werNoLoops: number; cer: number; loops: number } {
  const words = scores.reduce((a, s) => a + s.refWords, 0);
  const edits = scores.reduce((a, s) => a + s.edits, 0);
  const edits2 = scores.reduce((a, s) => a + s.editsNoLoops, 0);
  const cerNum = scores.reduce((a, s) => a + s.cer * s.refWords, 0);
  return {
    wer: words ? edits / words : 0,
    werNoLoops: words ? edits2 / words : 0,
    cer: words ? cerNum / words : 0,
    loops: scores.reduce((a, s) => a + s.loops, 0),
  };
}

export interface Disagreement {
  clip: string;
  start: number;
  end: number;
  reference: string;
  display?: string;
  variants: Array<{ provider: string; text: string }>;
  providersDiffering: number;
  editsTotal: number;
}

/**
 * Cut every provider's output (whole-file, forced pt, loops collapsed) into the
 * reference's segments by token alignment, and rank segments by how much the
 * providers disagree with the reference there.
 */
export function disagreements(ref: Reference, runs: RunRecord[]): Disagreement[] {
  const out: Disagreement[] = [];
  for (const clip of REFERENCE_CLIPS) {
    const c = ref.clips[clip];
    if (!c) continue;
    const segTokens = c.segments.map((s) => toks(s.text));
    const flat = segTokens.flat();
    const bounds: Array<[number, number]> = [];
    let at = 0;
    for (const t of segTokens) {
      bounds.push([at, at + t.length]);
      at += t.length;
    }
    const perProvider = consensusHypotheses(runs, clip).map((h) => ({
      provider: h.id,
      aligned: alignTokens(flat, toks(h.text)),
    }));
    c.segments.forEach((seg, si) => {
      const [a, b] = bounds[si] as [number, number];
      if (b - a === 0) return;
      const variants = perProvider.map((p) => ({ provider: p.provider, text: p.aligned.slice(a, b).flat().join(" ") }));
      const refNorm = (segTokens[si] as string[]).join(" ");
      const differing = variants.filter((v) => v.text !== refNorm);
      // Each provider's edits are capped at the line's length so one runaway hallucination
      // (a repeated credit, a looped phrase) cannot push an easy line to the top; lines where
      // many providers disagree in many different ways are the ones worth a native speaker's ear.
      const refLen = Math.max(1, (segTokens[si] as string[]).length);
      const distinct = new Set(variants.map((v) => v.text)).size;
      const editsTotal = distinct * 100 + variants.reduce((acc, v) => acc + Math.min(refLen, wer(refNorm, v.text).edits), 0);
      out.push({
        clip,
        start: seg.start,
        end: seg.end,
        reference: seg.text,
        display: seg.display,
        variants,
        providersDiffering: differing.length,
        editsTotal,
      });
    });
  }
  return out.sort((x, y) => y.editsTotal - x.editsTotal);
}
