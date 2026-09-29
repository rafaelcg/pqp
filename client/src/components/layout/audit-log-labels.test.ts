import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS } from "@pqp/shared";
import en from "@/locales/en/translation.json";
import ptBR from "@/locales/pt-BR/translation.json";
import es from "@/locales/es/translation.json";
import { auditReasonKey } from "./server-settings-dialog";

const catalogues = { en, "pt-BR": ptBR, es } as Record<
  string,
  Record<string, string>
>;

describe("audit log copy", () => {
  it.each(Object.keys(catalogues))(
    "%s has a label for every action the server can write",
    (locale) => {
      const missing = AUDIT_ACTIONS.filter(
        (action) => !catalogues[locale][`serverSettings.audit.action.${action}`],
      );
      expect(missing).toEqual([]);
    },
  );

  it("names the AutoMod rule instead of showing its raw kind", () => {
    expect(auditReasonKey({ action: "automod.block", reason: "keywords" })).toBe(
      "automod.keywords.title",
    );
    expect(
      auditReasonKey({ action: "automod.block", reason: "invite_links" }),
    ).toBe("automod.inviteLinks.title");
    expect(
      auditReasonKey({ action: "automod.block", reason: "mention_spam" }),
    ).toBe("automod.mentionSpam.title");
  });

  it("leaves typed reasons and unknown kinds alone", () => {
    expect(auditReasonKey({ action: "member.timeout", reason: "keywords" })).toBe(
      null,
    );
    expect(auditReasonKey({ action: "automod.block", reason: "new_kind" })).toBe(
      null,
    );
    expect(auditReasonKey({ action: "automod.block", reason: null })).toBe(null);
  });
});
