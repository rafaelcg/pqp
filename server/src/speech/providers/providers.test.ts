import { describe, expect, it } from "vitest";
import { SpeechHttpError } from "../types.js";
import { createGroqProvider, groqCostUsd } from "./groq.js";
import { createXaiProvider, toKeyterms } from "./xai.js";
import {
  buildOpenRouterSttBody,
  createOpenRouterSttProvider,
  normalizeLanguage,
  parseOpenRouterStt,
} from "./openrouter.js";
import { buildWhisperCppArgs, createWhisperCppProvider, parseWhisperCppJson } from "./whisper-cpp.js";
import { createReplayProvider } from "./replay.js";
import { writeFile } from "node:fs/promises";

// Hand-written fixtures in the shape each provider documents. No network, no keys.
const WAV = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVE"),
  Buffer.alloc(32),
  Buffer.alloc(32000), // one second of 16 kHz mono s16
]);
WAV.writeUInt32LE(32000, 28);

const GROQ_VERBOSE = {
  text: " Olha, isso fica duplicado. Eles ajeitaram.",
  language: "pt",
  duration: 6.2,
  segments: [
    { start: 0, end: 2.1, text: " Olha, isso fica duplicado.", avg_logprob: -0.3, no_speech_prob: 0.01 },
    { start: 4.1, end: 6.0, text: " Eles ajeitaram.", avg_logprob: -0.2, no_speech_prob: 0.02 },
  ],
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

describe("groq provider", () => {
  it("builds a multipart request with model, verbose_json, language and prompt, and never leaks the key into the body", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init as RequestInit };
      return jsonResponse(GROQ_VERBOSE);
    };
    const p = createGroqProvider({ apiKey: "KEY_FOR_TEST", model: "whisper-large-v3-turbo", fetchImpl });
    const r = await p.transcribe(WAV, { language: "pt", prompt: "pqp, Baú" });
    expect(captured?.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect((captured?.init.headers as Record<string, string>).Authorization).toBe("Bearer KEY_FOR_TEST");
    const form = captured?.init.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("language")).toBe("pt");
    expect(form.get("prompt")).toBe("pqp, Baú");
    expect((form.get("file") as File).name).toBe("audio.wav");
    expect(r.text).toBe("Olha, isso fica duplicado. Eles ajeitaram.");
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0]).toMatchObject({ start: 0, end: 2.1, text: "Olha, isso fica duplicado.", noSpeechProb: 0.01 });
    expect(r.language).toBe("pt");
    expect(r.durationMs).toBe(6200);
  });

  it("omits language and prompt when not given (auto-detect)", async () => {
    let form: FormData | undefined;
    const fetchImpl: typeof fetch = async (_u, init) => {
      form = (init as RequestInit).body as FormData;
      return jsonResponse(GROQ_VERBOSE);
    };
    await createGroqProvider({ apiKey: "k", model: "whisper-large-v3", fetchImpl }).transcribe(WAV, {});
    expect(form?.has("language")).toBe(false);
    expect(form?.has("prompt")).toBe(false);
  });

  it("bills a 10 second minimum per request", () => {
    expect(groqCostUsd("whisper-large-v3-turbo", 8)).toBeCloseTo((10 / 3600) * 0.04, 10);
    expect(groqCostUsd("whisper-large-v3", 180)).toBeCloseTo((180 / 3600) * 0.111, 10);
  });

  it("retries a 429 after the Retry-After hint and then succeeds", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const fetchImpl: typeof fetch = async () => {
      n += 1;
      if (n === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "3" } });
      return jsonResponse(GROQ_VERBOSE);
    };
    const retries: Array<{ status: number; delayMs: number }> = [];
    const p = createGroqProvider({
      apiKey: "k",
      model: "whisper-large-v3-turbo",
      fetchImpl,
      retry: { sleep: async (ms) => void sleeps.push(ms), onRetry: (i) => retries.push(i) },
    });
    const r = await p.transcribe(WAV, {});
    expect(r.text).toContain("Olha");
    expect(n).toBe(2);
    expect(sleeps).toEqual([3250]);
    expect(retries).toEqual([{ attempt: 1, status: 429, delayMs: 3250 }]);
  });

  it("gives up after the attempt budget with an error that carries no key", async () => {
    const fetchImpl: typeof fetch = async () => new Response("slow down", { status: 429 });
    const p = createGroqProvider({
      apiKey: "KEY_FOR_TEST",
      model: "whisper-large-v3-turbo",
      fetchImpl,
      retry: { maxAttempts: 3, sleep: async () => {} },
    });
    const err = await p.transcribe(WAV, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpeechHttpError);
    expect((err as SpeechHttpError).status).toBe(429);
    expect(String((err as Error).message)).not.toContain("KEY_FOR_TEST");
  });

  it("does not retry a 400", async () => {
    let n = 0;
    const fetchImpl: typeof fetch = async () => {
      n += 1;
      return new Response("bad", { status: 400 });
    };
    const p = createGroqProvider({ apiKey: "k", model: "whisper-large-v3", fetchImpl, retry: { sleep: async () => {} } });
    await expect(p.transcribe(WAV, {})).rejects.toThrow(/400/);
    expect(n).toBe(1);
  });
});

