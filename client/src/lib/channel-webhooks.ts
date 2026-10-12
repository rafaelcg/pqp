/**
 * Which channels show the Webhooks section in their settings: the two the API
 * lets a webhook be created on (`POST /api/channels/:id/webhooks`). A text
 * channel shows each delivery as a message; a forum turns each one into a
 * post (forum PR 4), which is what an RSS feed into a forum is for. Never a
 * category, a voice room or a thread, which the API refuses too.
 */
export function channelTakesWebhooks(type: string | null | undefined): boolean {
  return type === "text" || type === "forum";
}
