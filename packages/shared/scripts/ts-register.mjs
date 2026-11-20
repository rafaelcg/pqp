// Lets a plain `node --import ./scripts/ts-register.mjs ...` import the shipped
// TypeScript sources of `@pqp/shared` (Node strips the types itself, and the
// hook maps `./x.js` specifiers onto `./x.ts`). See `ts-resolve-hook.mjs`.
import * as nodeModule from "node:module";
import { resolveSync } from "./ts-resolve-hook.mjs";

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({ resolve: resolveSync });
} else {
  nodeModule.register("./ts-resolve-hook.mjs", import.meta.url);
}
