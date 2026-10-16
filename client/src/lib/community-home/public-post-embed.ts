import {
  publicBauPostResponseSchema,
  type PublicBauPostResponse,
} from "@pqp/shared";
import { BAU_POST_EMBED_ID } from "@/lib/bau-post-meta";

/**
 * The public post's answer, read from the HTML the edge served instead of asked
 * of the API again (`renderBauPostEmbed` in `bau-post-meta.ts` says why).
 *
 * TAKEN, NOT PEEKED: the block is removed as it is read. It describes the page
 * as it was when the edge built it; a later navigation, a retry, or a reload
 * after the edge's copy went stale must go to the network, and a block left in
 * the document would answer all of them with the first answer.
 *
 * TRUSTED FOR NOTHING. It is parsed with the shared schema and has to name the
 * same post and community the address does; anything else (a block for another
 * post, a malformed one, one an extension or a cache mangled) is ignored, and
 * the page asks the API like it always did.
 */
export function takePublicPostEmbed(
  doc: Pick<Document, "getElementById">,
  slug: string,
  postId: string,
): PublicBauPostResponse | null {
  const node = doc.getElementById(BAU_POST_EMBED_ID);
  if (!node) {
    return null;
  }
  const raw = node.textContent;
  node.remove();
  if (!raw) {
    return null;
  }
  try {
    const parsed = publicBauPostResponseSchema.safeParse(JSON.parse(raw));
    if (
      !parsed.success ||
      parsed.data.post.id !== postId ||
      parsed.data.community.slug !== slug
    ) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}
