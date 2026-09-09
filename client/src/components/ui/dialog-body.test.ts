import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every dialog either pads its body or is deliberately full bleed.
 *
 * `Dialog` does not pad its own children, because several dialogs fill the
 * panel edge to edge on purpose: the settings modals put a section rail
 * against the border, the attachment lightbox is one image, the search dialog
 * draws its own chrome. The cost is that an ordinary dialog has to remember
 * `px-5 py-4`, and one that forgets looks broken in a specific way: the copy
 * and the fields run flush into the border.
 *
 * A 2026-09-08 review found four dialogs doing exactly that, two of them added
 * that same day. So the rule is a test rather than a habit: a dialog body
 * either uses `DialogBody`, or carries its own horizontal padding, or is named
 * below as full bleed with a reason.
 */

const ROOT = join(import.meta.dirname, "..");

/**
 * Full bleed on purpose. Adding a reason here is the point: the list is a
 * record of decisions, not a mute button.
 */
const FULL_BLEED: Record<string, string> = {
  "layout/settings-modal.tsx": "section rail sits against the panel edge",
  "layout/server-settings-dialog.tsx": "section rail sits against the panel edge",
  "layout/channel-settings-dialog.tsx": "section rail sits against the panel edge",
  "chat/attachment-grid.tsx": "the lightbox is one image, edge to edge",
  "search/search-dialog.tsx": "draws its own header and result chrome",
  "onboarding/onboarding-flow.tsx": "each step pads itself as it slides in",
};

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsxFiles(full));
    } else if (entry.endsWith(".tsx") && !entry.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
  return out;
}

/** The children between a `<Dialog ...>` opening tag and its `</Dialog>`. */
function dialogBodies(source: string): string[] {
  const bodies: string[] = [];
  const opens = [...source.matchAll(/<Dialog\b/g)];
  for (const open of opens) {
    let i = open.index + open[0].length;
    let depth = 0;
    while (i < source.length) {
      const c = source[i];
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === ">" && depth === 0 && source[i - 1] !== "=") break;
      i += 1;
    }
    const end = source.indexOf("</Dialog>", i);
    if (end < 0) continue;
    bodies.push(source.slice(i + 1, end).trim());
  }
  return bodies;
}

describe("dialog bodies", () => {
  const offenders: string[] = [];

  for (const file of tsxFiles(ROOT)) {
    const rel = file.slice(ROOT.length + 1);
    const source = readFileSync(file, "utf8");
    if (!source.includes("<Dialog")) continue;
    for (const body of dialogBodies(source)) {
      // An empty body (the description lives in the padded header) is fine.
      if (!body || body === "{null}") continue;
      if (rel in FULL_BLEED) continue;
      const usesHelper = body.includes("<DialogBody");
      // Otherwise the outermost element must carry its own horizontal padding.
      const firstClass = body.slice(0, 500).match(/className="([^"]*)"/);
      const padded = /\b(px-\d|p-\d)/.test(firstClass?.[1] ?? "");
      if (!usesHelper && !padded) {
        offenders.push(rel);
      }
    }
  }

  it("either use DialogBody, pad themselves, or are listed as full bleed", () => {
    expect(offenders).toEqual([]);
  });

  it("keeps the full-bleed list honest: every entry still has a dialog", () => {
    for (const rel of Object.keys(FULL_BLEED)) {
      const source = readFileSync(join(ROOT, rel), "utf8");
      expect([rel, source.includes("<Dialog")]).toEqual([rel, true]);
    }
  });
});
