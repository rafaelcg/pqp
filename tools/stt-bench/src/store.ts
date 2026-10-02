import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SttSegment } from "../../../server/src/speech/types.js";

/** whole | chunked | chunked-gated | chunked-carry | chunked-paced | chunked-w<window s>o<overlap s> */
export type Mode = string;

export interface RunRecord {
  key: string;
  provider: string;
  clip: string;
  mode: Mode;
  config: string;
  text: string;
  segments: SttSegment[];
  language?: string;
  audioMs: number;
  /** One request for whole-file, summed wall time over requests for chunked. */
  latencyMs: number;
  requests: number;
  skipped: number;
  windowLatenciesMs: number[];
  /** Per-window text for chunked modes (what each request returned, or that the gate skipped it). */
  windows?: Array<{ startMs: number; endMs: number; skipped: boolean; text: string; latencyMs: number }>;
  costUsd: number;
  /** "reported" came back in the response, "computed" is from the price table, "free" is local. */
  costKind: "reported" | "computed" | "free";
  retries429: number;
  error?: string;
  at: string;
}

export function runKey(provider: string, clip: string, mode: Mode, config: string): string {
  return [provider, clip, mode, config].join("|");
}

export class Store<T extends { key: string }> {
  private items = new Map<string, T>();

  constructor(private path: string) {
    if (existsSync(path)) {
      for (const r of JSON.parse(readFileSync(path, "utf8")) as T[]) this.items.set(r.key, r);
    }
  }

  has(key: string): boolean {
    const r = this.items.get(key);
    return r !== undefined && !(r as { error?: string }).error;
  }

  get(key: string): T | undefined {
    return this.items.get(key);
  }

  put(r: T): void {
    this.items.set(r.key, r);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.items.values()], null, 1));
    renameSync(tmp, this.path);
  }

  all(): T[] {
    return [...this.items.values()];
  }
}

export function resultsPath(outDir: string): string {
  return join(outDir, "results.json");
}
