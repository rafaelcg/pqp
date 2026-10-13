import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  FORUM_TAG_ICONS,
  FORUM_TAG_PRESET_NAMES,
  FORUM_TAG_PRESETS,
  forumTagNameKey,
} from "@pqp/shared";
import { ForumTagIcon } from "@/components/forum/forum-tag-icon";
import en from "@/locales/en/translation.json";
import es from "@/locales/es/translation.json";
import ptBR from "@/locales/pt-BR/translation.json";
import { loadLocale, setActiveCatalogue, translateMessage } from "@/lib/i18n";
import {
  FORUM_TAG_ICON_COMPONENTS,
  FORUM_TAG_ICON_LABELS,
  FORUM_TAG_PRESET_KEYS,
  forumTagLabel,
} from "./forum-tag-icons";

const CATALOGUES = { en, "pt-BR": ptBR, es } as Record<string, Record<string, string>>;

afterEach(() => {
  setActiveCatalogue(undefined);
});

describe("forum tag icons", () => {
  it("draws every key the shared set names, with a label in each language", () => {
    for (const { key } of FORUM_TAG_ICONS) {
      expect(FORUM_TAG_ICON_COMPONENTS[key], key).toBeTruthy();
      const labelKey = FORUM_TAG_ICON_LABELS[key];
      for (const [locale, catalogue] of Object.entries(CATALOGUES)) {
        expect(catalogue[labelKey], `${locale} ${labelKey}`).toBeTruthy();
      }
    }
  });

  it("uses one drawing per key, so two icons never look the same", () => {
    const drawings = new Set(Object.values(FORUM_TAG_ICON_COMPONENTS));
    expect(drawings.size).toBe(FORUM_TAG_ICONS.length);
  });

  it("draws the icon when there is one, the emoji when there is only that, else nothing", () => {
    const icon = renderToStaticMarkup(<ForumTagIcon tag={{ icon: "bug", emoji: "🐛" }} />);
    expect(icon).toContain("<svg");
    expect(icon).toContain('data-forum-tag-icon="bug"');
    expect(icon).toContain('aria-hidden="true"');
    expect(icon).not.toContain("🐛");
    const legacy = renderToStaticMarkup(<ForumTagIcon tag={{ icon: null, emoji: "🍲" }} />);
    expect(legacy).toContain("🍲");
    expect(legacy).not.toContain("<svg");
    expect(renderToStaticMarkup(<ForumTagIcon tag={{ icon: null, emoji: null }} />)).toBe("");
    // A key this build has never heard of is the emoji's problem, not a crash.
    const unknown = renderToStaticMarkup(
      <ForumTagIcon tag={{ icon: "hologram" as never, emoji: "💠" }} />,
    );
    expect(unknown).toContain("💠");
  });
});

describe("forum tag presets", () => {
  it("every preset is named in each language, and the server knows each of those names", () => {
    // The server matches a webhook's `applied_tags` against
    // `FORUM_TAG_PRESET_NAMES`; the screens show the catalogue's word. If the
    // two drift, a feed that names what the reader sees stops matching.
    for (const preset of FORUM_TAG_PRESETS) {
      const key = FORUM_TAG_PRESET_KEYS[preset];
      const known = FORUM_TAG_PRESET_NAMES[preset].map(forumTagNameKey);
      for (const [locale, catalogue] of Object.entries(CATALOGUES)) {
        const word = catalogue[key];
        expect(word, `${locale} ${key}`).toBeTruthy();
        expect(known, `${locale} "${word}" for ${preset}`).toContain(forumTagNameKey(word!));
      }
    }
  });

  it("a starter tag reads in the viewer's language; a renamed one keeps its own name", async () => {
    const stored = { name: "Question", preset: "question" as const };
    const t = (key: Parameters<typeof translateMessage>[0]) => translateMessage(key);
    expect(forumTagLabel(stored, t)).toBe("Question");
    await loadLocale("pt-BR");
    expect(forumTagLabel(stored, t)).toBe("Dúvida");
    await loadLocale("es");
    expect(forumTagLabel(stored, t)).toBe("Duda");
    expect(forumTagLabel({ name: "Pergunte", preset: null }, t)).toBe("Pergunte");
    // An unknown preset from a newer server falls back to the stored name.
    expect(forumTagLabel({ name: "Nova", preset: "inventado" as never }, t)).toBe("Nova");
  });
});
