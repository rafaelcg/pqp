#!/usr/bin/env node
/**
 * Mint character accounts for every persona in a community file.
 *
 *   DATABASE_URL=… node scripts/provision.mjs --config personas.yaml
 *   DATABASE_URL=… node scripts/provision.mjs --list
 *   DATABASE_URL=… node scripts/provision.mjs --rotate kzin
 *   DATABASE_URL=… node scripts/provision.mjs --revoke kzin
 *
 * WHY DIRECT DATABASE ACCESS AND NOT AN API ROUTE. The alternative was an
 * operator-token endpoint, and it is worse on every axis that matters here. It
 * would put a *second* long-lived credential in the server — one that can mint
 * the first — and that credential would have to live in the API's environment,
 * where it is reachable by any request-handling bug for the rest of the
 * deployment's life. Provisioning happens a handful of times ever, by somebody
 * who already holds `DATABASE_URL`, so the route would add a permanent attack
 * surface to avoid a one-off `fly ssh console`. The design doc frames the other
 * DB-access operation (backfill) the same way: a real operation, reviewed as
 * one, not a mode of the runner.
 *
 * IT REUSES THE SERVER'S OWN CODE. This script does not write SQL. It imports
 * `server/dist/services/characters.js`, so the token hashing, the age-gate
 * columns, the `dm_privacy` default, the handle derivation and the transaction
 * boundary have exactly one implementation — the one that is under test in
 * `server/src/services/characters.test.ts`. A second copy in JS here would
 * drift, and the direction it would drift is "the guardrails the server thinks
 * it wrote are missing on the accounts that actually exist".
 */
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { loadCommunities } from "../src/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const REPO = join(ROOT, "..", "..");

