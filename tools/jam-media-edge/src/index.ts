/**
 * pqp-jam-media-edge entry point. A Worker's entry module may export nothing
 * but its handler (workerd refuses any other export), so everything else, and
 * the long description of what this Worker does, lives in `handler.ts`.
 */

import { failure, handleRequest, type Env } from "./handler.js";
import { logEvent } from "./log.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx, caches.default);
    } catch (error) {
      logEvent("jamMedia.unhandled", { message: error instanceof Error ? error.message : String(error) });
      return failure(500, "internal-error");
    }
  },
} satisfies ExportedHandler<Env>;
