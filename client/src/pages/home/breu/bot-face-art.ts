// Vendored from PR#1188 (`feat/custom-bots`, packages/shared/src/bot-face.ts)
// for the homepage's mascot, cut down to what the page draws: lime only,
// always painted with the page's `--color-bot-*` tokens (breu.css), and no PNG
// helpers. Delete once PR#1188 is on main and import from `@pqp/shared` instead.

/**
 * Breu, the face of every server bot: a dark creature with an outline, eyes
 * and mouth in the bot's colour. One source for every place it is drawn: the
 * web client inlines these SVGs (and animates them), and the PNGs the API
 * serves to the phone apps are rendered from the same strings
 * (`tools/bot-faces/render.mts`).
 *
 * Two drawings of each face. `full` is the character (the wizard, the profile
 * card): thin outline, floating hands. `avatar` is cropped tight for 16 to 64
 * px: thicker outline, bigger eyes, no hands, and a body one step lighter and
 * tinted with the bot's colour so it does not vanish on a dark surface.
 */

// Only lime has page tokens (breu.css). The six names (coral, sky, grape, sun,
// mint) come back when this folder is replaced by PR#1188's own code.
export const BOT_COLORS = ["lime"] as const;
export type BotColor = (typeof BOT_COLORS)[number];
export const BOT_DEFAULT_COLOR: BotColor = "lime";

/** The faces staff pick from. The bot's live face (working, asleep) is drawn on top of this. */
export const BOT_BASE_FACES = ["oi", "curioso", "kkkk", "focado", "bravo"] as const;
export type BotBaseFace = (typeof BOT_BASE_FACES)[number];
export const BOT_DEFAULT_FACE: BotBaseFace = "oi";

/** Every expression, including the ones only a state shows. */
export const BOT_FACES = [
  ...BOT_BASE_FACES,
  "falando",
  "triste",
  "dormindo",
  "panico",
] as const;
export type BotFace = (typeof BOT_FACES)[number];

const ROUND =
  "M44 150 C30 104 52 46 100 46 C148 46 170 104 156 150 C148 170 132 158 122 172 C112 160 92 178 80 164 C68 174 52 168 44 150 Z";
const SPIKY =
  "M44 150 L38 116 L52 100 L48 72 L72 62 L82 40 L100 48 L118 40 L128 62 L152 72 L148 100 L162 116 L156 150 C148 170 132 158 122 172 C112 160 92 178 80 164 C68 174 52 168 44 150 Z";
const PANIC =
  "M44 150 L34 118 L50 104 L40 76 L64 66 L66 40 L90 50 L100 26 L112 50 L136 40 L138 66 L162 76 L152 104 L168 118 L156 150 C148 170 132 158 122 172 C112 160 92 178 80 164 C68 174 52 168 44 150 Z";
const SAD =
  "M54 160 C46 120 62 60 100 60 C138 60 154 120 146 160 C138 176 126 166 118 178 C110 168 90 182 82 170 C72 178 58 174 54 160 Z";
const ASLEEP = "M34 162 C26 122 56 84 100 84 C144 84 174 122 166 162 C150 176 50 176 34 162 Z";

function bodyPath(face: BotFace): string {
  if (face === "bravo") return SPIKY;
  if (face === "panico") return PANIC;
  if (face === "triste") return SAD;
  if (face === "dormindo") return ASLEEP;
  return ROUND;
}

interface Pen {
  ink: string;
  body: string;
  hole: string;
  stroke: number;
}

const line = (pen: Pen, d: string, width = pen.stroke): string =>
  `<path d="${d}" fill="none" stroke="${pen.ink}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
const ellipse = (pen: Pen, cx: number, cy: number, rx: number, ry: number): string =>
  `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${pen.ink}"/>`;
// The tilt sits on a wrapper so the CSS float on `.bf-hand` does not replace it.
const hand = (pen: Pen, cx: number, cy: number, rotate = 0): string =>
  `<g${rotate ? ` transform="rotate(${rotate} ${cx} ${cy})"` : ""}><ellipse class="bf-hand" cx="${cx}" cy="${cy}" rx="12" ry="14" fill="${pen.body}" stroke="${pen.ink}" stroke-width="${pen.stroke}"/></g>`;
const text = (pen: Pen, x: number, y: number, size: number, value: string, opacity = 1): string =>
  `<text x="${x}" y="${y}" font-family="Gabarito, system-ui, sans-serif" font-weight="700" font-size="${size}" fill="${pen.ink}"${opacity < 1 ? ` opacity="${opacity}"` : ""}>${value}</text>`;

