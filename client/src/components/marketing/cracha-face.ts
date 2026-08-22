/**
 * The crachá's printed face, drawn to a 2D canvas so three.js can use it as a
 * texture.
 *
 * WHY THIS IS NOT A DOWNLOADED 3D ASSET. Every lanyard demo on the internet
 * ships a `card.glb` with the artwork baked in. That cannot work here, because
 * the entire point of the badge on `/garanta` is that it shows the name while
 * the person is still typing it, before an account exists. A baked texture can
 * show one name; this can show theirs. The geometry underneath is a rounded box,
 * which is a dozen lines of code and no asset pipeline at all.
 *
 * WHY A CANVAS AND NOT AN HTML OVERLAY. An overlay would not tilt, would not
 * catch the light, and would drift out of register with the badge on every
 * frame the physics moved it. Painting the text into the texture means the name
 * is part of the object rather than floating in front of it.
 *
 * Everything here is pure: pass a handle, get pixels back. No three.js types
 * cross this boundary, so the whole file is testable in Node.
 */

/** Texture size. Power of two, and enough that the @ stays crisp on a retina tilt. */
export const FACE_WIDTH = 512;
export const FACE_HEIGHT = 700;

export interface FacePalette {
  ink: string;
  surface: string;
  accent: string;
  text: string;
  muted: string;
}

/**
 * pqp's palette, converted once to sRGB hex.
 *
 * WHY NOT READ THE CSS TOKENS AT RUNTIME. That was the first version and it
 * failed twice. `getComputedStyle` hands back `oklch(...)` verbatim rather than
 * converting to sRGB, so resolving through a probe element achieved nothing;
 * and `THREE.Color` cannot parse `oklch` at all, so every material silently
 * became white. These values were measured by painting each token to a 1x1
 * canvas in a real browser and reading the pixel, so they are exactly what the
 * stylesheet renders.
 *
 * The badge is a printed object with fixed brand colours, not a themed surface.
 * Not following runtime theming is the correct behaviour here as well as the
 * simpler one: a crachá does not change colour because you switched to light
 * mode.
 */
export const DEFAULT_PALETTE: FacePalette = {
  ink: "#090e12",
  surface: "#1b2127",
  accent: "#baed4d",
  text: "#eae9dd",
  muted: "#a9a497",
};

