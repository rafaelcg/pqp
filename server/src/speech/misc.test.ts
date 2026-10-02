import { describe, expect, it } from "vitest";
import { energyGate } from "./gate.js";
import { parseRetryAfterMs } from "./http.js";
import { sniffFormat } from "./audio.js";
import {
  buildChatBody,
  buildSystemPrompt,
  createOpenRouterChatTranslator,
  parseStringArray,
} from "./translators/openrouter-chat.js";

function tone(seconds: number, amp: number, rate = 16000): Int16Array {
  const out = new Int16Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / rate));
  return out;
}

describe("energyGate", () => {
  it("rejects digital silence and very quiet noise", () => {
    expect(energyGate(new Int16Array(16000 * 8), 16000).speech).toBe(false);
    expect(energyGate(tone(8, 20), 16000).speech).toBe(false); // about -64 dBFS
  });

  it("accepts a window with real speech-level energy", () => {
    const r = energyGate(tone(8, 6000), 16000);
    expect(r.speech).toBe(true);
    expect(r.speechMs).toBeGreaterThan(7000);
  });

  it("needs a minimum amount of speech, not one click", () => {
    const pcm = new Int16Array(16000 * 8);
    pcm.set(tone(0.1, 9000), 16000); // 100 ms burst
    expect(energyGate(pcm, 16000).speech).toBe(false);
    pcm.set(tone(0.6, 9000), 16000);
    expect(energyGate(pcm, 16000).speech).toBe(true);
  });

  it("reads s16le from a Buffer", () => {
    const t = tone(1, 6000);
    const buf = Buffer.from(t.buffer, t.byteOffset, t.byteLength);
    expect(energyGate(buf, 16000).speech).toBe(true);
  });
});

describe("parseRetryAfterMs", () => {
  it("reads seconds, Groq-style durations and dates", () => {
    expect(parseRetryAfterMs("3")).toBe(3000);
    expect(parseRetryAfterMs("2.5")).toBe(2500);
    expect(parseRetryAfterMs("1m30.5s")).toBe(90_500);
    expect(parseRetryAfterMs("250ms")).toBe(250);
    expect(parseRetryAfterMs(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs("soon")).toBeUndefined();
  });
});

describe("sniffFormat", () => {
  it("recognises the containers the providers accept", () => {
    expect(sniffFormat(Buffer.from("fLaC0000"))).toBe("flac");
    expect(sniffFormat(Buffer.from("OggS0000"))).toBe("ogg");
    expect(sniffFormat(Buffer.from("....ftypM4A "))).toBe("m4a");
    expect(sniffFormat(Buffer.from("RIFF....WAVE"))).toBe("wav");
    expect(sniffFormat(Buffer.from("zzzz"))).toBeUndefined();
  });
});

describe("openrouter chat translator", () => {
  it("states the no-commentary and keep-names rules in the system prompt", () => {
    const p = buildSystemPrompt("pt", "en", ["pqp", "Baú"]);
    expect(p).toContain("Brazilian Portuguese into English");
    expect(p).toMatch(/Never add commentary/);
    expect(p).toContain("pqp, Baú");
  });

  it("sends the texts as a JSON array in the user turn at temperature 0", () => {
    const b = buildChatBody("anthropic/claude-haiku-4.5", ["oi", "tchau"], "pt", "es", ["pqp"]);
    expect(b.temperature).toBe(0);
    expect(b.messages[1]).toEqual({ role: "user", content: '["oi","tchau"]' });
  });

  it("parses plain, fenced and chatty replies, and rejects non-arrays", () => {
    expect(parseStringArray('["a","b"]')).toEqual(["a", "b"]);
    expect(parseStringArray('```json\n["a","b"]\n```')).toEqual(["a", "b"]);
    expect(parseStringArray('Here you go: ["a"] hope it helps')).toEqual(["a"]);
    expect(parseStringArray('{"a":1}')).toBeUndefined();
    expect(parseStringArray("[1,2]")).toBeUndefined();
  });

  it("returns translations in order and sums the reported cost", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '["hi","bye"]' } }], usage: { cost: 0.0002 } }), { status: 200 });
    const t = createOpenRouterChatTranslator({ apiKey: "k", model: "m", fetchImpl });
    expect(await t.translate(["oi", "tchau"], "pt", "en")).toEqual({ texts: ["hi", "bye"], costUsd: 0.0002 });
  });

  it("retries once on a length mismatch, then falls back to one request per string", async () => {
    const replies = ['["only one"]', '["still one"]', '["a"]', '["b"]'];
    let i = 0;
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: replies[i++] } }], usage: { cost: 0.001 } }), { status: 200 });
    const t = createOpenRouterChatTranslator({ apiKey: "k", model: "m", fetchImpl });
    const r = await t.translate(["x", "y"], "pt", "en");
    expect(r.texts).toEqual(["a", "b"]);
    expect(r.costUsd).toBeCloseTo(0.004, 6);
    expect(i).toBe(4);
  });

  it("returns immediately for an empty batch", async () => {
    const t = createOpenRouterChatTranslator({ apiKey: "k", model: "m", fetchImpl: async () => { throw new Error("no"); } });
    expect(await t.translate([], "pt", "en")).toEqual({ texts: [], costUsd: 0 });
  });
});