/**
 * A "z" drawn as a path, not as text, for the sleeping drawing. That Breu
 * sits inside the closer's heading, and an SVG `<text>` there puts its letters
 * into the heading's text content ("Acabou a página. zz Chama a galera.").
 * The outline is Gabarito Bold's z, the page's brand face, at 400 units to the
 * em with the baseline at 0 and y pointing down; `size` is the em in viewBox
 * units. The group carries the opacity and the class, so CSS can move it,
 * fade it and, under reduced motion, leave it as drawn.
 */
const Z_OUTLINE = "M17 -195.5 H175.5 V-151.3 L87.7 -53.5 H177 V0 H14.5 V-45.5 L107.4 -149 H17 Z";
const glyphZ = (pen: Pen, x: number, y: number, size: number, className: string, opacity = 0.6): string =>
  `<g class="${className}" opacity="${opacity}"><path d="${Z_OUTLINE}" transform="translate(${x} ${y}) scale(${size / 400})" fill="${pen.ink}"/></g>`;

/** Eyes and mouth of the character drawing (viewBox 0 0 200 200). */
interface Features {
  eyes: string;
  rest: string;
  /** Drawn outside the tilt (a "?" stays upright). */
  outside?: string;
}

function fullFeatures(face: BotFace, pen: Pen): Features {
  switch (face) {
    case "falando":
      return {
        eyes: ellipse(pen, 84, 92, 8, 13) + ellipse(pen, 118, 92, 8, 13),
        rest:
          `<ellipse cx="101" cy="126" rx="10" ry="11" fill="${pen.hole}" stroke="${pen.ink}" stroke-width="${pen.stroke}"/>` +
          line(pen, "M170 98 Q178 112 170 126 M182 88 Q196 112 182 136"),
      };
    case "curioso":
      return {
        eyes: ellipse(pen, 84, 94, 10, 15) + ellipse(pen, 120, 97, 6, 9),
        rest: `<circle cx="102" cy="126" r="4.5" fill="${pen.ink}"/>`,
        outside: text(pen, 150, 58, 36, "?"),
      };
    case "focado":
      return {
        eyes:
          `<rect x="72" y="90" width="22" height="9" rx="4.5" fill="${pen.ink}"/>` +
          `<rect x="108" y="90" width="22" height="9" rx="4.5" fill="${pen.ink}"/>`,
        rest: line(pen, "M92 124 H112") + hand(pen, 22, 118) + hand(pen, 178, 118),
      };
    case "kkkk":
      return {
        eyes: line(pen, "M74 98 Q84 84 94 98 M108 98 Q118 84 128 98", pen.stroke + 1),
        rest:
          `<path d="M80 114 Q101 150 122 114 Z" fill="${pen.ink}" stroke="${pen.ink}" stroke-width="3" stroke-linejoin="round"/>` +
          `<path d="M92 126 Q101 136 110 126" fill="${pen.hole}"/>`,
      };
    case "triste":
      return {
        eyes: ellipse(pen, 84, 106, 7, 11) + ellipse(pen, 116, 106, 7, 11),
        rest: line(pen, "M72 92 L92 84 M128 92 L108 84") + line(pen, "M88 140 Q100 132 112 140"),
      };
    case "dormindo":
      return {
        eyes: line(pen, "M76 124 H92 M108 124 H124"),
        rest:
          `<circle cx="100" cy="142" r="3.5" fill="${pen.ink}"/>` +
          // 56 and 38 units to the em: the size the closer sets them at (fim.css).
          glyphZ(pen, 148, 62, 56, "breu-z") +
          glyphZ(pen, 166, 42, 38, "breu-z breu-z-2"),
      };
    case "panico":
      return {
        eyes:
          `<circle cx="82" cy="96" r="14" fill="none" stroke="${pen.ink}" stroke-width="${pen.stroke}"/>` +
          `<circle cx="120" cy="96" r="14" fill="none" stroke="${pen.ink}" stroke-width="${pen.stroke}"/>` +
          `<circle cx="82" cy="96" r="3.5" fill="${pen.ink}"/><circle cx="120" cy="96" r="3.5" fill="${pen.ink}"/>`,
        rest: line(pen, "M84 130 L90 124 L96 130 L102 124 L108 130 L114 124 L120 130"),
      };
    case "bravo":
      return {
        eyes: `<path d="M68 86 L98 98 L68 110 Z M134 86 L104 98 L134 110 Z" fill="${pen.ink}"/>`,
        rest: line(pen, "M84 136 Q101 124 118 136"),
      };
    case "oi":
    default:
      return {
        eyes: ellipse(pen, 84, 94, 8, 13) + ellipse(pen, 118, 94, 8, 13),
        rest: line(pen, "M90 120 Q101 129 112 120") + hand(pen, 168, 70, 15),
      };
  }
}