/**
 * Add alpha to a colour that may be hex or `rgb(...)`.
 *
 * WHY THIS EXISTS. The first version concatenated a hex alpha onto whatever the
 * stylesheet held: `${palette.accent}44`. pqp's tokens are `oklch(...)`, so that
 * produced `oklch(0.88 0.19 125)44`, which `addColorStop` rejects outright and
 * which took the whole page down with an error boundary. The caller now resolves
 * every token through the browser first, so what arrives here is always `rgb(r,
 * g, b)` or a hex string, and alpha is applied structurally instead of by string
 * concatenation.
 *
 * Anything unparseable comes back unchanged and fully opaque, which is a worse
 * picture and a working page.
 */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(color);
  if (rgb) {
    return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${a})`;
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  return color;
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Shrink the handle until it fits the badge's width.
 *
 * Handles run to 20 characters and the badge is 512px wide, so a fixed size
 * either wastes the short ones or overflows the long ones. Measured rather than
 * estimated, because the two faces here have very different widths per
 * character and a guess would be wrong for one of them.
 */
export function fitHandleSize(
  ctx: CanvasRenderingContext2D,
  handle: string,
  family: string,
  maxWidth: number,
  start = 92,
  min = 34,
): number {
  let size = start;
  while (size > min) {
    ctx.font = `800 ${size}px ${family}`;
    if (ctx.measureText(`@${handle}`).width <= maxWidth) {
      return size;
    }
    size -= 2;
  }
  return min;
}

export interface FaceOptions {
  handle: string;
  /** Shown under the name. The month somebody joins is the badge's edition. */
  edition: string;
  palette?: FacePalette;
  /** The two families, already loaded by the document. */
  displayFamily?: string;
  handleFamily?: string;
}

/**
 * Paint one side of the crachá. Returns the canvas so the caller can hand it
 * straight to a `CanvasTexture`.
 */
export function drawCrachaFace(
  canvas: HTMLCanvasElement,
  options: FaceOptions,
): HTMLCanvasElement {
  const {
    handle,
    edition,
    palette = DEFAULT_PALETTE,
    displayFamily = '"Gabarito", sans-serif',
    handleFamily = '"Bricolage Grotesque", sans-serif',
  } = options;

  canvas.width = FACE_WIDTH;
  canvas.height = FACE_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return canvas;
  }

  ctx.clearRect(0, 0, FACE_WIDTH, FACE_HEIGHT);

  // Body. A flat fill would read as a sticker; the diagonal gives the card a
  // direction so the light has something to travel along when it tilts.
  const body = ctx.createLinearGradient(0, 0, FACE_WIDTH, FACE_HEIGHT);
  body.addColorStop(0, palette.surface);
  body.addColorStop(1, palette.ink);
  ctx.fillStyle = body;
  ctx.fillRect(0, 0, FACE_WIDTH, FACE_HEIGHT);

  // The accent bloom, top left, matching the radial glow the marketing pages
  // already use so the badge looks like it came off the same site.
  const bloom = ctx.createRadialGradient(90, 40, 10, 90, 40, 460);
  bloom.addColorStop(0, withAlpha(palette.accent, 0.27));
  bloom.addColorStop(1, withAlpha(palette.accent, 0));
  ctx.fillStyle = bloom;
  ctx.fillRect(0, 0, FACE_WIDTH, FACE_HEIGHT);

  // Inner hairline, inset. Gives the print an edge so the badge does not look
  // like a screenshot of a div.
  ctx.strokeStyle = withAlpha(palette.text, 0.11);
  ctx.lineWidth = 2;
  roundedRect(ctx, 18, 18, FACE_WIDTH - 36, FACE_HEIGHT - 36, 20);
  ctx.stroke();

  // The slot the lanyard passes through, drawn as a hole rather than modelled,
  // because at this size nobody can tell and geometry is not free.
  ctx.fillStyle = palette.ink;
  roundedRect(ctx, FACE_WIDTH / 2 - 52, 44, 104, 18, 9);
  ctx.fill();
  ctx.strokeStyle = withAlpha(palette.text, 0.13);
  ctx.lineWidth = 1.5;
  roundedRect(ctx, FACE_WIDTH / 2 - 52, 44, 104, 18, 9);
  ctx.stroke();

  // Top rail.
  ctx.font = `600 20px ${displayFamily}`;
  ctx.fillStyle = palette.text;
  ctx.textAlign = "left";
  ctx.fillText("pqp", 44, 116);

  ctx.font = `500 15px ui-monospace, monospace`;
  ctx.fillStyle = palette.muted;
  ctx.textAlign = "right";
  ctx.fillText("BETA ABERTO", FACE_WIDTH - 44, 116);

  // The name. The whole reason the object exists, so it gets the middle of the
  // card and the face with opinions.
  const shown = handle.trim() || "seunome";
  const size = fitHandleSize(ctx, shown, handleFamily, FACE_WIDTH - 96);
  ctx.font = `800 ${size}px ${handleFamily}`;
  ctx.textAlign = "center";

  ctx.fillStyle = palette.muted;
  const atWidth = ctx.measureText("@").width;
  const nameWidth = ctx.measureText(shown).width;
  const totalWidth = atWidth + nameWidth;
  const left = FACE_WIDTH / 2 - totalWidth / 2;
  ctx.textAlign = "left";
  ctx.fillText("@", left, FACE_HEIGHT / 2 + size / 3);
  ctx.fillStyle = palette.accent;
  ctx.fillText(shown, left + atWidth, FACE_HEIGHT / 2 + size / 3);

  // Foot rail.
  ctx.font = `500 14px ui-monospace, monospace`;
  ctx.fillStyle = palette.muted;
  ctx.textAlign = "left";
  ctx.fillText("PERFIL PÚBLICO", 44, FACE_HEIGHT - 92);
  ctx.textAlign = "right";
  ctx.fillText(edition.toUpperCase(), FACE_WIDTH - 44, FACE_HEIGHT - 92);

  ctx.font = `600 17px ${displayFamily}`;
  ctx.fillStyle = withAlpha(palette.text, 0.8);
  ctx.textAlign = "center";
  ctx.fillText(`pqp.gg/@${shown}`, FACE_WIDTH / 2, FACE_HEIGHT - 54);

  return canvas;
}
