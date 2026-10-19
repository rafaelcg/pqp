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

function rule(char: string): string {
  return char.repeat(72);
}

export function renderNotices(components: readonly NoticeComponent[], pqpSource: string): string {
  const out: string[] = [];
  out.push("Locadora: third-party notices");
  out.push(rule("="));
  out.push("");
  out.push("Locadora is an emulator. It does not provide, include, link to or name any game.");
  out.push("A person opens a game file from their own disk, it is read in their browser and");
  out.push("it is never uploaded or stored.");
  out.push("");
  out.push("Locadora is part of pqp (AGPL-3.0-only, source: " + pqpSource + "). It ships the");
  out.push("software below, each under its own license, with the source code at the links given.");
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
