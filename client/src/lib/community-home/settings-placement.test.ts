import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Control placement lock: the MANAGE_SERVER `community_home_enabled` toggle
 * lives only in Server settings (name / icon / roles panel). Not channel
 * settings, not the /c/slug community listing editor, not user settings.
 */
const IMPORT_NEEDLE = "community-home-settings-section";
const ALLOWED = new Set([
  "client/src/components/layout/server-settings-dialog.tsx",
]);

function walkTsx(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      walkTsx(path, out);
      continue;
    }
    if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

describe("Baú settings control placement", () => {
  it("imports CommunityHomeSettingsSection only from Server settings", () => {
    const clientRoot = join(process.cwd(), "src");
    const offenders: string[] = [];
    for (const abs of walkTsx(clientRoot)) {
      if (abs.endsWith("community-home-settings-section.tsx")) {
        continue;
      }
      if (abs.endsWith(".test.ts") || abs.endsWith(".test.tsx")) {
        continue;
      }
      const source = readFileSync(abs, "utf8");
      if (!source.includes(IMPORT_NEEDLE)) {
        continue;
      }
      const rel = abs.replace(`${process.cwd()}/`, "client/");
      if (!ALLOWED.has(rel)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not put the toggle in channel settings, community listing, or user settings", () => {
    const forbidden = [
      "src/components/layout/channel-settings-dialog.tsx",
      "src/components/communities/community-settings-section.tsx",
      "src/components/layout/settings-modal.tsx",
    ];
    for (const rel of forbidden) {
      const source = readFileSync(join(process.cwd(), rel), "utf8");
      expect(source).not.toContain(IMPORT_NEEDLE);
      expect(source).not.toContain("updateServerCommunityHomeConfig");
      expect(source).not.toContain("communityHome.settings.title");
    }
  });
});
