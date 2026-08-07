import { createLegalRoute } from "./legal/document";

/**
 * The Terms, in whichever language the visitor is reading the site in. The
 * prose lives in `legal/terms.en.tsx` and `legal/terms.pt-BR.tsx`; only the one
 * on screen is downloaded.
 */
export const TermsPage = createLegalRoute({
  en: () => import("./legal/terms.en").then((m) => m.termsEn),
  "pt-BR": () => import("./legal/terms.pt-BR").then((m) => m.termsPtBr),
});
