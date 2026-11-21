import { jamArtistSchema, jamTitleSchema } from "@pqp/shared";

/**
 * Whether a song's title or artist will be accepted, asked of the SAME rule the
 * server applies (`jamTitleSchema` and `jamArtistSchema` in `@pqp/shared`'s
 * `jam.ts`), so the two cannot drift: bidi controls stripped, whitespace
 * collapsed, and something visible left to read. A title of nothing but
 * zero-width spaces looks empty and used to pass every client check, let the
 * person record a whole take, and fail at the server with a generic line.
 *
 * `empty` is nothing typed (or only spaces); `invisible` is something typed that
 * draws nothing; `long` is past the limit.
 */
export type JamTextProblem = "empty" | "invisible" | "long";

/** The message the shared rule gives text that draws nothing (`oneLine` in `jam.ts`). */
const NOTHING_TO_READ = "Nothing to read";

function problemOf(
  schema: { safeParse: (value: unknown) => { success: boolean; error?: { issues: Array<{ message: string; code: string }> } } },
  value: string,
): JamTextProblem | null {
  const result = schema.safeParse(value);
  if (result.success) {
    return null;
  }
  if (value.replace(/\s+/g, "") === "") {
    return "empty";
  }
  const issues = result.error?.issues ?? [];
  if (issues.some((issue) => issue.message === NOTHING_TO_READ)) {
    return "invisible";
  }
  return "long";
}

/** The title as the server will store it, or why it will not be. */
export function jamTitleCheck(value: string): { ok: true; title: string } | { ok: false; problem: JamTextProblem } {
  const parsed = jamTitleSchema.safeParse(value);
  if (parsed.success) {
    return { ok: true, title: parsed.data };
  }
  return { ok: false, problem: problemOf(jamTitleSchema, value) ?? "empty" };
}

/** The artist as the server will store it (null: an original), or why it will not be. */
export function jamArtistCheck(value: string): { ok: true; artist: string | null } | { ok: false; problem: JamTextProblem } {
  const parsed = jamArtistSchema.safeParse(value);
  if (parsed.success) {
    return { ok: true, artist: parsed.data };
  }
  return { ok: false, problem: problemOf(jamArtistSchema, value) ?? "long" };
}
