/**
 * Resolver hook that maps TypeScript's `.js` ESM specifiers onto the `.ts`
 * file they name, so the harness can import the shipped sources directly with
 * `node --experimental-strip-types` and no build step.
 *
 * The regression value depends on importing the real files: a harness that
 * pastes the schemas into itself tests its own copy, not the product.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, next) {
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    specifier.endsWith(".js") &&
    context.parentURL?.startsWith("file:")
  ) {
    const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(candidate))) {
      return next(`${specifier.slice(0, -3)}.ts`, context);
    }
  }
  return next(specifier, context);
}