describe("openrouter stt provider", () => {
  it("sends base64 input_audio JSON with verbose_json for a whisper slug", () => {
    const body = buildOpenRouterSttBody(
      { model: "openai/whisper-large-v3-turbo" },
      { bytes: Buffer.from("abc"), format: "flac" },
      { language: "pt" },
    );
    expect(body).toEqual({
      model: "openai/whisper-large-v3-turbo",
      input_audio: { data: Buffer.from("abc").toString("base64"), format: "flac" },
      temperature: 0,
      language: "pt",
      response_format: "verbose_json",
      timestamp_granularities: ["segment"],
    });
  });

  it("uses plain json for the gpt-4o family, which refuses verbose_json", () => {
    const body = buildOpenRouterSttBody({ model: "openai/gpt-4o-transcribe" }, { bytes: Buffer.from("a"), format: "wav" }, {});
    expect(body.response_format).toBe("json");
    expect(body.timestamp_granularities).toBeUndefined();
  });

  it("routes the prompt under provider.options for the serving vendor", () => {
    const whisper = buildOpenRouterSttBody({ model: "openai/whisper-large-v3" }, { bytes: Buffer.from("a"), format: "wav" }, { prompt: "pqp" });
    expect(whisper.provider).toEqual({ options: { groq: { prompt: "pqp" } } });
    const gpt = buildOpenRouterSttBody({ model: "openai/gpt-4o-transcribe" }, { bytes: Buffer.from("a"), format: "wav" }, { prompt: "pqp" });
    expect(gpt.provider).toEqual({ options: { openai: { prompt: "pqp" } } });
  });

  it("parses segments, language name and the reported cost", () => {
    const r = parseOpenRouterStt(
      {
        text: " Olá. Tudo bem?",
        language: "Portuguese",
        duration: 12,
        segments: [{ start: 0, end: 1, text: " Olá." }, { start: 2, end: 3, text: " Tudo bem?" }],
        usage: { seconds: 12, cost: 0.000133 },
      },
      0,
    );
    expect(r.text).toBe("Olá. Tudo bem?");
    expect(r.language).toBe("pt");
    expect(r.durationMs).toBe(12000);
    expect(r.costUsd).toBe(0.000133);
    expect(r.segments.map((s) => s.text)).toEqual(["Olá.", "Tudo bem?"]);
  });

  it("turns a text-only json reply into one segment spanning the clip", () => {
    const r = parseOpenRouterStt({ text: "Acho que não fica não.", usage: { cost: 0.0004 } }, 12000);
    expect(r.segments).toEqual([{ start: 0, end: 12, text: "Acho que não fica não." }]);
    expect(r.durationMs).toBe(12000);
  });

  it("returns no segment for an empty transcript", () => {
    expect(parseOpenRouterStt({ text: "" }, 5000).segments).toEqual([]);
  });

  it("asks Grok for word timestamps and sends the glossary as key terms under xai", () => {
    const body = buildOpenRouterSttBody(
      { model: "x-ai/grok-stt-1.0" },
      { bytes: Buffer.from("a"), format: "flac" },
      { language: "pt", prompt: "pqp, Baú; MoonKase\nQG" },
    );
    expect(body.timestamp_granularities).toEqual(["word"]);
    expect(body.provider).toEqual({ options: { xai: { keyterms: ["pqp", "Baú", "MoonKase", "QG"] } } });
  });

  it("regroups Grok word timestamps into sentences, breaking at punctuation and long pauses", () => {
    const r = parseOpenRouterStt(
      {
        text: "O Rafa fez a boa. Amou eles ajeitaram",
        language: "pt-br",
        duration: 12,
        segments: [{ start: 0, end: 12, text: "O Rafa fez a boa. Amou eles ajeitaram" }],
        words: [
          { word: "O", start: 0.2, end: 0.3 },
          { word: "Rafa", start: 0.3, end: 0.6 },
          { word: "fez", start: 0.6, end: 0.8 },
          { word: "a", start: 0.8, end: 0.9 },
          { word: "boa.", start: 0.9, end: 1.5 },
          { word: "Amou", start: 6.0, end: 6.3 },
          { word: "eles", start: 6.3, end: 6.5 },
          { word: "ajeitaram", start: 8.0, end: 8.6 },
        ],
        usage: { seconds: 12, cost: 0.00033 },
      },
      0,
    );
    expect(r.language).toBe("pt");
    expect(r.segments).toEqual([
      { start: 0.2, end: 1.5, text: "O Rafa fez a boa." },
      { start: 6.0, end: 6.5, text: "Amou eles" },
      { start: 8.0, end: 8.6, text: "ajeitaram" },
    ]);
  });

  it("normalizes language names and codes", () => {
    expect(normalizeLanguage("pt-BR")).toBe("pt");
    expect(normalizeLanguage("Portuguese")).toBe("pt");
    expect(normalizeLanguage("en")).toBe("en");
    expect(normalizeLanguage("")).toBeUndefined();
  });

  it("posts JSON with a bearer header and reads the usage cost end to end", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init as RequestInit };
      return jsonResponse({ text: "oi", duration: 1, segments: [{ start: 0, end: 1, text: "oi" }], usage: { cost: 0.01 } });
    };
    const p = createOpenRouterSttProvider({ apiKey: "KEY_FOR_TEST", model: "openai/whisper-1", fetchImpl });
    const r = await p.transcribe(WAV, { language: "pt" });
    expect(captured?.url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect((captured?.init.headers as Record<string, string>).Authorization).toBe("Bearer KEY_FOR_TEST");
    expect(JSON.parse(String(captured?.init.body)).input_audio.format).toBe("wav");
    expect(r.costUsd).toBe(0.01);
  });
});

