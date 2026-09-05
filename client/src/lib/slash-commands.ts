import {
  MAX_DICE_COUNT,
  MAX_DRAW_COUNT,
  MAX_CHOOSE_OPTIONS,
  parseChooseOptions,
  parseDrawCount,
  parsePollSlashArgs,
  parseRollNotation,
  type ChanceParseError,
  type ChanceRequest,
  type PollRequest,
} from "@pqp/shared";
import { isApplePlatform } from "@/lib/composer-formatting";
import { translateMessage, type MessageKey } from "@/lib/i18n";

export interface SlashCommandMeta {
  name: string;
  description: string;
  usage: string;
  /** When true, Tab/Enter from the menu inserts `/name ` and waits for args. */
  takesArgs: boolean;
}

export type SlashFeedbackTone = "info" | "error" | "success";

export interface SlashFeedback {
  message: string;
  tone: SlashFeedbackTone;
}

export interface SlashCommandContext {
  args: string;
  sendMessage: (body: string) => void;
  updateDisplayName: (name: string) => Promise<void>;
  openInvite: (mode: "create" | "join") => void;
  joinByCode: (code: string) => Promise<void>;
  setMuted: (muted: boolean) => void;
  isInVoice: boolean;
  isMuted: boolean;
  /** Opens the GIF picker, seeded with a query when one was typed. */
  openGifPicker: (query: string) => void;
  isGifSearchEnabled: boolean;
  sendChance: (request: ChanceRequest) => void;
  sendPoll: (request: PollRequest) => void;
  openPollComposer: () => void;
}

export type SlashExecuteResult =
  | { kind: "ok"; feedback?: SlashFeedback; clearComposer?: boolean }
  | { kind: "error"; feedback: SlashFeedback };

interface SlashCommand {
  name: string;
  descriptionKey: MessageKey;
  usage: string;
  takesArgs: boolean;
  execute: (ctx: SlashCommandContext) => Promise<SlashExecuteResult> | SlashExecuteResult;
}

const SHRUG = "¯\\_(ツ)_/¯";
const TABLEFLIP = "(╯°□°)╯︵ ┻━┻";

function ok(
  feedback?: SlashFeedback,
  clearComposer = true,
): SlashExecuteResult {
  return { kind: "ok", feedback, clearComposer };
}

function err(message: string): SlashExecuteResult {
  return { kind: "error", feedback: { message, tone: "error" } };
}

function errKey(key: MessageKey, vars?: Record<string, string | number>): SlashExecuteResult {
  return err(translateMessage(key, vars));
}

