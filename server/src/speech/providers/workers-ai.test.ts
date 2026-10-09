import { describe, expect, it } from "vitest";
import { SpeechHttpError } from "../types.js";
import { buildWorkersAiBody, createWorkersAiProvider, parseWorkersAiResponse, workersAiCostUsd } from "./workers-ai.js";

// Hand-written fixtures in the shape developers.cloudflare.com documents. No network, no tokens.
const WAV = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVE"),
  Buffer.alloc(32),
  Buffer.alloc(32000),
]);
WAV.writeUInt32LE(32000, 28);

const OK = {
  result: {
    transcription_info: { language: "pt", language_probability: 0.98, duration: 6.2, duration_after_vad: 4.1 },
    text: " Olha, isso fica duplicado. Eles ajeitaram.",
    word_count: 6,
    segments: [
      { start: 0, end: 2.1, text: " Olha, isso fica duplicado.", temperature: 0, avg_logprob: -0.3, compression_ratio: 1.1, no_speech_prob: 0.01 },
      { start: 4.1, end: 6.0, text: " Eles ajeitaram.", temperature: 0, avg_logprob: -0.2, compression_ratio: 1.0, no_speech_prob: 0.02 },
    ],
    vtt: "WEBVTT",
  },
  success: true,
  errors: [],
  messages: [],
};