describe("xai provider", () => {
  const XAI_BODY = {
    text: "O Rafa fez a boa. Amou?",
    language: "pt-br",
    duration: 6.2,
    words: [
      { text: "O", start: 0.18, end: 0.2 },
      { text: "Rafa", start: 0.2, end: 0.48 },
      { text: "fez", start: 0.48, end: 0.66 },
      { text: "a", start: 1.38, end: 1.4 },
      { text: "boa.", start: 1.46, end: 1.54 },
      { text: "Amou?", start: 6.0, end: 6.2 },
    ],
  };

  it("posts multipart with language, one keyterm field per glossary entry and the file last", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init as RequestInit };
      return jsonResponse(XAI_BODY);
    };
    const p = createXaiProvider({ apiKey: "KEY_FOR_TEST", fetchImpl });
    const r = await p.transcribe(WAV, { language: "pt", prompt: "pqp, Baú; MoonKase" });
    expect(captured?.url).toBe("https://api.x.ai/v1/stt");
    expect((captured?.init.headers as Record<string, string>).Authorization).toBe("Bearer KEY_FOR_TEST");
    const form = captured?.init.body as FormData;
    const names = [...form.keys()];
    expect(names.at(-1)).toBe("file");
    expect(form.get("model")).toBe("grok-voice-transcribe-2.0");
    expect(form.get("language")).toBe("pt");
    expect(form.getAll("keyterm")).toEqual(["pqp", "Baú", "MoonKase"]);
    expect(p.id).toBe("xai/grok-voice-transcribe-2.0");
    expect(r.language).toBe("pt");
    expect(r.durationMs).toBe(6200);
    expect(r.segments.map((s) => s.text)).toEqual(["O Rafa fez a boa.", "Amou?"]);
    expect(r.costUsd).toBeCloseTo((6.2 / 3600) * 0.1, 8);
  });

  it("caps key terms at 100 of 50 characters", () => {
    const many = Array.from({ length: 150 }, (_, i) => `termo${i}`).join(",");
    expect(toKeyterms(many)).toHaveLength(100);
    expect(toKeyterms("x".repeat(80))[0]).toHaveLength(50);
    expect(toKeyterms(undefined)).toEqual([]);
  });
});

