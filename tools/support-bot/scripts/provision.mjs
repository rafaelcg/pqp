#!/usr/bin/env node
/**
 * Mint the support bot's character account.
 *
 *   DATABASE_URL=… node scripts/provision.mjs
 *   DATABASE_URL=… node scripts/provision.mjs --list
 *   DATABASE_URL=… node scripts/provision.mjs --rotate
 *   DATABASE_URL=… node scripts/provision.mjs --revoke
 *
 * The same shape as `tools/ambient/scripts/provision.mjs`, and for the same
 * reasons, which are worth restating rather than cross-referencing because this
 * is the file somebody runs at 1am: it goes through the server's OWN character
 * service rather than writing SQL, so the token hashing, the age-gate columns,
 * the `dm_privacy` default and the handle derivation have exactly one
 * implementation. And it talks to `DATABASE_URL` rather than to an API route,
 * because there is no request that should be able to mint a credential of this
 * class.
 *
 * ── ONE ACCOUNT, ONE NAME, ONE DISCLOSURE ───────────────────────────────────
 *
 * The display name is built from `disclosureLabel("bot")`, which is the same
 * function the ambient runner uses, so the " [bot]" suffix is not a string
 * typed here that could drift. There is no flag to change it. An account minted
 * by this script is disclosed, permanently, by construction: that is the whole
 * difference between this and an ambient persona, and it should not be
 * something an operator can turn off with an argument.
 *
 * THIS SCRIPT HAS NOT BEEN RUN AGAINST ANYTHING. Not production, not the local
 * dev database. Minting the account is Rafael's call, after he has read the
 * design.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { disclosureLabel } from "../../ambient/src/guardrails.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const REPO = join(ROOT, "..", "..");

const argv = process.argv.slice(2);
const args = {
  out: valueOf("--out") ?? process.env.SUPPORT_TOKENS_FILE ?? join(ROOT, "secrets", "bot.json"),
  /** The key the token file is written under, and the runner's `SUPPORT_BOT_ID`. */
  id: valueOf("--id") ?? "manual_bot",
  /** The `character_accounts.label`, which is unique per account. */
  label: valueOf("--label") ?? "pqp-support-bot",
  displayName: valueOf("--display-name") ?? "manual",
  list: argv.includes("--list"),
  rotate: argv.includes("--rotate"),
  revoke: argv.includes("--revoke"),
  dryRun: argv.includes("--dry-run"),
};

function valueOf(flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  fail(
    "DATABASE_URL is required. This script talks to Postgres directly, because\n" +
      "there is deliberately no API route that mints a credential of this class.",
  );
}

const characters = await import(
  join(REPO, "server", "dist", "services", "characters.js")
).catch((error) =>
  fail(
    `Could not load the server's character service (${error.message}).\n` +
      `Build it first:  pnpm --filter @pqp/shared build && pnpm --filter @pqp/server build`,
  ),
);

/**
 * The name, assembled from the disclosure label rather than written out.
 *
 * "manual [bot]". If `disclosureLabel` ever changes what a bot is called,
 * this account is renamed with everything else on its next provision, instead
 * of being the one account still carrying last year's suffix.
 */
const label = disclosureLabel("bot");
// "manual [bot]" -> @manual_bot. `deriveHandle` slugifies the display name, so
// the disclosure suffix lands inside the mention handle and nobody can call this
// account without typing the word bot. The username is printed below, because it
// is the string that has to go into the channel topic.
const displayName = `${args.displayName}${label.suffix}`;

if (args.list) {
  const all = await characters.listCharacterAccounts();
  for (const account of all) {
    console.log(
      `${account.label.padEnd(24)} ${account.user_id}  ${
        account.revoked_at ? `REVOKED ${account.revoked_at.toISOString()}` : "active"
      }`,
    );
  }
  process.exit(0);
}

const existing = await characters.getCharacterAccountByLabel(args.label);

if (args.revoke) {
  if (!existing) {
    fail(`No character account labelled "${args.label}".`);
  }
  await characters.revokeCharacterAccount(args.label);
  console.log(`Revoked ${args.label}. The bot's token stops working immediately.`);
  process.exit(0);
}

if (args.dryRun) {
  console.log(
    `Would ${existing ? (args.rotate ? "rotate" : "leave alone") : "create"} ` +
      `"${args.label}" as "${displayName}", writing ${args.out}.`,
  );
  process.exit(0);
}

let token;
if (existing && args.rotate) {
  const rotated = await characters.rotateCharacterToken(args.label);
  if (!rotated) {
    fail(`Could not rotate "${args.label}".`);
  }
  token = rotated.token;
  console.log(`Rotated ${args.label}. The old token is dead.`);
} else if (existing) {
  fail(
    `"${args.label}" already exists (user ${existing.user_id}).\n` +
      `The secret cannot be read back, only replaced:  --rotate\n` +
      `If you still have ${args.out}, you do not need to do anything.`,
  );
} else {
  const created = await characters.createCharacterAccount({
    label: args.label,
    displayName,
  });
  token = created.token;
  console.log(
    `Created ${args.label}\n` +
      `  user id       ${created.user.id}\n` +
      `  display name  ${created.user.display_name}\n` +
      `  username      @${created.user.username}   <- this is what people type to reach it`,
  );
}

// Written the way the ambient runner's `identity.js` reads it: an object keyed
// by id, so the same `resolveIdentity` handles both tools with no branch.
mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, `${JSON.stringify({ [args.id]: token }, null, 2)}\n`);
chmodSync(args.out, 0o600);

console.log(
  `\nWrote ${args.out} (mode 0600, gitignored).\n` +
    `This is the ONLY copy. It is stored as SHA-256 and cannot be read back.\n\n` +
    `Next, and none of it is done by this script:\n` +
    `  1. CHARACTER_ACCOUNTS_ENABLED=true on the API, or every token is refused.\n` +
    `  2. Invite the account to "QG do pqp". It does not create or join servers by itself.\n` +
    `  3. Say in #ajuda's topic and the pinned welcome that it exists and how to call it.\n` +
    `     The room announces the bot. The bot never announces itself.\n`,
);
