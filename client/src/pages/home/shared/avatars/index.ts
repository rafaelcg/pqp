/*
 * The sample cast's profile pictures: six 16 by 16 pixel-art characters, drawn
 * for this page (nobody's photo, no character from a game or a brand). Each is
 * a solid field with one bold shape, so it still reads at 20 px.
 *
 * The files are the pixel grids as drawn, a few hundred bytes each, so the
 * build inlines them. `Avatar` scales them up with `image-rendering: pixelated`.
 * The 512 px copies for the recorded accounts are made from the same grids by
 * the script that drew these, and they are not part of the bundle.
 *
 * Keyed by CAST key. A person with no entry here is drawn as a letter.
 */
import bia from "./bia.png";
import caio from "./caio.png";
import duda from "./duda.png";
import leo from "./leo.png";
import nico from "./nico.png";
import zeca from "./zeca.png";

export const AVATARS = { zeca, bia, caio, nico, duda, leo } as const;

export type AvatarId = keyof typeof AVATARS;