const commands: SlashCommand[] = [
  {
    name: "help",
    descriptionKey: "slash.help.description",
    usage: "/help",
    takesArgs: false,
    execute() {
      const lines = listSlashCommands().map(
        (c) => `${c.usage} — ${c.description}`,
      );
      // The formatting shortcuts have no button and no menu of their own, so
      // the command listing is the one place a person can find out they exist.
      lines.push(
        "",
        translateMessage("slash.help.formatting", {
          mod: isApplePlatform() ? "Cmd" : "Ctrl",
        }),
      );
      return ok({
        message: lines.join("\n"),
        tone: "info",
      });
    },
  },
  {
    name: "shrug",
    descriptionKey: "slash.shrug.description",
    usage: "/shrug [text]",
    takesArgs: true,
    execute({ args, sendMessage }) {
      const body = args ? `${args} ${SHRUG}` : SHRUG;
      sendMessage(body);
      return ok();
    },
  },
  {
    name: "tableflip",
    descriptionKey: "slash.tableflip.description",
    usage: "/tableflip [text]",
    takesArgs: true,
    execute({ args, sendMessage }) {
      const body = args ? `${args} ${TABLEFLIP}` : TABLEFLIP;
      sendMessage(body);
      return ok();
    },
  },
  {
    name: "me",
    descriptionKey: "slash.me.description",
    usage: "/me <action>",
    takesArgs: true,
    execute({ args, sendMessage }) {
      if (!args) {
        return errKey("slash.me.usage");
      }
      sendMessage(`_${args}_`);
      return ok();
    },
  },
  {
    name: "nick",
    descriptionKey: "slash.nick.description",
    usage: "/nick <name>",
    takesArgs: true,
    async execute({ args, updateDisplayName }) {
      const name = args.trim();
      if (!name) {
        return errKey("slash.nick.usage");
      }
      if (name.length > 100) {
        return errKey("slash.nick.tooLong");
      }
      try {
        await updateDisplayName(name);
        return ok({
          message: translateMessage("slash.nick.ok", { name }),
          tone: "success",
        });
      } catch (error) {
        return err(
          error instanceof Error ? error.message : translateMessage("slash.nick.failed"),
        );
      }
    },
  },
  {
    name: "invite",
    descriptionKey: "slash.invite.description",
    usage: "/invite",
    takesArgs: false,
    execute({ openInvite }) {
      openInvite("create");
      return ok({
        message: translateMessage("slash.invite.opened"),
        tone: "info",
      });
    },
  },
  {
    name: "join",
    descriptionKey: "slash.join.description",
    usage: "/join <code>",
    takesArgs: true,
    async execute({ args, joinByCode }) {
      const code = args.trim();
      if (!code) {
        return errKey("slash.join.usage");
      }
      try {
        await joinByCode(code);
        return ok({
          message: translateMessage("slash.join.ok", { code }),
          tone: "success",
        });
      } catch (error) {
        return err(
          error instanceof Error ? error.message : translateMessage("slash.join.failed"),
        );
      }
    },
  },
  {
    name: "mute",
    descriptionKey: "slash.mute.description",
    usage: "/mute",
    takesArgs: false,
    execute({ isInVoice, isMuted, setMuted }) {
      if (!isInVoice) {
        return errKey("slash.voice.first");
      }
      if (isMuted) {
        return ok({ message: translateMessage("slash.mute.already"), tone: "info" });
      }
      setMuted(true);
      return ok({ message: translateMessage("slash.mute.ok"), tone: "success" });
    },
  },
  {
    name: "unmute",
    descriptionKey: "slash.unmute.description",
    usage: "/unmute",
    takesArgs: false,
    execute({ isInVoice, isMuted, setMuted }) {
      if (!isInVoice) {
        return errKey("slash.voice.first");
      }
      if (!isMuted) {
        return ok({ message: translateMessage("slash.unmute.already"), tone: "info" });
      }
      setMuted(false);
      return ok({ message: translateMessage("slash.unmute.ok"), tone: "success" });
    },
  },
  {
    name: "gif",
    descriptionKey: "slash.gif.description",
    usage: "/gif [query]",
    takesArgs: true,
    execute({ args, openGifPicker, isGifSearchEnabled }) {
      // The deployment answers this at boot; hard-coding "not configured" here
      // meant the command kept saying so long after a key was set.
      if (!isGifSearchEnabled) {
        return errKey("slash.gif.unconfigured");
      }
      // No argument is a valid way to ask — it opens on trending, which is what
      // the button does.
      openGifPicker(args.trim());
      return ok();
    },
  },
  {
    name: "roll",
    descriptionKey: "slash.roll.description",
    usage: "/roll [1d20]",
    takesArgs: true,
    execute({ args, sendChance }) {
      const parsed = parseRollNotation(args);
      if (!parsed.ok) {
        return chanceErr(parsed.error);
      }
      sendChance({
        type: "roll",
        notation: parsed.value.notation,
        ...(parsed.value.comment ? { comment: parsed.value.comment } : {}),
      });
      // The chance card in the transcript is the confirmation. A "Rolled
      // 1d20" strip above the composer only shoves the input around.
      return ok();
    },
  },
  {
    name: "flip",
    descriptionKey: "slash.flip.description",
    usage: "/flip",
    takesArgs: false,
    execute({ sendChance }) {
      sendChance({ type: "flip" });
      return ok();
    },
  },
  {
    name: "choose",
    descriptionKey: "slash.choose.description",
    usage: "/choose pizza burguer sushi",
    takesArgs: true,
    execute({ args, sendChance }) {
      const parsed = parseChooseOptions(args);
      if (!parsed.ok) {
        return chanceErr(parsed.error);
      }
      sendChance({ type: "choose", options: parsed.value });
      return ok();
    },
  },
  {
    name: "draw",
    descriptionKey: "slash.draw.description",
    usage: "/draw [count]",
    takesArgs: true,
    execute({ args, sendChance }) {
      const parsed = parseDrawCount(args);
      if (!parsed.ok) {
        return chanceErr(parsed.error);
      }
      sendChance({ type: "draw", count: parsed.value });
      return ok();
    },
  },
  {
    name: "shuffle",
    descriptionKey: "slash.shuffle.description",
    usage: "/shuffle",
    takesArgs: false,
    execute({ sendChance }) {
      sendChance({ type: "shuffle" });
      return ok();
    },
  },
  {
    name: "poll",
    descriptionKey: "slash.poll.description",
    usage: "/poll question | option | option",
    takesArgs: true,
    execute({ args, sendPoll, openPollComposer }) {
      if (!args.trim()) {
        openPollComposer();
        return ok();
      }
      const request = parsePollSlashArgs(args);
      if (!request) {
        return errKey("slash.poll.needOptions");
      }
      sendPoll(request);
      return ok();
    },
  },
  {
    name: "clear",
    descriptionKey: "slash.clear.description",
    usage: "/clear",
    takesArgs: false,
    execute() {
      return ok({
        message: translateMessage("slash.clear.ok"),
        tone: "info",
      });
    },
  },
];