function valueOf(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

const argv = process.argv.slice(2);
const args = {
  config: valueOf(argv, "--config") ?? join(ROOT, "personas.yaml"),
  out:
    valueOf(argv, "--out") ??
    process.env.AMBIENT_TOKENS_FILE ??
    join(ROOT, "secrets", "characters.json"),
  /**
   * Mint only these persona ids, comma-separated. Exists so provisioning can be
   * done in batches — a first pass to prove the pipeline against a handful of
   * accounts, then the rest — without editing the community file to get there.
   */
  only: (valueOf(argv, "--only") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
  rotate: valueOf(argv, "--rotate") ?? null,
  revoke: valueOf(argv, "--revoke") ?? null,
  list: argv.includes("--list"),
  dryRun: argv.includes("--dry-run"),
  avatarBase:
    process.env.AMBIENT_AVATAR_BASE ??
    "https://api.dicebear.com/9.x/thumbs/png?seed=",
};

if (!process.env.DATABASE_URL) {
  fail(
    "DATABASE_URL is required. This script talks to Postgres directly — there is\n" +
      "deliberately no API route that mints a credential of this class.",
  );
}

/**
 * The server's own character service, compiled.
 *
 * Imported by path rather than by package name because `tools/ambient` is
 * outside the pnpm workspace on purpose (see the README), so there is no
 * `@pqp/server` to resolve. A missing build is the single most likely thing to
 * go wrong on a first run, so say what to type.
 */
const characters = await import(
  join(REPO, "server", "dist", "services", "characters.js")
).catch((error) => {
  fail(
    `Could not load the server's character service (${error.message}).\n` +
      `Build it first:  pnpm --filter @pqp/shared build && pnpm --filter @pqp/server build`,
  );
});

const db = await import(join(REPO, "server", "dist", "db.js"));

try {
  if (args.list) {
    await list();
  } else if (args.revoke) {
    await revoke(args.revoke);
  } else {
    await provision();
  }
} finally {
  await db.closePool();
}

// ---------------------------------------------------------------- operations

async function list() {
  const accounts = await characters.listCharacterAccounts();
  if (accounts.length === 0) {
    console.log("No character accounts exist yet.");
    return;
  }
  console.log(`${accounts.length} character account(s):\n`);
  for (const account of accounts) {
    const state = account.revoked_at
      ? `REVOKED ${account.revoked_at.toISOString().slice(0, 10)}`
      : "live";
    console.log(
      `  ${account.label.padEnd(16)} ${state.padEnd(20)} user=${account.user_id}`,
    );
  }
}

async function revoke(label) {
  const account = await characters.revokeCharacterAccount(label);
  if (!account) {
    fail(`No character account labelled "${label}".`);
  }
  console.log(
    `Revoked "${label}". Its token stops authenticating on the next request.\n` +
      `The account, its handle and everything it has said are untouched — ` +
      `run --rotate ${label} to bring it back with a new secret.`,
  );
}

async function provision() {
  const communities = loadCommunities(args.config);
  const personas = communities
    .flatMap((community) =>
      community.personas.map((persona) => ({
        persona,
        community: community.community.key,
      })),
    )
    .filter(
      ({ persona }) =>
        args.only.length === 0 || args.only.includes(persona.id),
    );
  if (personas.length === 0) {
    fail(`No persona matched --only ${args.only.join(",")}`);
  }

  console.log(
    `${personas.length} persona(s) across ${communities.length} communit(ies) ` +
      `from ${args.config}\n`,
  );

  // Merge rather than overwrite: a run that adds one persona must not orphan
  // the twenty-four tokens already in the file, which would take every account
  // offline until somebody rotated them all.
  const existing = readTokens(args.out);
  const tokens = { ...existing };
  let minted = 0;
  let rotated = 0;
  let kept = 0;

  for (const { persona, community } of personas) {
    const label = persona.id;
    const account = await characters.getCharacterAccountByLabel(label);
    const wantsRotate = args.rotate === "all" || args.rotate === label;

    if (account && !wantsRotate) {
      if (!tokens[label]) {
        // The account exists but this machine has no secret for it. There is no
        // way to read one back, by design — say so instead of silently leaving
        // a hole the runner will discover at boot.
        console.log(
          `  ! ${label.padEnd(16)} account exists but no token here — ` +
            `run --rotate ${label} to mint a new one`,
        );
      } else {
        kept += 1;
      }
      continue;
    }

    if (args.dryRun) {
      console.log(
        `  ~ ${label.padEnd(16)} would ${account ? "rotate" : "mint"} (${community})`,
      );
      continue;
    }

    if (account) {
      const result = await characters.rotateCharacterToken(label);
      tokens[label] = result.token;
      rotated += 1;
      console.log(`  ↻ ${label.padEnd(16)} rotated (${community})`);
      continue;
    }

    const created = await characters.createCharacterAccount({
      label,
      displayName: persona.displayName,
      avatarUrl: avatarFor(persona),
      createdBy: `provision.mjs:${community}`,
    });
    tokens[label] = created.token;
    minted += 1;
    console.log(
      `  + ${label.padEnd(16)} ${created.user.username}#${created.user.discriminator} (${community})`,
    );
  }

  if (args.dryRun) {
    console.log("\nDry run — nothing was written.");
    return;
  }

  writeTokens(args.out, tokens);
  console.log(
    `\n${minted} minted, ${rotated} rotated, ${kept} already provisioned.` +
      `\nTokens written to ${args.out} (mode 0600).` +
      `\n\nThis file is the ONLY copy of these secrets — they cannot be read back ` +
      `out of the database.\nBack it up somewhere the deploy can reach, and point ` +
      `the runner at it with AMBIENT_TOKENS_FILE.`,
  );
}

// -------------------------------------------------------------------- helpers

/**
 * A stable avatar per persona, from its `avatarSeed`.
 *
 * DiceBear's PNG endpoint by default: it is deterministic on the seed, so a
 * re-provision produces the same face, and it needs no upload pipeline and no
 * bucket. `AMBIENT_AVATAR_BASE` overrides it — point that at a folder of real
 * PNGs the moment somebody draws them, and nothing else changes.
 */
function avatarFor(persona) {
  const seed = encodeURIComponent(persona.avatarSeed ?? persona.id);
  return `${args.avatarBase}${seed}`;
}

function readTokens(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed?.characters ?? parsed ?? {};
  } catch {
    return {};
  }
}

function writeTokens(path, tokens) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    `${JSON.stringify({ characters: tokens }, null, 2)}\n`,
    { mode: 0o600 },
  );
  // `writeFileSync`'s mode only applies to a file it CREATES, so an existing
  // file keeps whatever permissions it had — including a world-readable 644
  // from a first run under a different umask.
  chmodSync(target, 0o600);
}

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}
