/**
 * The third-party notices file Locadora ships (`notices.txt`, named by the
 * manifest's `license.notices`). Plain text, ASCII, English: it is the legal
 * text, not interface copy. It is built from what is installed, so the
 * versions and license texts it prints are the ones in the bundle.
 *
 * What it must say is the list in docs/EMULATOR_ROOM.md (the cores' licenses
 * and where their source is). The cores are served unmodified apart from being
 * repacked (build/container.mts); the frontend carries the four build-time
 * edits of build/patch.mts, so the corresponding source of what is served is
 * the upstream source plus this repository's patch file.
 */

export interface NoticeComponent {
  name: string;
  version: string;
  role: string;
  license: string;
  /** The text of the license as shipped in the package. */
  licenseText: string;
  source: string;
  upstream?: string;
  modification: string;
}

/** The two typefaces bundled in `src/fonts/` (sign and box titles, interface text), both SIL OFL 1.1. */
export const FONT_FILES = [
  {
    name: "Dela Gothic One",
    file: "dela-gothic-one-latin.woff2",
    license: "OFL-DelaGothicOne.txt",
    role: "the typeface of the sign and the box titles (Latin subset)",
    source: "https://github.com/syakuzen/DelaGothic",
  },
  {
    name: "Instrument Sans",
    file: "instrument-sans-latin.woff2",
    license: "OFL-InstrumentSans.txt",
    role: "the typeface of the interface text (Latin subset)",
    source: "https://github.com/Instrument/instrument-sans",
  },
] as const;

/** Notice entries for `FONT_FILES`; `read` returns the text of a file in `src/fonts/`. */
export function fontNotices(read: (file: string) => string): NoticeComponent[] {
  return FONT_FILES.map((font) => ({
    name: font.name,
    version: "as served by Google Fonts",
    role: font.role,
    license: "OFL-1.1",
    licenseText: read(font.license),
    source: font.source,
    modification: `subset to the Latin range and served as ${font.file}; no change to the glyphs`,
  }));
}

function rule(char: string): string {
  return char.repeat(72);
}

/**
 * Where the pictures came from (`src/art/`, its README): generated images, from our own prompts, credited here and
 * in the app's Licenças view, which shows this file.
 */
export const ARTWORK_NOTICE: readonly string[] = [
  "Artwork: the shop, the street, the cartridges, the TV, the controllers and the",
  "neon sign (src/art/) were generated with Google Gemini (Nano Banana 2.1) from",
  "pqp's own prompts, then keyed to transparency and packed to WebP by hand. None of",
  "them is a screenshot or a copy of anyone's artwork, and none carries a brand",
  "name, a logo or a character.",
];

export function renderNotices(components: readonly NoticeComponent[], pqpSource: string): string {
  const out: string[] = [];
  out.push("Locadora: third-party notices");
  out.push(rule("="));
  out.push("");
  out.push("Locadora is an emulator. It does not provide, include, link to or name any game.");
  out.push("A person opens a game file from their own disk and it is read in their browser.");
  out.push("The file is never uploaded. It stays on the device, in the browser's own");
  out.push("storage, and nowhere else.");
  out.push("");
  out.push("Locadora is part of pqp (AGPL-3.0-only, source: " + pqpSource + "). It ships the");
  out.push("software below, each under its own license, with the source code at the links given.");
  out.push("");
  for (const line of ARTWORK_NOTICE) out.push(line);
  out.push("");
  components.forEach((component, index) => {
    out.push(`${index + 1}. ${component.name} ${component.version}: ${component.role}`);
    out.push(`   License: ${component.license}`);
    out.push(`   Source: ${component.source}`);
    if (component.upstream) out.push(`   Upstream: ${component.upstream}`);
    out.push(`   Changes: ${component.modification}`);
    out.push("");
  });
  out.push("The licenses below are the texts that came with each component.");
  for (const component of components) {
    out.push("");
    out.push(rule("-"));
    out.push(`${component.name} ${component.version} (${component.license})`);
    out.push(rule("-"));
    out.push("");
    out.push(component.licenseText.replace(/\r\n/g, "\n").trimEnd());
  }
  out.push("");
  return out.join("\n");
}
