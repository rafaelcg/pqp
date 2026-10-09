import { afterEach, describe, expect, it, vi } from "vitest";
import { selectSttProvider, setSttProviderForTests, sttProviderName } from "./select.js";

describe("selectSttProvider", () => {
  afterEach(() => setSttProviderForTests(undefined));

  it("is none by default, and none means no provider at all", () => {
    expect(sttProviderName({})).toBe("none");
    expect(selectSttProvider({})).toBeNull();
    expect(selectSttProvider({ VOICE_STT_PROVIDER: "none" })).toBeNull();
  });

  it("a provider without its key is none, said once, never a throw", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setSttProviderForTests(undefined);
    expect(selectSttProvider({ VOICE_STT_PROVIDER: "workers-ai" })).toBeNull();
    expect(selectSttProvider({ VOICE_STT_PROVIDER: "workers-ai", CLOUDFLARE_AI_ACCOUNT_ID: "a" })).toBeNull();
    expect(selectSttProvider({ VOICE_STT_PROVIDER: "groq" })).toBeNull();
    expect(selectSttProvider({ VOICE_STT_PROVIDER: "banana" })).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("names the provider it built, and never makes a request to do so", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const workers = selectSttProvider({
      VOICE_STT_PROVIDER: "workers-ai",
      CLOUDFLARE_AI_ACCOUNT_ID: "acct",
      CLOUDFLARE_AI_API_TOKEN: "token",
    });
    expect(workers?.name).toBe("workers-ai");
    expect(workers?.provider.id).toBe("workers-ai/@cf/openai/whisper-large-v3-turbo");
    const groq = selectSttProvider({ VOICE_STT_PROVIDER: "groq", GROQ_API_KEY: "key" });
    expect(groq?.provider.id).toBe("groq/whisper-large-v3-turbo");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("replay is for tests: refused under NODE_ENV=production", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(selectSttProvider({ VOICE_STT_PROVIDER: "replay", NODE_ENV: "production" })).toBeNull();
    const replay = selectSttProvider({ VOICE_STT_PROVIDER: "replay", VOICE_STT_REPLAY_TEXT: "oi" });
    expect((await replay!.provider.transcribe(Buffer.alloc(1), {})).text).toBe("oi");
    warn.mockRestore();
  });
});
