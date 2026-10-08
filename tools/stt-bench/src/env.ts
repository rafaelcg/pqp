import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ENV_FILE = join(homedir(), ".config", "pqp", "stt-bench.env");

export interface BenchKeys {
  GROQ?: string;
  OPENROUTER?: string;
  /** xAI key, only read when the bench is started with --xai. */
  GROK?: string;
}

/**
 * Reads GROQ and OPENROUTER from ~/.config/pqp/stt-bench.env (or process.env).
 * Values are returned to the caller and never logged; `describeKeys` is the only
 * thing that is ever printed, and it says "set" or "unset".
 */
export function loadKeys(file = ENV_FILE): BenchKeys {
  const out: BenchKeys = {};
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?(GROQ|OPENROUTER|GROK)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1] as keyof BenchKeys] = (m[2] as string).replace(/^["']|["']$/g, "");
    }
  } catch {
    // no file: fall through to the environment
  }
  for (const k of ["GROQ", "OPENROUTER", "GROK"] as const) {
    if (!out[k] && process.env[k]) out[k] = process.env[k];
  }
  return out;
}

export function describeKeys(k: BenchKeys): string {
  return `GROQ ${k.GROQ ? "set" : "unset"}, OPENROUTER ${k.OPENROUTER ? "set" : "unset"}, GROK ${k.GROK ? "set" : "unset"}`;
}
