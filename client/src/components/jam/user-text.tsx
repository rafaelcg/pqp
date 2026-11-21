import { bidiClean } from "@/lib/bidi";

/**
 * A person's text (a title, an artist, a name, a label) inline beside the app's
 * own words. A `<bdi>` is an isolate: it lays its content out on its own, whatever
 * direction that is, and leaves its neighbours alone, so a right-to-left override
 * or an Arabic name cannot reorder "started by" next to it. `lib/bidi.ts` says why.
 */
export function UserText({ children }: { children: string }) {
  return <bdi>{bidiClean(children)}</bdi>;
}
