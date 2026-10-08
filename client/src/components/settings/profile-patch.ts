import type { User } from "@pqp/shared";
import { ApiError, type updateMe } from "@/lib/api";

/**
 * The four profile values that wait for "Salvar alterações". Everything else
 * in Settings applies the moment it is touched; these are staged because a
 * rename regenerates the tag's number and a public handle locks for 30 days.
 */
export interface ProfileDrafts {
  displayName: string;
  username: string;
  handle: string;
  avatarUrl: string;
}

export type ProfilePatch = Parameters<typeof updateMe>[0];

/** The drafts a freshly opened dialog starts from. */
export function profileDraftsFrom(user: User): ProfileDrafts {
  return {
    displayName: user.displayName,
    username: user.username ?? "",
    handle: user.handle ?? "",
    avatarUrl: user.avatarUrl ?? "",
  };
}

/**
 * Whether anything is staged. Trimmed drafts against the account, with the
 * account's nulls read as empty first: an account with no handle and an empty
 * handle field is not an edit, and must not hold the dialog open.
 */
export function isProfileDirty(user: User | null, drafts: ProfileDrafts): boolean {
  if (!user) {
    return false;
  }
  const saved = profileDraftsFrom(user);
  return (
    drafts.displayName.trim() !== saved.displayName.trim() ||
    // An emptied username or link is not an edit: the save keeps the saved
    // value for both (there is no way to release either), so treating the
    // blank as a change would trip the close guard and then "save" nothing.
    (drafts.username.trim() !== "" && drafts.username.trim() !== saved.username.trim()) ||
    (drafts.handle.trim() !== "" && drafts.handle.trim() !== saved.handle.trim()) ||
    drafts.avatarUrl.trim() !== saved.avatarUrl.trim()
  );
}

/**
 * Whether saving these drafts would claim or change the public handle, which
 * locks it for 30 days and therefore asks first. Null when the handle stays.
 */
export function pendingHandleChange(
  user: User,
  drafts: ProfileDrafts,
): "claim" | "change" | null {
  const next = drafts.handle.trim();
  if (!next || next === (user.handle ?? "")) {
    return null;
  }
  return user.handle ? "change" : "claim";
}

/**
 * The `PATCH /api/me` body for a save, with the semantics the form has always
 * had:
 *
 * - `displayName` only when it changed, so an account whose name predates the
 *   length limit can still save an unrelated field.
 * - `username` as `trim() || undefined`: blank leaves it alone.
 * - `avatarUrl` as `trim() || null`: blank clears it.
 * - `handle` only when non-empty. An absent key means "leave it alone", and
 *   there is deliberately no way to RELEASE a handle from this form: releasing
 *   one hands somebody else a URL that is already in a hundred screenshots. An
 *   unchanged handle is re-sent, which the server treats as a free no-op.
 */
export function buildProfilePatch(user: User, drafts: ProfileDrafts): ProfilePatch {
  const displayName = drafts.displayName.trim();
  return {
    displayName: displayName !== user.displayName ? displayName : undefined,
    username: drafts.username.trim() || undefined,
    avatarUrl: drafts.avatarUrl.trim() || null,
    ...(drafts.handle ? { handle: drafts.handle } : {}),
  };
}

/**
 * Whether a failed profile save lost the public link to somebody else.
 *
 * `PATCH /api/me` claims the handle first and answers 409 when the word is
 * taken. A username whose numbers ran out is a 409 too, so the status alone
 * is not enough: the patch must carry a handle and the server's sentence must
 * be about the handle. The server's English sentence is never shown for this
 * case; the shell says "Esse link já tem dono" in the reader's language.
 */
export function isHandleTakenError(error: unknown, patch: ProfilePatch): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    typeof patch.handle === "string" &&
    /\bhandle\b/i.test(error.message) &&
    !/\busername\b/i.test(error.message)
  );
}

/**
 * Characters that reorder the text around them without drawing anything: the
 * bidi embeddings and overrides (U+202A to U+202E), the isolates (U+2066 to
 * U+2069) and the three directional marks. In a display name, U+202E turns
 * "Rafa" plus "gpj.exe" into something that reads as another name, and nobody
 * typing an ordinary name needs any of them.
 */
const BIDI_CONTROL = /[‪-‮⁦-⁩‎‏؜]/;

export function hasBidiControl(value: string): boolean {
  return BIDI_CONTROL.test(value);
}

/**
 * Characters that draw nothing: format characters (zero-width space and
 * joiner, soft hyphen, BOM), the Braille blank and the Hangul fillers. A name
 * made only of these reads as empty everywhere it is shown.
 */
const INVISIBLE = /[\p{Cf}\u2800\u3164\u115F\u1160\uFFA0]/gu;

/** True when the name would show at least one visible character. */
export function hasVisibleText(value: string): boolean {
  return value.replace(INVISIBLE, "").trim() !== "";
}

/** Tabs and line breaks pasted into a one-line name become spaces. */
export function withoutControlCharacters(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]/g, " ");
}

/**
 * The longest avatar link the server takes: `avatarUrl` in `updateProfileSchema`
 * (`packages/shared/src/api.ts`) is `.max(500)`. A test pins the two together.
 */
export const AVATAR_URL_MAX_LENGTH = 500;

/**
 * Why a pasted avatar link will not do, or null when it will. Only `https://`
 * with a host. The server also takes `http://` and anything starting with "/",
 * but the browser upgrades or blocks a plain-http image on an https page,
 * "//host" is a protocol-relative link nobody means to paste, and a path is
 * what an upload stores, never something typed.
 */
export function avatarLinkProblem(value: string): "length" | "format" | null {
  if (value.length > AVATAR_URL_MAX_LENGTH) {
    return "length";
  }
  if (!/^https:\/\//i.test(value)) {
    return "format";
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "" ? null : "format";
  } catch {
    return "format";
  }
}
