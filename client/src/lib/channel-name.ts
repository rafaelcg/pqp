/**
 * The longest name `createChannelSchema` and `updateChannelSchema` accept.
 * Both name fields cap at it, so a pasted paragraph is cut in the field
 * instead of being refused by the server after the click. `channel-name.test.ts`
 * holds this number to the schemas.
 */
export const CHANNEL_NAME_MAX_LENGTH = 100;

/**
 * What a typed channel name becomes, keystroke by keystroke. The create
 * dialog and the rename field in channel settings both run it, so a name one
 * of them accepts is a name the other accepts too.
 *
 * Accents FOLD instead of vanishing — a Brazilian keyboard produces `ç` and
 * `ã` by reflex, and stripping them turns "caça-bugs" into "caa-bugs", a
 * misspelling nobody typed. Same argument `normalizeHandle` makes for
 * handles. Spaces become hyphens for the same reason: "mesa de rpg" means
 * "mesa-de-rpg", not "mesaderpg".
 */
export function sanitizeChannelName(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "")
    .slice(0, CHANNEL_NAME_MAX_LENGTH);
}
