import { describe, expect, it } from "vitest";
import { showsServerSettingsEntry } from "./channel-list";
import { firstVisibleSection, soundboardAuditDetails } from "./server-settings-dialog";

/*
 * QA: a cargo with only Manage Soundboard had no settings entry in the server
 * header menu, and the audit log never said which clip a row was about.
 */
describe("who reaches the Soundboard tab", () => {
  const none = { canManage: false, canManageMessages: false, canManageSoundboard: false };

  it("shows the settings entry to a cargo that only manages the soundboard", () => {
    expect(showsServerSettingsEntry({ ...none, canManageSoundboard: true })).toBe(true);
  });

  it("still hides it from a plain member and keeps the old doors", () => {
    expect(showsServerSettingsEntry(none)).toBe(false);
    expect(showsServerSettingsEntry({ ...none, canManage: true })).toBe(true);
    expect(showsServerSettingsEntry({ ...none, canManageMessages: true })).toBe(true);
  });

  it("opens the dialog on a section the person can see", () => {
    expect(firstVisibleSection({ soundboard: true })).toBe("soundboard");
    expect(firstVisibleSection({ soundboard: true, audit: true })).toBe("soundboard");
    expect(firstVisibleSection({ automod: true })).toBe("automod");
    expect(firstVisibleSection({ roles: true, soundboard: true })).toBe("roles");
  });
});

describe("soundboard rows in the audit log", () => {
  // The same shape of fake translator the catalogue produces, in English.
  const t = (key: string, vars?: Record<string, unknown>) =>
    `${key}|${Object.entries(vars ?? {})
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(",")}`;
  const details = (entry: Parameters<typeof soundboardAuditDetails>[0]) =>
    soundboardAuditDetails(entry, t as never);

  it("names the clip on create and delete", () => {
    expect(
      details({
        action: "soundboard.create",
        changes: [{ key: "name", old: null, new: "Buzina" }],
      }),
    ).toEqual(["serverSettings.audit.soundboard.clip|name=Buzina"]);
    expect(
      details({
        action: "soundboard.delete",
        changes: [{ key: "name", old: "Buzina", new: null }],
      }),
    ).toEqual(["serverSettings.audit.soundboard.clip|name=Buzina"]);
  });

  it("shows old to new on a rename and a volume change", () => {
    expect(
      details({
        action: "soundboard.update",
        changes: [
          { key: "name", old: "Buzina", new: "Corneta" },
          { key: "volume", old: 1, new: 0.5 },
        ],
      }),
    ).toEqual([
      "serverSettings.audit.soundboard.renamed|old=Buzina,new=Corneta",
      "serverSettings.audit.soundboard.volume|old=100%,new=50%",
    ]);
  });

  it("copes with an edit written before the old value was stored", () => {
    expect(
      details({
        action: "soundboard.update",
        changes: [{ key: "name", old: null, new: "Corneta" }],
      }),
    ).toEqual(["serverSettings.audit.soundboard.clip|name=Corneta"]);
  });

  it("adds nothing to other actions or to an entry with no changes", () => {
    expect(details({ action: "member.kick", changes: null })).toEqual([]);
    expect(details({ action: "soundboard.delete", changes: null })).toEqual([]);
  });
});
