/**
 * UTF-8 text that was once read as latin-1, put back.
 *
 * `LegiÃ£o Urbana - Pais E Filhos` is a real YouTube title, stored that way
 * by the uploader, and YouTube hands it to everybody exactly as it is: its
 * own oEmbed and its own watch page say the same thing. Nothing in our
 * parse path did it, so nothing in our parse path can avoid it. Old
 * Brazilian uploads carry this constantly, which is who our rooms are, so
 * the repair happens on the way in and only on the way in: the title we
 * show is ours, the one on YouTube is theirs.
 *
 * The bytes tell the story. `ã` is U+00E3, which is `C3 A3` in UTF-8; read
 * one byte at a time as latin-1 that is `Ã` + `£`. So the repair is to
 * write the string back out as latin-1 bytes and read them as UTF-8 again.
 *
 * Three guards keep an honest title from being mangled:
 *   1. every character must fit in a latin-1 byte, or it never came from
 *      this mistake and an emoji would be destroyed by the attempt;
 *   2. the decode is strict, so anything that is not valid UTF-8 is left
 *      alone rather than filled with replacement characters;
 *   3. the text must carry a telltale pair first. A lone `Ã` is somebody's
 *      capital A with a tilde and stays exactly where it is.
 *
 * Double encoding happens (`LegiÃƒÂ£o`), so the repair runs until the text
 * stops changing, with a small cap.
 */

/**
 * A `Ã`, `Â`, `â`, `Ð` or `Ñ` followed by what would be a UTF-8 continuation
 * byte. Portuguese, Spanish and French text does not produce these pairs;
 * mojibake produces almost nothing else.
 */
const TELLTALE = /[ÃÂâÐÑ][-¿]/;

const MAX_ROUNDS = 3;

const decoder = new TextDecoder("utf-8", { fatal: true });

function decodeOnce(text: string): string | null {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code > 0xff) {
      // An emoji, a CJK character, a curly quote: never part of this
      // mistake, and not something to force through a byte.
      return null;
    }
    bytes[index] = code;
  }
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/** Returns `text` unchanged unless it is recoverable mojibake. */
export function repairMojibake(text: string): string {
  let current = text;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (!TELLTALE.test(current)) {
      return current;
    }
    const next = decodeOnce(current);
    if (next === null || next === current || next.includes("�")) {
      return current;
    }
    current = next;
  }
  return current;
}
