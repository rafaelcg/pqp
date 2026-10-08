import { describe, expect, it } from "vitest";
import { ChunkedTranscribeError, planWindows, stitchWindows, transcribeChunked } from "./chunker.js";
import { alignTokens, medoid, MAX_ALIGN_CELLS } from "./metrics.js";
import { createOpenRouterSttProvider, parseOpenRouterStt } from "./providers/openrouter.js";
import { createReplayProvider } from "./providers/replay.js";
import { createOpenRouterChatTranslator, FALLBACK_CONCURRENCY, TranslateError } from "./translators/openrouter-chat.js";
import type { SttProvider } from "./types.js";

const chat = (content: string, cost?: number) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], ...(cost === undefined ? {} : { usage: { cost } }) }), {
    status: 200,
  });

describe("stitchWindows only de-duplicates across windows", () => {
  it("keeps a repeated word between two close segments of the same window", () => {
    const w = { index: 0, startMs: 0, endMs: 8000 };
    const out = stitchWindows([
      {
        window: w,
        segments: [
          { start: 1, end: 1.4, text: "eu" },
          { start: 1.5, end: 2.5, text: "eu acho que sim" },
        ],
      },
    ]);
    expect(out.map((s) => s.text)).toEqual(["eu", "eu acho que sim"]);
  });

  it("still trims the repeat when the two segments come from different windows", () => {
    const w0 = { index: 0, startMs: 0, endMs: 8000 };
    const w1 = { index: 1, startMs: 7000, endMs: 15000 };
    const out = stitchWindows([
      { window: w0, segments: [{ start: 6.0, end: 7.6, text: "então eu acho" }] },
      { window: w1, segments: [{ start: 0.2, end: 1.0, text: "eu acho que sim" }] },
    ]);
    expect(out.map((s) => s.text).join(" ")).toBe("então eu acho que sim");
  });
});

describe("transcribeChunked failure and cost", () => {
  const windows = planWindows(30_000);
  const fakeAudio = (w: { startMs: number }) => String(w.startMs);

  it("surfaces completed windows and their cost when a later window fails", async () => {
    let n = 0;
    const provider: SttProvider = {
      id: "flaky",
      async transcribe() {
        n += 1;
        if (n === 3) throw new Error("boom");
        return { text: `parte ${n}`, segments: [{ start: 1, end: 2, text: `parte ${n}` }], durationMs: 8000, costUsd: 0.01 };
      },
    };
    const err = (await transcribeChunked({ provider, windows, readWindow: async (w) => fakeAudio(w) }).catch((e: unknown) => e)) as ChunkedTranscribeError;
    expect(err).toBeInstanceOf(ChunkedTranscribeError);
    expect(err.failedWindow.index).toBe(2);
    expect(err.partial.requests).toBe(2);
    expect(err.partial.knownCostUsd).toBeCloseTo(0.02, 10);
    expect(err.partial.costUsd).toBeCloseTo(0.02, 10);
    expect(err.partial.text).toContain("parte 1");
    expect(err.message).toContain("boom");
  });

  it("surfaces a read or gate failure the same way", async () => {
    const provider = createReplayProvider({ cues: [] });
    const err = (await transcribeChunked({
      provider,
      windows,
      readWindow: async (w) => fakeAudio(w),
      gate: (w) => {
        if (w.index === 1) throw new Error("gate broke");
        return true;
      },
    }).catch((e: unknown) => e)) as ChunkedTranscribeError;
    expect(err).toBeInstanceOf(ChunkedTranscribeError);
    expect(err.partial.requests).toBe(1);
  });

  it("reports an unknown cost as undefined, not zero, and says how many requests were unpriced", async () => {
    let n = 0;
    const provider: SttProvider = {
      id: "unpriced",
      async transcribe() {
        n += 1;
        return { text: "oi", segments: [{ start: 0, end: 1, text: "oi" }], durationMs: 8000, costUsd: n === 2 ? undefined : 0.01 };
      },
    };
    const res = await transcribeChunked({ provider, windows: planWindows(20_000), readWindow: async (w) => fakeAudio(w) });
    expect(res.requests).toBe(3);
    expect(res.costUsd).toBeUndefined();
    expect(res.unknownCostRequests).toBe(1);
    expect(res.knownCostUsd).toBeCloseTo(0.02, 10);
  });

  it("a gate-skipped window is free, not unknown", async () => {
    const res = await transcribeChunked({
      provider: createReplayProvider({ cues: [] }),
      windows: planWindows(8000),
      readWindow: async (w) => fakeAudio(w),
      gate: () => false,
    });
    expect(res.costUsd).toBe(0);
    expect(res.unknownCostRequests).toBe(0);
  });

  it("hands the window length to the provider and spans a text-only answer across it", async () => {
    const seen: Array<number | undefined> = [];
    const provider: SttProvider = {
      id: "text-only",
      async transcribe(_a, opts) {
        seen.push(opts.durationMs);
        return { text: "olá pessoal", segments: [], durationMs: 0 };
      },
    };
    const res = await transcribeChunked({ provider, windows: planWindows(8000), readWindow: async () => "x" });
    expect(seen).toEqual([8000]);
    expect(res.segments).toEqual([{ start: 0, end: 8, text: "olá pessoal" }]);
  });
});

describe("transcribeChunked duration hint", () => {
  it("is the window's own length even when sttOpts carries a different durationMs", async () => {
    const seen: Array<number | undefined> = [];
    const provider: SttProvider = {
      id: "p",
      async transcribe(_a, opts) {
        seen.push(opts.durationMs);
        return { text: "", segments: [], durationMs: 0 };
      },
    };
    await transcribeChunked({ provider, windows: planWindows(8000), readWindow: async () => "x", sttOpts: { durationMs: 999_999 } });
    expect(seen).toEqual([8000]);
  });
});

