/**
 * The homepage's server-bot claims, and the one place that says whether the
 * page may make them. PR#1188 (server bots) is not on main yet, so both
 * switches ship false: the page keeps Breu, the mascot, and says nothing about
 * server bots anywhere (copy, alt text, aria labels, FAQ, meta, JSON-LD).
 * André flips them once PR#1188 is live and the `custom_bots` flag is on for
 * the servers a visitor will create.
 *
 * No imports, on purpose: the edge middleware bundles this file through
 * `lib/marketing-meta.ts` (the FAQ JSON-LD for "/"), outside the workspace.
 *
 * Read the claims through `serverBotClaims()` at render or call time, never
 * the constants at module scope: a test drives the function both ways, and a
 * module constant cannot be.
 */

// depends on PR#1188 shipping
export const SERVER_BOTS_LIVE: boolean = false;

// depends on PR#1188 shipping with its actions (phase 2)
export const SERVER_BOT_ACTIONS_LIVE: boolean = false;

/** "aos-poucos": the flag goes on server by server. "todos": on for every server. */
export type ServerBotsRollout = "aos-poucos" | "todos";

// depends on PR#1188 shipping. André decides at launch.
export const SERVER_BOTS_ROLLOUT: ServerBotsRollout = "aos-poucos";

// depends on PR#1188 shipping: the "Updated" date of Sem letra miúda while
// the bot line shows. Move it to the ship day. The page formats it in the
// reader's language (`Intl`), so there is no label here.
export const BOTS_COPY_UPDATED = { iso: "2026-10-17" } as const;

// The sample server's bot, A Mesa's bard. Never "Breu" (that is the species).
export const SAMPLE_BOT = { name: "Bardo", handle: "@bardo_bot" } as const;

/** What the page may claim while bots are live. */
export type ServerBotClaims = {
  /** The bot runs tools (a poll, a channel), not only replies. */
  actions: boolean;
  rollout: ServerBotsRollout;
};

/**
 * Null while bots are off, so the actions and rollout switches mean nothing
 * until the main one is on. Every reader calls this at render or call time.
 */
export function serverBotClaims(): ServerBotClaims | null {
  if (!SERVER_BOTS_LIVE) return null;
  return { actions: SERVER_BOT_ACTIONS_LIVE, rollout: SERVER_BOTS_ROLLOUT };
}

/** The catalogue keys the bot FAQ answer is made of (`home.faq.bot.a.*`). */
export type BotFaqAnswerKey =
  | "home.faq.bot.a.actions"
  | "home.faq.bot.a.replies"
  | "home.faq.bot.a.gradual"
  | "home.faq.bot.a.everyone";

/**
 * The bot FAQ answer: what the bot reads (one sentence set per actions state)
 * and how it is rolling out (one closing sentence per rollout), joined by one
 * space. The page passes its `t`; the JSON-LD passes a lookup into its own
 * literal copy (`LANDING_BOT_FAQ` in `marketing-meta.ts`). Both build the
 * answer here, so the page and the search snippet cannot drift apart.
 */
export function botFaqAnswer(t: (key: BotFaqAnswerKey) => string, claims: ServerBotClaims): string {
  const reads = t(claims.actions ? "home.faq.bot.a.actions" : "home.faq.bot.a.replies");
  const rollout = t(claims.rollout === "aos-poucos" ? "home.faq.bot.a.gradual" : "home.faq.bot.a.everyone");
  return `${reads} ${rollout}`;
}
