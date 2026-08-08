/**
 * Which credential each persona posts with.
 *
 * Two modes, and the whole point of this file is that the rest of the runner
 * cannot tell them apart — it asks for a bearer token by persona id and gets a
 * string.
 *
 *   character  a server-minted character account. `Bearer character:<secret>`,
 *              verified against a hash in `character_accounts`. The production
 *              identity, and the only one that works on a deploy.
 *   dev        `DEV_AUTH_BYPASS`, which mints an account per token suffix. Local
 *              only — the server refuses the bypass under NODE_ENV=production,
 *              which is exactly the wall the character accounts were built to
 *              get past.
 *
 * The mode is chosen by whether a secrets file is present, not by a flag,
 * because the failure that matters is running in production having *forgotten*
 * to mount the secrets: a flag would let that fall back to dev tokens and fail
 * far away with a 401 nobody attributes to this. A missing file when one was
 * asked for is an immediate, named error.
 */
import { readFileSync } from "node:fs";

/**
 * The shape on disk: `{ "<persona id>": "<token>" }`, written by
 * `scripts/provision.mjs`. Deliberately not YAML and not .env — it is machine
 * written and machine read, it holds nothing but secrets, and JSON has no
 * comment syntax for somebody to paste a token into by accident.
 */
export function loadTokensFile(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read character tokens from ${path}: ${error.message}. ` +
        `Provision them with: node scripts/provision.mjs --config personas.yaml`,
    );
  }
  const tokens = parsed?.characters ?? parsed;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    throw new Error(
      `${path}: expected an object of { "<persona id>": "<token>" }`,
    );
  }
  return tokens;
}

/**
 * A `tokenFor(personaId)` function, plus the mode it is running in.
 *
 * `personaIds` is checked up front rather than lazily: a persona missing from
 * the secrets file would otherwise fail at 22:00, mid-scene, as a 401 on one
 * socket — which reads as a network blip and leaves a cast with a hole in it.
 * Refusing at boot is the same trade `config.js` makes.
 */
export function resolveIdentity({ tokensFile, devToken, personaIds }) {
  if (tokensFile) {
    const tokens = loadTokensFile(tokensFile);
    const missing = personaIds.filter((id) => !tokens[id]);
    if (missing.length > 0) {
      throw new Error(
        `${tokensFile} has no token for: ${missing.join(", ")}. ` +
          `Run scripts/provision.mjs to mint the missing accounts.`,
      );
    }
    return {
      mode: "character",
      tokenFor: (id) => `character:${tokens[id]}`,
    };
  }

  return {
    mode: "dev",
    tokenFor: (id) => `${devToken}:${devSuffix(id)}`,
  };
}

/**
 * The dev bypass's suffix alphabet is fixed by the server
 * (`/^[a-z0-9_-]{1,32}$/` in auth/clerk.ts) and a near miss is a rejected
 * token, not a surprise account — so fold the persona id into it here rather
 * than hoping every id in every YAML file already complies.
 */
export function devSuffix(id) {
  return String(id)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 32);
}
