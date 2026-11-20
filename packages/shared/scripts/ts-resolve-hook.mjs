/**
 * Resolver hook that maps TypeScript's `.js` ESM specifiers onto the `.ts`
 * file they name, so the generators can import the shipped sources directly
 * with plain `node` (type stripping) and no build step.
 *
 * The regression value depends on importing the real files: a generator that
 * pastes the schemas into itself tests its own copy, not the product.
 *
 * Exported twice because Node has two hook APIs: `resolve` for the off-thread
 * `module.register()` (every Node that can strip types has it) and
 * `resolveSync` for `module.registerHooks()` (Node 22.15 and later), which
 * `ts-register.mjs` prefers because `register()` is deprecated from Node 26 and
 * prints a warning on every run.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

function tsSibling(specifier, context) {
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    specifier.endsWith(".js") &&
    context.parentURL?.startsWith("file:")
  ) {
    const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return `${specifier.slice(0, -3)}.ts`;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  return next(tsSibling(specifier, context) ?? specifier, context);
}

export function resolveSync(specifier, context, next) {
  return next(tsSibling(specifier, context) ?? specifier, context);
}