const byName = new Map(commands.map((c) => [c.name, c]));

export function listSlashCommands(): SlashCommandMeta[] {
  return commands.map(({ name, descriptionKey, usage, takesArgs }) => ({
    name,
    description: translateMessage(descriptionKey),
    usage,
    takesArgs,
  }));
}

export function filterSlashCommands(query: string): SlashCommandMeta[] {
  const q = query.toLowerCase();
  return listSlashCommands().filter((c) => c.name.startsWith(q));
}

/**
 * Common dice shown after `/roll`, same set the table already allows.
 * Avrae defaults bare `!roll` to 1d20; casual Discord dice bots then offer
 * d4–d100 as choices so nobody has to remember XdY.
 */
export const ROLL_PRESETS = [
  {
    notation: "1d20",
    labelKey: "slash.roll.preset.d20" as const,
    hintKey: "slash.roll.preset.default" as const,
  },
  { notation: "1d4", labelKey: "slash.roll.preset.d4" as const },
  { notation: "1d6", labelKey: "slash.roll.preset.d6" as const },
  { notation: "2d6", labelKey: "slash.roll.preset.d6x2" as const },
  { notation: "1d8", labelKey: "slash.roll.preset.d8" as const },
  { notation: "1d10", labelKey: "slash.roll.preset.d10" as const },
  { notation: "1d12", labelKey: "slash.roll.preset.d12" as const },
  { notation: "1d100", labelKey: "slash.roll.preset.d100" as const },
] as const;

export type RollPreset = (typeof ROLL_PRESETS)[number];

/** `/roll` or `/roll 2d6` — not a second word after the notation. */
export function isRollPresetMenu(value: string): boolean {
  return /^\/roll(?:\s\S*)?$/i.test(value);
}

export function filterRollPresets(argQuery: string): RollPreset[] {
  const q = argQuery.trim().toLowerCase();
  if (!q) {
    return [...ROLL_PRESETS];
  }
  return ROLL_PRESETS.filter((preset) => matchesRollPresetQuery(preset.notation, q));
}

function matchesRollPresetQuery(notation: string, q: string): boolean {
  const n = notation.toLowerCase();
  if (n.startsWith(q)) {
    return true;
  }
  const d = n.indexOf("d");
  if (d < 0) {
    return false;
  }
  const count = n.slice(0, d);
  const faces = n.slice(d + 1);
  if (`d${faces}`.startsWith(q)) {
    return true;
  }
  return /^\d+$/.test(q) && (count === q || faces === q);
}

/** True while the slash menu should stay open: command names, or roll presets. */
export function isSlashMenuOpen(value: string): boolean {
  return /^\/\S*$/.test(value) || isRollPresetMenu(value);
}

export function getSlashQuery(value: string): string {
  if (!value.startsWith("/")) {
    return "";
  }
  return value.slice(1);
}

export function parseSlashInput(value: string): {
  name: string;
  args: string;
} | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const withoutSlash = trimmed.slice(1);
  const space = withoutSlash.search(/\s/);
  if (space === -1) {
    return { name: withoutSlash.toLowerCase(), args: "" };
  }
  return {
    name: withoutSlash.slice(0, space).toLowerCase(),
    args: withoutSlash.slice(space + 1).trimStart(),
  };
}

export async function executeSlashCommand(
  value: string,
  ctx: Omit<SlashCommandContext, "args">,
): Promise<SlashExecuteResult> {
  const parsed = parseSlashInput(value);
  if (!parsed || !parsed.name) {
    return errKey("slash.unknown");
  }

  const command = byName.get(parsed.name);
  if (!command) {
    return errKey("slash.unknownNamed", { name: parsed.name });
  }

  return command.execute({ ...ctx, args: parsed.args });
}

function chanceErr(error: ChanceParseError): SlashExecuteResult {
  switch (error) {
    case "invalid-notation":
      return errKey("slash.roll.invalid");
    case "bad-face":
      return errKey("slash.roll.badFace");
    case "too-many-dice":
      return errKey("slash.roll.tooMany", { count: MAX_DICE_COUNT });
    case "too-few-options":
      return errKey("slash.choose.tooFew");
    case "too-many-options":
      return errKey("slash.choose.tooMany", { count: MAX_CHOOSE_OPTIONS });
    case "empty-option":
    case "option-too-long":
      return errKey("slash.choose.tooLong");
    case "bad-draw-count":
      return errKey("slash.draw.badCount", { count: MAX_DRAW_COUNT });
    case "comment-too-long":
      return errKey("slash.roll.commentTooLong");
  }
}
