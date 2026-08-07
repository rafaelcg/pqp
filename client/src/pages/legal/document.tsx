/**
 * Legal pages as documents, one file per language.
 *
 * WHY NOT CATALOGUE KEYS
 *
 * Everything else the app says goes through `lib/i18n/catalogue.ts`, and for UI
 * labels that is right. These three pages are not labels. Terms, Privacy and
 * Cookies are ~15,000 words of connected prose where sentences qualify each
 * other and a clause only means what it means next to the one above it. Cutting
 * that into three hundred `terms.reporting.p4` keys costs three things this
 * project cannot afford:
 *
 *  1. The English becomes unreadable at the point where it has to be *written*.
 *     A legal document is edited as a document; nobody proofreads a policy in
 *     key order.
 *  2. The pt-BR catalogue is a single chunk fetched by every Portuguese
 *     visitor, including everyone who only ever opens `/app`. Putting the
 *     legal prose in it would make every chat user download all three policies.
 *  3. A translator gets fragments with no adjacent text — the reliable way to
 *     produce a paragraph that is individually correct and collectively wrong.
 *
 * So each page is two documents that share a *structure*: the same ordered list
 * of section ids, headings and bodies. English is the source; pt-BR is a
 * translation of it.
 *
 * HOW DRIFT IS CAUGHT
 *
 * Duplicated structure drifts unless something notices. `documents.test.ts`
 * does three things on every CI run:
 *
 *  - the two languages must declare the same section ids, in the same order;
 *  - `updated` and `path` must match;
 *  - every translated section carries `sourceRev` — a fingerprint of the
 *    *English* section it was written against. Change an English sentence and
 *    its fingerprint changes, the test fails naming that section, and the only
 *    way to green is to revisit the Portuguese and stamp the new value.
 *
 * That last one is the important one: it fires without anyone remembering to
 * flag the change, which is exactly the failure mode ("English moved, nobody
 * told the translator") that makes bilingual policies lie.
 */

import { Fragment, lazy, type ReactNode } from "react";
import { LegalPage } from "@/components/marketing/legal-page";
import { useTranslation } from "@/lib/i18n";
import { setLocalePreference, type Locale } from "@/lib/locale";

export interface LegalSection {
  /** Stable across languages. The join key the drift test uses — never translate it. */
  id: string;
  /** Rendered as an `<h2>`. Omitted for the opening paragraphs. */
  heading?: string;
  body: ReactNode;
  /**
   * Translations only: the fingerprint of the English section this text was
   * written against, produced by `sectionFingerprint` in `source-rev.ts`. The
   * test prints the value to use when it does not match.
   */
  sourceRev?: string;
}

export interface LegalDocument {
  locale: Locale;
  /** Route path. Identical across languages — the language comes from `?lang=`. */
  path: string;
  /** `<title>` and meta description, both translated. */
  title: string;
  description: string;
  heading: string;
  updated: string;
  sections: LegalSection[];
}

/**
 * The other language, offered on the page itself.
 *
 * A Brazilian reader on a browser configured in English lands on the English
 * policy, and "consent" to a document you cannot read is not consent. The link
 * is a plain `<a>` on purpose: `?lang=` is read by `detectLocale()` during
 * boot, so a full navigation is what switches the language, and the click also
 * persists the choice so the next page stays put.
 */
const OTHER_LANGUAGE: Record<Locale, { locale: Locale; label: string }> = {
  en: { locale: "pt-BR", label: "Ler em português" },
  "pt-BR": { locale: "en", label: "Read this in English" },
};

function LanguageSwitch({ doc }: { doc: LegalDocument }) {
  const other = OTHER_LANGUAGE[doc.locale];
  return (
    <p className="text-sm">
      <a
        href={`${doc.path}?lang=${other.locale}`}
        lang={other.locale}
        onClick={() => setLocalePreference(other.locale)}
      >
        {other.label}
      </a>
    </p>
  );
}

/**
 * Sections render flat — `<h2>` then body, no wrapper element. The prose
 * spacing in `.legal-prose` is sibling-based (`space-y-6` plus a heading
 * margin), so a wrapper per section would quietly change every gap on the page.
 */
export function LegalDocumentView({ doc }: { doc: LegalDocument }) {
  return (
    <LegalPage
      title={doc.title}
      description={doc.description}
      path={doc.path}
      heading={doc.heading}
      updated={doc.updated}
    >
      <LanguageSwitch doc={doc} />
      {doc.sections.map((section) => (
        <Fragment key={section.id}>
          {section.heading ? <h2>{section.heading}</h2> : null}
          {section.body}
        </Fragment>
      ))}
    </LegalPage>
  );
}

type Loaders = Record<Locale, () => Promise<LegalDocument>>;

function lazyView(load: () => Promise<LegalDocument>) {
  return lazy(async () => {
    const doc = await load();
    return { default: () => <LegalDocumentView doc={doc} /> };
  });
}

/**
 * A route that fetches only the language on screen.
 *
 * Both documents are `lazy()` behind their own dynamic import, so an English
 * visitor never downloads Portuguese and vice versa. The locale is known
 * synchronously (`detectLocale` runs before first paint), so unlike the string
 * catalogue there is no English flash to close.
 */
export function createLegalRoute(loaders: Loaders) {
  const views: Record<Locale, ReturnType<typeof lazyView>> = {
    en: lazyView(loaders.en),
    "pt-BR": lazyView(loaders["pt-BR"]),
  };
  return function LegalRoute() {
    const { locale } = useTranslation();
    const View = views[locale] ?? views.en;
    return <View />;
  };
}
