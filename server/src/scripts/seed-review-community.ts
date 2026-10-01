/**
 * Seed the App Review demo space. Run by hand, once, on the API box.
 *
 *   node server/dist/scripts/seed-review-community.js --clerk-id user_xxx            # dry run
 *   node server/dist/scripts/seed-review-community.js --clerk-id user_xxx --apply
 *   node server/dist/scripts/seed-review-community.js --clerk-id user_xxx --apply --leave-others
 *   node server/dist/scripts/seed-review-community.js --clerk-id user_xxx --cleanup [--apply]
 *
 * Lives under `src/` (not `server/scripts/`) on purpose: the production image
 * carries `server/dist` and nothing else, so a file outside `src/` is not in it.
 * Everything that matters, and the exact commands for the box, is in
 * docs/TESTFLIGHT.md, "Seeding the review community". The logic is
 * `services/review-seed.ts`.
 *
 * DRY RUN BY DEFAULT. Nothing is written without `--apply`.
 *
 * It does not run `initDb`: the schema is the API's job and the box is already
 * on the schema of the image it runs. It reads and writes `DATABASE_URL` from
 * the environment, which inside an API container is the production database.
 */
import { pathToFileURL } from "node:url";
import "../env.js";
import { closePool } from "../db.js";
import {
  ReviewSeedError,
  REVIEW_SERVER_NAME,
  runReviewSeed,
  type ReviewSeedOptions,
} from "../services/review-seed.js";

export const USAGE = `Usage: seed-review-community.js (--clerk-id <id> | --user-id <uuid>) [flags]

  --clerk-id <id>   the demo account's Clerk user id (user_...)
  --user-id <uuid>  ...or its users.id
  --apply           write. Without it, a dry run that changes nothing
  --leave-others    also remove the demo account from every other server
                    (never deletes a server; an owner is never removed)
  --cleanup         undo: delete the "${REVIEW_SERVER_NAME}" server and the Demo Friend account
  --force           with --cleanup, even if somebody else joined the server
  --help
`;

export function parseArgs(argv: readonly string[]): ReviewSeedOptions & {
  help: boolean;
} {
  const out: ReviewSeedOptions & { help: boolean } = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith("--")) {
        throw new ReviewSeedError(`${arg} needs a value.`);
      }
      return next;
    };
    switch (arg) {
      case "--clerk-id":
        out.clerkId = value();
        break;
      case "--user-id":
        out.userId = value();
        break;
      case "--apply":
        out.apply = true;
        break;
      case "--leave-others":
        out.leaveOthers = true;
        break;
      case "--cleanup":
        out.cleanup = true;
        break;
      case "--force":
        out.force = true;
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        throw new ReviewSeedError(`Unknown argument ${arg}.\n\n${USAGE}`);
    }
  }
  return out;
}

/** `host/dbname` and nothing else: never the user, the password or the query. */
export function describeDatabase(url: string | undefined): string {
  if (!url) {
    return "(DATABASE_URL is not set)";
  }
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "(DATABASE_URL does not parse)";
  }
}

async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 64;
  }
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    return 64;
  }

  const { help: _help, ...options } = parsed;
  console.log(
    `${options.apply ? "APPLY" : "DRY RUN (nothing is written; add --apply)"}: ` +
      `${options.cleanup ? "cleanup" : "seed"} on ${describeDatabase(process.env.DATABASE_URL)}`,
  );
  try {
    const report = await runReviewSeed({ ...options, log: console.log });
    console.log("");
    if (report.mode === "seed") {
      console.log("Summary");
      console.log(`  server       ${REVIEW_SERVER_NAME}  ${report.serverId ?? "(not created yet)"}`);
      console.log(`  invite code  ${report.inviteCode ?? "(not created yet)"}`);
      console.log(`  friend       ${report.friendUserId ?? "(not created yet)"}`);
      console.log(`  messages     ${report.messageCount}`);
    }
    const blocked = report.actions.some((action) => action.kind === "blocked");
    if (!options.apply) {
      console.log("Dry run only. Re-run with --apply to write.");
    }
    if (blocked) {
      console.log("Something was refused (lines marked !). Read them above.");
      return 2;
    }
    return 0;
  } catch (error) {
    if (error instanceof ReviewSeedError) {
      console.error(`Refused: ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    await closePool();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(70);
    },
  );
}