/** Eyes and mouth of the avatar drawing (viewBox 26 30 152 152), bold enough for 16 px. */
function avatarFeatures(face: BotFace, pen: Pen): Features {
  switch (face) {
    case "curioso":
      return {
        eyes: ellipse(pen, 84, 94, 12, 17) + ellipse(pen, 120, 97, 7, 10),
        rest: `<circle cx="102" cy="130" r="6" fill="${pen.ink}"/>`,
      };
    case "focado":
      return {
        eyes:
          `<rect x="70" y="88" width="28" height="12" rx="6" fill="${pen.ink}"/>` +
          `<rect x="104" y="88" width="28" height="12" rx="6" fill="${pen.ink}"/>`,
        rest: line(pen, "M90 128 H112"),
      };
    case "kkkk":
      return {
        eyes: line(pen, "M72 100 Q84 84 96 100 M106 100 Q118 84 130 100", pen.stroke + 1),
        rest: `<path d="M80 116 Q101 152 122 116 Z" fill="${pen.ink}"/>`,
      };
    case "bravo":
      return {
        eyes: `<path d="M68 86 L98 98 L68 110 Z M134 86 L104 98 L134 110 Z" fill="${pen.ink}"/>`,
        rest: line(pen, "M84 136 Q101 124 118 136"),
      };
    case "dormindo":
      return {
        eyes: line(pen, "M72 124 H94 M106 124 H128"),
        rest: "",
      };
    case "triste":
      return {
        eyes: ellipse(pen, 84, 104, 9, 13) + ellipse(pen, 118, 104, 9, 13),
        rest: line(pen, "M86 142 Q101 132 116 142"),
      };
    case "panico":
      return {
        eyes:
          `<circle cx="82" cy="98" r="15" fill="none" stroke="${pen.ink}" stroke-width="${pen.stroke}"/>` +
          `<circle cx="120" cy="98" r="15" fill="none" stroke="${pen.ink}" stroke-width="${pen.stroke}"/>`,
        rest: "",
      };
    case "falando":
      return {
        eyes: ellipse(pen, 84, 92, 10, 15) + ellipse(pen, 118, 92, 10, 15),
        rest: `<ellipse cx="101" cy="130" rx="11" ry="12" fill="${pen.ink}"/>`,
      };
    case "oi":
    default:
      return {
        eyes: ellipse(pen, 84, 94, 10, 15) + ellipse(pen, 118, 94, 10, 15),
        rest: line(pen, "M88 126 Q101 136 114 126"),
      };
  }
}

export interface BotFaceSvgOptions {
  color: BotColor;
  face: BotFace;
  variant: "full" | "avatar";
  /** Pixel size; the viewBox is fixed per variant. */
  size?: number;
  /** Accessible name; without it the SVG is decorative. */
  title?: string;
}

/**
 * The drawing as an SVG string. Built only from the constants above, never
 * from user input, so it is safe to inline. Classes for the web client's
 * motion: `bf-body` (breathing), `bf-eyes` (blinking, looking), `bf-hand`.
 */
export function botFaceSvg(options: BotFaceSvgOptions): string {
  const full = options.variant === "full";
  // Always the page's `--color-bot-*` custom properties (breu.css), so no
  // colour literal sits in the client.
  const pen: Pen = {
    ink: `var(--color-bot-${options.color})`,
    body: full ? "var(--color-bot-body)" : `var(--color-bot-${options.color}-body)`,
    hole: "var(--color-bot-hole)",
    stroke: full ? 3.5 : 8,
  };
  const { eyes, rest, outside = "" } = full
    ? fullFeatures(options.face, pen)
    : avatarFeatures(options.face, pen);
  const viewBox = full ? "0 0 200 200" : options.face === "bravo" || options.face === "panico" ? "22 22 160 160" : "26 30 152 152";
  const tilt = options.face === "curioso" ? ` transform="rotate(-10 100 140)"` : "";
  const size = options.size ? ` width="${options.size}" height="${options.size}"` : "";
  const label = options.title
    ? ` role="img" aria-label="${options.title.replace(/[<>&"]/g, "")}"`
    : ` aria-hidden="true"`;
  const body = `<path d="${bodyPath(options.face)}" fill="${pen.body}" stroke="${pen.ink}" stroke-width="${pen.stroke}" stroke-linejoin="round"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"${size}${label} overflow="visible">` +
    `<g class="bf-body"><g${tilt}>${body}<g class="bf-eyes">${eyes}</g>${rest}</g></g>` +
    outside +
    `</svg>`
  );
}
