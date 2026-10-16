export const MAX_AGE_MS: number;
export const MAX_ENTRIES: number;
export const LOG_FORMAT: string;
export interface RawChange {
  pr: number | null;
  at: number;
  note: Record<string, string>;
}
export function extractNotes(body: string): Record<string, string>;
export function prFromSubject(subject: string): number | null;
export function parseLog(raw: string): RawChange[];
export function mergeChanges(
  previous: unknown,
  fresh: RawChange[],
  now: number,
): { generatedAt: number; entries: RawChange[] };
