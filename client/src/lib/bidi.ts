/**
 * Text a person wrote, drawn inside the app's own sentence.
 *
 * A song's title, an artist, a take's label and a display name are typed by
 * strangers. The unicode bidi algorithm lets one character change how the text
 * AFTER it is laid out: an unclosed right-to-left override (U+202E) in an artist
 * turns "Artista · Gabi" into "ibaG · atsitrA", and a short Arabic title next to
 * an English "by" swaps their order. Neither is a bug in the text, both are what
 * a bare interpolation does with it.
 *
 * The server stops new ones at the door (`cleanLine` in `@pqp/shared`'s
 * `jam.ts` strips the override, embedding and isolate controls), but a row
 * written before that still holds them, and a name comes from an account, not
 * from a jam. So every screen that puts such text inside copy of its own
 * isolates it:
 *
 *   - a STRING that is interpolated and DRAWN (`t("...", { name })`, a template
 *     literal) goes through `isolate()`: first-strong isolate characters
 *     (U+2068 .. U+2069) around the text, so whatever direction it has stays
 *     inside it and the words around it keep theirs. An `aria-label` is read in
 *     logical order, so it only needs `bidiClean()`;
 *   - a JSX node that sits inline beside other text uses `<UserText>`
 *     (`components/jam/user-text.tsx`), a `<bdi>`, which is the same isolate
 *     for the DOM.
 *
 * Both first drop the explicit controls from the text itself, which is what
 * makes the isolate hold: a U+2069 inside the text would close it early. Real
 * right-to-left text is not touched (it has no explicit controls in it).
 */

const EXPLICIT_CONTROLS = /[‪-‮⁦-⁩]/g;

const FSI = "⁨";
const PDI = "⁩";

/** The text without bidi override, embedding and isolate controls. */
export function bidiClean(text: string): string {
  return text.replace(EXPLICIT_CONTROLS, "");
}

/**
 * The text as a self-contained unit for a string: nothing in it can reorder what
 * is around it, and nothing around it reorders it. Empty stays empty (an isolate
 * with nothing inside would be two invisible characters in an otherwise empty
 * slot).
 */
export function isolate(text: string): string {
  const clean = bidiClean(text);
  return clean === "" ? "" : `${FSI}${clean}${PDI}`;
}

/** `isolate` for a value that may be absent. */
export function isolateOpt(text: string | null | undefined): string {
  return text ? isolate(text) : "";
}
