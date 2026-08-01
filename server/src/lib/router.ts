import type { IncomingMessage, ServerResponse } from "node:http";
import type { DbUser } from "../db.js";
import { HttpError, isUuid } from "./http.js";

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  user: DbUser;
}

export type RouteHandler = (
  ctx: RequestContext,
  params: Record<string, string>,
) => Promise<unknown>;

interface CompiledRoute {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: RouteHandler;
}

/**
 * Compile `/api/servers/:serverId/members/:userId` into a matcher.
 *
 * Any param whose name ends in `Id` is required to be a UUID. Every id in this
 * schema is a UUID, and letting a malformed one reach Postgres turns a client
 * mistake into a 500.
 */
function compile(path: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const pattern = path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) {
        return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
      keys.push(segment.slice(1));
      return "([^/]+)";
    })
    .join("/");
  return { regex: new RegExp(`^${pattern}$`), keys };
}

export function createRouter() {
  const routes: CompiledRoute[] = [];

  function add(method: string, path: string, handler: RouteHandler) {
    const { regex, keys } = compile(path);
    routes.push({ method, regex, keys, handler });
  }

  return {
    get: (path: string, handler: RouteHandler) => add("GET", path, handler),
    post: (path: string, handler: RouteHandler) => add("POST", path, handler),
    patch: (path: string, handler: RouteHandler) => add("PATCH", path, handler),
    delete: (path: string, handler: RouteHandler) =>
      add("DELETE", path, handler),

    /**
     * Returns the matched handler, or null when nothing matched. A path that
     * matches under a different method yields a 405 so clients can tell a typo
     * from a wrong verb.
     */
    match(
      method: string,
      pathname: string,
    ): { handler: RouteHandler; params: Record<string, string> } | null {
      let pathMatched = false;

      for (const route of routes) {
        const match = route.regex.exec(pathname);
        if (!match) {
          continue;
        }
        pathMatched = true;
        if (route.method !== method) {
          continue;
        }

        const params: Record<string, string> = {};
        route.keys.forEach((key, index) => {
          const raw = match[index + 1] ?? "";
          let value: string;
          try {
            value = decodeURIComponent(raw);
          } catch {
            // A truncated escape like `/api/invites/100%` — a client error, not ours.
            throw new HttpError(400, "Invalid path");
          }
          if (key.endsWith("Id") && !isUuid(value)) {
            throw new HttpError(404, "Not found");
          }
          params[key] = value;
        });
        return { handler: route.handler, params };
      }

      if (pathMatched) {
        throw new HttpError(405, "Method not allowed");
      }
      return null;
    },
  };
}
