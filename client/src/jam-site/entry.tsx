import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { loadJamLocale } from "@/lib/i18n/jam-site";
import { applyDocumentLocale, detectLocale } from "@/lib/locale";
import "../fonts.css";
import "../index.css";
import "./jam-site.css";
import { rememberArrival } from "./attribution";
import { JamSite } from "./site";

/**
 * The public jam site's entry, a page of its own (`client/jam-site/index.html`).
 *
 * It is NOT `main.tsx`: no Clerk, no router, no app shell, no socket, no
 * service worker registration, no analytics tag. A visitor with no account gets
 * React, the site, and (when they press play) the jam engine. The app is a link
 * away, on the main site.
 */

document.documentElement.dataset.jamSite = "";
// The address the person arrived on may carry `ref` / `utm_*` (a clip's link);
// the site moves with pushState and the sign-up buttons are pages away.
rememberArrival();

const locale = detectLocale();
void loadJamLocale(locale)
  .catch(() => undefined)
  .then(() => {
    applyDocumentLocale(locale);
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <JamSite />
      </StrictMode>,
    );
  });
