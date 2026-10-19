import { lazy, useState } from "react";
import { Seo } from "@/components/marketing/seo";
import { useTranslation } from "@/lib/i18n";
import { loadedHome, loadHome } from "./load";

/**
 * The route element for "/". Eager and small on purpose: the page itself is a
 * lazy chunk (see `load.ts`), and this file may import nothing from it.
 *
 * The page renders no Seo of its own, so the route does, as the old landing
 * did. Without it, a client-side navigation to "/" would keep the previous
 * page's title and description.
 */
const LazyHome = lazy(loadHome);

export function HomeRoute() {
  const { t } = useTranslation();
  // Chosen once, on first mount. The boot normally has the module by now, and
  // rendering it directly avoids the suspend that `lazy` does on its first
  // render. Choosing on every render would swap `LazyHome` for the module the
  // moment it arrived (a logo click before the prefetch landed), and a new
  // component type would unmount the page and mount it again.
  const [Home] = useState(() => loadedHome()?.default ?? LazyHome);
  return (
    <>
      <Seo
        title={t("landing.seo.title")}
        description={t("landing.seo.description")}
        path="/"
      />
      <Home />
    </>
  );
}
