import type { JamAttribution } from "@/lib/jam-intent";

/** What a link the site hands out says it came from, when its page was opened with no `ref`. */
export const JAM_SHARE_REF = "share";

/**
 * The address a share (the Web Share sheet, a copied link) hands out for a
 * path of the site. It carries `ref=share`, so a sign-up that comes out of a
 * shared link shows up in the acquisition report as its own row, unless the
 * page the person is on was opened with a `ref` already: that one is who brought
 * them here (a clip, a post), and it stays. Nothing else is added: not the
 * `utm_*` of the arrival, which belong to the sharer's visit and not their
 * friend's.
 */
export function jamShareHref(path: string, origin: string, attribution: JamAttribution | null): string {
  const url = new URL(path, origin);
  url.searchParams.set("ref", attribution?.ref ?? JAM_SHARE_REF);
  return url.toString();
}
