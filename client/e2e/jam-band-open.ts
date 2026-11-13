import type { BrowserContext } from "@playwright/test";

/**
 * The app's song view folds the band's lanes under the stage unless there is
 * room for them (`lib/jam-band-pref.ts`), and a viewport of these specs has
 * none. Most specs are about what is IN the lanes (mute, solo, "Ajustar", the
 * menu, the vote), so they start with the choice a person would have made by
 * pressing "A banda" once: open. The one spec about the fold itself
 * (`jam-band-fold.spec.ts`) does not call this.
 *
 * It answers "open" for a band choice nobody has stored; a stored choice (the
 * toggle's own write) still wins.
 */
export async function bandOpenByDefault(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = function patched(this: Storage, key: string) {
      const stored = get.call(this, key);
      return stored === null && key.startsWith("pqp:jam-band-open:") ? "1" : stored;
    };
  });
}
