import { describe, expect, it } from "vitest";
import enApp from "../locales/en/translation.json";
import esApp from "../locales/es/translation.json";
import ptApp from "../locales/pt-BR/translation.json";
import enSite from "../locales/jam-site/en.json";
import esSite from "../locales/jam-site/es.json";
import ptSite from "../locales/jam-site/pt-BR.json";
import { jamPendingOf, jamShareKind, jamShareText, jamStillNeeds, type JamShareKind, type JamShareWords } from "./jam-share-text";

type Catalogue = Record<string, string>;

/** The two catalogues the same sentences live in: the app's (`jam.invite.text.*`) and the site's (`share.msg.*`). */
const CATALOGUES: Record<string, { cat: Catalogue; prefix: string; names: Record<string, string>; locale: string }> = {
  "app en": { cat: enApp, prefix: "jam.invite.text.", names: { bass: "bass", vocals: "vocals", drums: "drums" }, locale: "en" },
  "app pt-BR": { cat: ptApp, prefix: "jam.invite.text.", names: { bass: "baixo", vocals: "voz", drums: "bateria" }, locale: "pt-BR" },
  "app es": { cat: esApp, prefix: "jam.invite.text.", names: { bass: "bajo", vocals: "voz", drums: "batería" }, locale: "es" },
  "site en": { cat: enSite, prefix: "share.msg.", names: { bass: "bass", vocals: "vocals", drums: "drums" }, locale: "en" },
  "site pt-BR": { cat: ptSite, prefix: "share.msg.", names: { bass: "baixo", vocals: "voz", drums: "bateria" }, locale: "pt-BR" },
  "site es": { cat: esSite, prefix: "share.msg.", names: { bass: "bajo", vocals: "voz", drums: "batería" }, locale: "es" },
};

/** The two sentences' plural families, resolved the way i18next does for these locales (one / other). */
function wordsFor(name: string): JamShareWords {
  const { cat, prefix, names, locale } = CATALOGUES[name]!;
  return {
    say: (kind, vars) => {
      // The sender's own message, when a part of theirs waits for the starter, lives beside the plain one (app only).
      const base = vars.pending ? prefix.replace("text.", "textSent.") : prefix;
      const key = kind === "needs" ? `${base}needs_${vars.count === 1 ? "one" : "other"}` : `${base}${kind}`;
      const sentence = cat[key];
      if (sentence === undefined) throw new Error(`missing ${key}`);
      return sentence.replace("{title}", vars.title).replace("{list}", vars.list).replace("{mine}", vars.mine);
    },
    name: (instrument) => names[instrument]!,
    list: (list) => new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(list),
  };
}

const song = (over: Partial<{ joinMode: "open" | "wanted" | "closed"; needs: string[]; pending: string[] }> = {}) => ({
  title: "Maré baixa",
  joinMode: "wanted" as const,
  needs: ["bass"],
  ...over,
});

describe("jamShareKind", () => {
  it("asks for what is missing when the song wants parts", () => {
    expect(jamShareKind({ joinMode: "wanted", needs: ["bass"] })).toBe("needs");
    expect(jamShareKind({ joinMode: "open", needs: ["bass"] })).toBe("needs");
  });
  it("an open song with nothing named welcomes any part", () => {
    expect(jamShareKind({ joinMode: "open", needs: [] })).toBe("open");
  });
  it("a complete or closed song invites listening", () => {
    expect(jamShareKind({ joinMode: "wanted", needs: [] })).toBe("listen");
    expect(jamShareKind({ joinMode: "closed", needs: [] })).toBe("listen");
    // closed wins even if a stale list says something is missing
    expect(jamShareKind({ joinMode: "closed", needs: ["bass"] })).toBe("listen");
  });
});