const SILENCE = {
  result: { transcription_info: { language: "en", duration: 3 }, text: "", word_count: 0, segments: [], vtt: "WEBVTT" },
  success: true,
  errors: [],
  messages: [],
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

const noSleep = async () => {};

describe("workers-ai provider", () => {
  it("posts JSON with a bearer header, base64 audio, language and prompt to the account's run URL", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init as RequestInit };
      return jsonResponse(OK);
    };
    const p = createWorkersAiProvider({ accountId: "ACCT", apiToken: "TOKEN_FOR_TEST", vadFilter: true, fetchImpl });
    const r = await p.transcribe(WAV, { language: "pt", prompt: "pqp, Baú" });
    expect(p.id).toBe("workers-ai/@cf/openai/whisper-large-v3-turbo");
    expect(captured?.url).toBe("https://api.cloudflare.com/client/v4/accounts/ACCT/ai/run/@cf/openai/whisper-large-v3-turbo");
    expect(captured?.init.method).toBe("POST");
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer TOKEN_FOR_TEST");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(captured?.init.body as string);
    expect(body).toEqual({
      audio: WAV.toString("base64"),
      task: "transcribe",
      language: "pt",
      initial_prompt: "pqp, Baú",
      vad_filter: true,
    });
    expect(captured?.init.body).not.toContain("TOKEN_FOR_TEST");
    expect(r.text).toBe("Olha, isso fica duplicado. Eles ajeitaram.");
    expect(r.language).toBe("pt");
    expect(r.durationMs).toBe(6200);
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0]).toEqual({ start: 0, end: 2.1, text: "Olha, isso fica duplicado.", noSpeechProb: 0.01, avgLogprob: -0.3 });
    expect(r.costUsd).toBeCloseTo(workersAiCostUsd(6.2), 10);
  });

  it("omits language, prompt and vad_filter when not given (auto-detect)", () => {
    const body = buildWorkersAiBody({}, { bytes: WAV }, {});
    expect(Object.keys(body).sort()).toEqual(["audio", "task"]);
  });

  it("reads an unwrapped body the same as the REST envelope", () => {
    expect(parseWorkersAiResponse(OK.result)).toEqual(parseWorkersAiResponse(OK));
  });

  it("returns empty text and no segments for a no-speech reply", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(SILENCE);
    const r = await createWorkersAiProvider({ accountId: "a", apiToken: "t", fetchImpl }).transcribe(WAV, {});
    expect(r.text).toBe("");
    expect(r.segments).toEqual([]);
    expect(r.durationMs).toBe(3000);
  });

  it("carries a high no_speech_prob through on a kept segment and drops blank ones", () => {
    const r = parseWorkersAiResponse({
      result: {
        text: "Obrigado.",
        segments: [
          { start: 0, end: 1, text: " ", no_speech_prob: 0.99 },
          { start: 1, end: 2, text: " Obrigado.", no_speech_prob: 0.8, avg_logprob: -1.4 },
        ],
      },
    });
    expect(r.segments).toEqual([{ start: 1, end: 2, text: "Obrigado.", noSpeechProb: 0.8, avgLogprob: -1.4 }]);
    expect(r.durationMs).toBe(2000);
  });

  it("does not retry a 4xx and the error carries no token", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 });
    };
    const p = createWorkersAiProvider({ accountId: "a", apiToken: "SECRET_TOKEN", fetchImpl, retry: { sleep: noSleep } });
    const err = await p.transcribe(WAV, {}).catch((e) => e);
    expect(err).toBeInstanceOf(SpeechHttpError);
    expect(err.status).toBe(403);
    expect(err.message).not.toContain("SECRET_TOKEN");
    expect(calls).toBe(1);
  });

  it("retries a 5xx and then succeeds", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      return calls === 1 ? new Response("upstream down", { status: 503 }) : jsonResponse(OK);
    };
    const r = await createWorkersAiProvider({ accountId: "a", apiToken: "t", fetchImpl, retry: { sleep: noSleep } }).transcribe(WAV, {});
    expect(calls).toBe(2);
    expect(r.segments).toHaveLength(2);
  });

  it("gives up on a persistent 5xx with the status", async () => {
    const fetchImpl: typeof fetch = async () => new Response("boom", { status: 500 });
    const p = createWorkersAiProvider({ accountId: "a", apiToken: "t", fetchImpl, retry: { maxAttempts: 2, sleep: noSleep } });
    await expect(p.transcribe(WAV, {})).rejects.toMatchObject({ provider: "workers-ai", status: 500 });
  });

  it("surfaces a 200 with success:false as an error", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ success: false, errors: [{ code: 5006, message: "Invalid audio" }], result: null });
    const p = createWorkersAiProvider({ accountId: "a", apiToken: "t", fetchImpl });
    await expect(p.transcribe(WAV, {})).rejects.toThrow(/Invalid audio/);
  });

  it("rejects a 200 with no transcription in it rather than reporting silence", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ success: true, errors: [], result: {} });
    const p = createWorkersAiProvider({ accountId: "a", apiToken: "t", fetchImpl });
    await expect(p.transcribe(WAV, {})).rejects.toThrow(/no transcription/);
  });

  it("does not call out when the caller cancelled during the file read", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      return jsonResponse(OK);
    };
    const ctl = new AbortController();
    const p = createWorkersAiProvider({ accountId: "a", apiToken: "t", fetchImpl });
    const pending = p.transcribe(WAV, { signal: ctl.signal }).catch((e) => e);
    ctl.abort(new Error("caller gave up"));
    expect((await pending).message).toBe("caller gave up");
    expect(calls).toBe(0);
  });

  it("aborts when the timeout passes", async () => {
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal as AbortSignal;
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const p = createWorkersAiProvider({ accountId: "a", apiToken: "t", fetchImpl, timeoutMs: 20 });
    const err = await p.transcribe(WAV, {}).catch((e) => e);
    expect(err.name).toBe("TimeoutError");
  });

  it("honours the caller's signal as well as its own timeout", async () => {
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal as AbortSignal;
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const ctl = new AbortController();
    const p = createWorkersAiProvider({ accountId: "a", apiToken: "t", fetchImpl, timeoutMs: 60_000 });
    const pending = p.transcribe(WAV, { signal: ctl.signal }).catch((e) => e);
    ctl.abort(new Error("caller gave up"));
    expect((await pending).message).toBe("caller gave up");
  });
});
