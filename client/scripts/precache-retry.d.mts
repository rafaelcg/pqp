export const DEFAULT_WINDOW_MS: number;
export const DEFAULT_INTERVAL_MS: number;
export function checkWithRetry(options: {
  paths: string[];
  statusOf: (path: string) => Promise<number | string>;
  windowMs?: number;
  intervalMs?: number;
  concurrency?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}): Promise<{
  failed: Map<string, number | string>;
  recovered: number;
  attempts: number;
  elapsedMs: number;
  firstFailures: number;
}>;