describe("jamShareText", () => {
  it("pt-BR asks for the missing part in the singular and the plural", () => {
    const words = wordsFor("app pt-BR");
    expect(jamShareText(song(), words)).toBe("Maré baixa: falta baixo nessa. Grava a tua parte:");
    expect(jamShareText(song({ needs: ["bass", "vocals"] }), words)).toBe(
      "Maré baixa: faltam baixo e voz nessa. Grava a tua parte:",
    );
    expect(jamShareText(song({ needs: ["bass", "vocals", "drums"] }), words)).toBe(
      "Maré baixa: faltam baixo, voz e bateria nessa. Grava a tua parte:",
    );
  });

  it("English and Spanish ask the same thing", () => {
    expect(jamShareText(song(), wordsFor("app en"))).toBe("Maré baixa: it needs bass. Record your part:");
    expect(jamShareText(song({ needs: ["bass", "vocals"] }), wordsFor("app en"))).toBe(
      "Maré baixa: it needs bass and vocals. Record your part:",
    );
    expect(jamShareText(song(), wordsFor("app es"))).toBe("Maré baixa: falta bajo. Graba tu parte:");
    expect(jamShareText(song({ needs: ["bass", "vocals"] }), wordsFor("app es"))).toBe(
      "Maré baixa: faltan bajo y voz. Graba tu parte:",
    );
  });

  it("a complete song invites listening, an open one a part", () => {
    expect(jamShareText(song({ needs: [] }), wordsFor("app pt-BR"))).toBe("Maré baixa: dá uma ouvida nessa jam:");
    expect(jamShareText(song({ joinMode: "closed", needs: [] }), wordsFor("app en"))).toBe(
      "Maré baixa: give this jam a listen:",
    );
    expect(jamShareText(song({ joinMode: "open", needs: [] }), wordsFor("app pt-BR"))).toBe(
      "Maré baixa: jam aberta pra quem quiser. Entra e grava a tua parte:",
    );
  });

  it("the site's catalogue says the same as the app's, in every language", () => {
    for (const lang of ["en", "pt-BR", "es"]) {
      for (const input of [song(), song({ needs: ["bass", "vocals"] }), song({ needs: [] }), song({ joinMode: "open", needs: [] })]) {
        expect(jamShareText(input, wordsFor(`site ${lang}`)), lang).toBe(jamShareText(input, wordsFor(`app ${lang}`)));
      }
    }
  });
});

describe("the share copy", () => {
  const kinds: JamShareKind[] = ["needs", "open", "listen"];

  it("never uses an em dash, never signs the message, never says voce in pt-BR", () => {
    for (const name of Object.keys(CATALOGUES)) {
      const { cat, prefix } = CATALOGUES[name]!;
      const keys = Object.keys(cat).filter((key) => key.startsWith(prefix));
      expect(keys.length, name).toBeGreaterThanOrEqual(4);
      for (const key of keys) {
        const text = cat[key]!;
        expect(text, key).not.toMatch(/[—–]/);
        expect(text, key).not.toMatch(/made with|feito com|hecho con|\bAI\b|\bIA\b|claude/i);
        if (name.includes("pt-BR")) expect(text, key).not.toMatch(/\b(voc[eê]s?|seu|seus|sua|suas)\b/i);
      }
    }
  });

  it("every kind has a sentence in every catalogue", () => {
    for (const name of Object.keys(CATALOGUES)) {
      const words = wordsFor(name);
      for (const kind of kinds) {
        const needs = kind === "needs" ? ["bass"] : [];
        const joinMode = kind === "open" ? "open" : kind === "listen" ? "closed" : "wanted";
        expect(jamShareText({ title: "T", joinMode, needs }, words), `${name} ${kind}`).toContain("T");
      }
    }
  });
});