describe("whisper.cpp provider", () => {
  it("builds argv with language, prompt and JSON output", () => {
    const args = buildWhisperCppArgs({ modelPath: "/m/ggml-small.bin", threads: 6 }, "/t/in.wav", "/t/out", {
      language: "pt",
      prompt: "pqp, QG",
    });
    expect(args).toEqual([
      "-m", "/m/ggml-small.bin", "-f", "/t/in.wav", "-l", "pt", "-t", "6", "-oj", "-of", "/t/out", "-np", "--prompt", "pqp, QG",
    ]);
    expect(buildWhisperCppArgs({ modelPath: "m" }, "i", "o", {})).toContain("auto");
  });

  it("parses the offsets JSON into seconds and drops empty segments", () => {
    const r = parseWhisperCppJson({
      result: { language: "pt" },
      transcription: [
        { offsets: { from: 0, to: 2500 }, text: " Fala galera" },
        { offsets: { from: 2500, to: 3000 }, text: "   " },
        { offsets: { from: 3000, to: 5200 }, text: " tudo bem" },
      ],
    });
    expect(r.segments).toEqual([
      { start: 0, end: 2.5, text: "Fala galera" },
      { start: 3, end: 5.2, text: "tudo bem" },
    ]);
    expect(r.text).toBe("Fala galera tudo bem");
    expect(r.language).toBe("pt");
    expect(r.lastEndMs).toBe(5200);
  });

  it("runs the binary through the seam and reads the JSON it wrote", async () => {
    let seen: string[] = [];
    const p = createWhisperCppProvider({
      modelPath: "/m/x.bin",
      modelName: "x",
      run: async (_bin, args) => {
        seen = args;
        const base = args[args.indexOf("-of") + 1] as string;
        await writeFile(`${base}.json`, JSON.stringify({ result: { language: "en" }, transcription: [{ offsets: { from: 0, to: 1000 }, text: " hello" }] }));
      },
    });
    const r = await p.transcribe(WAV, {});
    expect(seen).toContain("-oj");
    expect(r).toMatchObject({ text: "hello", language: "en", durationMs: 1000, costUsd: 0 });
    expect(p.id).toBe("whisper-cpp/x");
  });
});

describe("replay provider", () => {
  const cues = [
    { start: 1, end: 3, text: "primeiro" },
    { start: 9, end: 11, text: "segundo" },
  ];

  it("returns every cue when no window is given", async () => {
    const r = await createReplayProvider({ cues }).transcribe(Buffer.alloc(0), {});
    expect(r.text).toBe("primeiro segundo");
    expect(r.durationMs).toBe(11000);
  });

  it("clips cues to a window and rebases them to the window's clock", async () => {
    const p = createReplayProvider({ cues, windowStartMs: () => 8000, windowMs: 8000 });
    const r = await p.transcribe("x", {});
    expect(r.segments).toEqual([{ start: 1, end: 3, text: "segundo" }]);
    expect(r.durationMs).toBe(8000);
  });

  it("honours an aborted signal", async () => {
    const c = new AbortController();
    c.abort();
    await expect(createReplayProvider({ cues }).transcribe("x", { signal: c.signal })).rejects.toBeDefined();
  });
});