describe("openrouter stt without a known duration", () => {
  it("returns the text with no segment instead of a zero-length one", () => {
    const r = parseOpenRouterStt({ text: "Acho que não fica não." }, 0);
    expect(r.text).toBe("Acho que não fica não.");
    expect(r.segments).toEqual([]);
  });

  it("uses the caller's duration hint for a non-WAV input", async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ text: "oi" }), { status: 200 });
    const p = createOpenRouterSttProvider({ apiKey: "k", model: "openai/gpt-4o-transcribe", fetchImpl });
    const flac = Buffer.concat([Buffer.from("fLaC"), Buffer.alloc(16)]);
    const r = await p.transcribe(flac, { durationMs: 5000 });
    expect(r.segments).toEqual([{ start: 0, end: 5, text: "oi" }]);
    const none = await p.transcribe(flac, {});
    expect(none.segments).toEqual([]);
  });
});

describe("translator keeps the cost of calls that succeeded", () => {
  it("attaches the earlier cost to the error when a retry then fails", async () => {
    let n = 0;
    const fetchImpl: typeof fetch = async () => {
      n += 1;
      if (n === 1) return chat('["one"]', 0.003); // wrong length, billed
      return new Response("nope", { status: 400 }); // the retry fails
    };
    const t = createOpenRouterChatTranslator({ apiKey: "k", model: "m", fetchImpl, retry: { sleep: async () => {} } });
    const err = (await t.translate(["x", "y"], "pt", "en").catch((e: unknown) => e)) as TranslateError;
    expect(err).toBeInstanceOf(TranslateError);
    expect(err.costUsd).toBeCloseTo(0.003, 10);
    expect(err.message).toContain("400");
  });

  it("does not wrap an error when nothing was billed yet", async () => {
    const fetchImpl: typeof fetch = async () => new Response("nope", { status: 400 });
    const t = createOpenRouterChatTranslator({ apiKey: "k", model: "m", fetchImpl });
    const err = await t.translate(["x"], "pt", "en").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TranslateError);
    expect((err as Error).message).toContain("400");
  });

  it("keeps the cost of the per-string calls that completed when a sibling fails", async () => {
    let call = 0;
    const fetchImpl: typeof fetch = async (_u, init) => {
      call += 1;
      const user = JSON.parse(String((init as RequestInit).body)).messages[1].content as string;
      if (call <= 2) return chat('["only one"]', 0.001); // two batch attempts, both misaligned
      if (user === '["z"]') return new Response("nope", { status: 400 });
      return chat(`["${user.slice(2, -2)}!"]`, 0.002);
    };
    const t = createOpenRouterChatTranslator({ apiKey: "k", model: "m", fetchImpl });
    const err = (await t.translate(["x", "y", "z"], "pt", "en").catch((e: unknown) => e)) as TranslateError;
    expect(err).toBeInstanceOf(TranslateError);
    // 2 batch attempts + x and y succeeded; z failed and billed nothing.
    expect(err.costUsd).toBeCloseTo(0.002 + 0.004, 10);
  });

  it("runs the per-string fallback with bounded concurrency and keeps input order", async () => {
    const texts = Array.from({ length: 12 }, (_, i) => `t${i}`);
    let inFlight = 0;
    let peak = 0;
    let batchCalls = 0;
    const fetchImpl: typeof fetch = async (_u, init) => {
      const user = JSON.parse(String((init as RequestInit).body)).messages[1].content as string;
      const arr = JSON.parse(user) as string[];
      if (arr.length > 1) {
        batchCalls += 1;
        return chat('["wrong length"]', 0.001);
      }
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5 + (arr[0] === "t0" ? 20 : 0))); // t0 finishes last
      inFlight -= 1;
      return chat(JSON.stringify([`${arr[0]}-en`]), 0.001);
    };
    const t = createOpenRouterChatTranslator({ apiKey: "k", model: "m", fetchImpl });
    const r = await t.translate(texts, "pt", "en");
    expect(r.texts).toEqual(texts.map((x) => `${x}-en`));
    expect(batchCalls).toBe(2);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(FALLBACK_CONCURRENCY);
    expect(r.costUsd).toBeCloseTo(0.001 * 14, 8);
  });

  it("reports the total as undefined when a successful call did not say what it cost", async () => {
    const fetchImpl: typeof fetch = async () => chat('["hi"]');
    const t = createOpenRouterChatTranslator({ apiKey: "k", model: "m", fetchImpl });
    expect(await t.translate(["oi"], "pt", "en")).toEqual({ texts: ["hi"], costUsd: undefined });
  });
});

describe("metrics guards", () => {
  it("refuses an alignment table that would exhaust memory", () => {
    const big = new Array<string>(Math.ceil(Math.sqrt(MAX_ALIGN_CELLS)) + 10).fill("a");
    expect(() => alignTokens(big, big)).toThrow(RangeError);
  });

  it("medoid agrees with the pairwise definition and handles one or two hypotheses", () => {
    expect(medoid([{ id: "only", text: "a b c" }])?.id).toBe("only");
    const m = medoid([
      { id: "a", text: "eu gosto de pizza" },
      { id: "b", text: "eu gosto de pizza hoje" },
      { id: "c", text: "tchau pessoal vamos embora agora" },
    ]);
    expect(["a", "b"]).toContain(m?.id);
  });
});