describe("a message from somebody whose part waits for the starter (round 3, N-2)", () => {
  const sent = (over: Partial<{ joinMode: "open" | "wanted" | "closed"; needs: string[]; pending: string[] }> = {}) =>
    song({ pending: ["drums"], needs: ["vocals"], ...over });

  it("says the part waits, and asks only for what is still missing", () => {
    expect(jamShareText(sent(), wordsFor("app pt-BR"))).toBe(
      "Maré baixa: mandei a minha parte de bateria, ela entra quando quem começou aceitar. Ainda falta voz. Grava a tua parte:",
    );
    expect(jamShareText(sent({ needs: ["vocals", "bass"] }), wordsFor("app pt-BR"))).toContain("Ainda faltam voz e baixo.");
    expect(jamShareText(sent(), wordsFor("app en"))).toBe(
      "Maré baixa: I sent my drums part, it joins once whoever started the jam accepts it. It still needs vocals. Record yours:",
    );
    expect(jamShareText(sent(), wordsFor("app es"))).toBe(
      "Maré baixa: mandé mi parte de batería, entra cuando quien empezó la jam la acepte. Todavía falta voz. Graba la tuya:",
    );
  });

  it("with nothing else missing it invites listening, and an open jam still welcomes a part", () => {
    expect(jamShareText(sent({ needs: [] }), wordsFor("app pt-BR"))).toContain("Dá uma ouvida nessa jam:");
    expect(jamShareText(sent({ joinMode: "open", needs: [] }), wordsFor("app pt-BR"))).toContain("Jam aberta pra quem quiser");
  });

  it("is the plain message when nothing of theirs waits", () => {
    expect(jamShareText(song({ pending: [] }), wordsFor("app pt-BR"))).toBe(jamShareText(song(), wordsFor("app pt-BR")));
  });

  it("every language has all four sentences, with no em dash and no voce", () => {
    for (const [name, { cat, locale }] of Object.entries(CATALOGUES)) {
      if (!name.startsWith("app")) continue;
      for (const key of ["needs_one", "needs_other", "open", "listen"]) {
        const text = cat[`jam.invite.textSent.${key}`];
        expect(text, `${name} ${key}`).toBeTruthy();
        expect(text, key).toContain("{mine}");
        expect(text, key).not.toMatch(/[—–]/);
        if (locale === "pt-BR") expect(text, key).not.toMatch(/\b(voc[eê]s?|seu|seus|sua|suas)\b/i);
      }
    }
  });
});

describe("jamPendingOf: one rule for a public view and a channel's own song (Farol, PR 1778)", () => {
  const tracks = [
    { authorId: "me", inMix: false, instrument: "drums" },
    { authorId: "me", inMix: true, instrument: "bass" },
    { authorId: "other", inMix: false, instrument: "vocals" },
    { authorId: "me", inMix: false, instrument: "drums" },
  ];
  it("is what I recorded that is not in the mix, once per instrument, nothing of anybody else's", () => {
    expect(jamPendingOf(tracks, "me", false)).toEqual(["drums"]);
  });
  it("is empty for the starter (their out-of-mix takes are their own choice) and for nobody signed in", () => {
    expect(jamPendingOf(tracks, "me", true)).toEqual([]);
    expect(jamPendingOf(tracks, null, false)).toEqual([]);
  });
  it("changes nothing for a channel song's second take of an instrument already in the band", () => {
    // my drums wait, but drums are in the band already: the share asks for what is still missing either way
    const song = { joinMode: "wanted" as const, wantedInstruments: ["drums", "vocals"], instruments: ["drums"] };
    expect(jamStillNeeds(song, jamPendingOf(tracks, "me", false))).toEqual(["vocals"]);
    expect(jamStillNeeds(song, [])).toEqual(["vocals"]);
  });
});

describe("jamStillNeeds", () => {
  const wanted = { joinMode: "wanted" as const, wantedInstruments: ["bass", "drums", "vocals"], instruments: ["vocals"] };

  it("is what the song asks for that is not in it yet", () => {
    expect(jamStillNeeds(wanted)).toEqual(["bass", "drums"]);
  });
  it("leaves out the part the person sent that waits: they cannot ask their friends for it", () => {
    expect(jamStillNeeds(wanted, ["drums"])).toEqual(["bass"]);
  });
  it("is empty for an open or a closed song", () => {
    expect(jamStillNeeds({ ...wanted, joinMode: "open" })).toEqual([]);
    expect(jamStillNeeds({ ...wanted, joinMode: "closed" })).toEqual([]);
  });
  it("is the server's rule: the public site's `needs` is the same list for a reader with nothing waiting", () => {
    // The server fills `needs` as `wanted_instruments` minus the instruments present in the mix.
    expect(jamStillNeeds({ joinMode: "wanted", wantedInstruments: ["drums", "vocals"], instruments: [] })).toEqual(["drums", "vocals"]);
  });
});
