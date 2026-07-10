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
}

export type SlashExecuteResult =
  | { kind: "ok"; feedback?: SlashFeedback; clearComposer?: boolean }
  | { kind: "error"; feedback: SlashFeedback };

interface SlashCommand extends SlashCommandMeta {
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

const commands: SlashCommand[] = [
  {
    name: "help",
    description: "List available slash commands",
    usage: "/help",
    takesArgs: false,
    execute() {
      const lines = listSlashCommands().map(
        (c) => `${c.usage} — ${c.description}`,
      );
      return ok({
        message: lines.join("\n"),
        tone: "info",
      });
    },
  },
  {
    name: "shrug",
    description: "Append a shrug to your message",
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
    description: "Flip a table in chat",
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
    description: "Send an emote-style italic action",
    usage: "/me <action>",
    takesArgs: true,
    execute({ args, sendMessage }) {
      if (!args) {
        return err("Usage: /me <action>");
      }
      sendMessage(`_${args}_`);
      return ok();
    },
  },
  {
    name: "nick",
    description: "Update your display name",
    usage: "/nick <name>",
    takesArgs: true,
    async execute({ args, updateDisplayName }) {
      const name = args.trim();
      if (!name) {
        return err("Usage: /nick <name>");
      }
      if (name.length > 100) {
        return err("Display name must be 100 characters or fewer.");
      }
      try {
        await updateDisplayName(name);
        return ok({
          message: `Display name set to ${name}`,
          tone: "success",
        });
      } catch (error) {
        return err(
          error instanceof Error ? error.message : "Failed to update name",
        );
      }
    },
  },
  {
    name: "invite",
    description: "Open the invite panel for this server",
    usage: "/invite",
    takesArgs: false,
    execute({ openInvite }) {
      openInvite("create");
      return ok({
        message: "Opened invite panel",
        tone: "info",
      });
    },
  },
  {
    name: "join",
    description: "Join a server with an invite code",
    usage: "/join <code>",
    takesArgs: true,
    async execute({ args, joinByCode }) {
      const code = args.trim();
      if (!code) {
        return err("Usage: /join <code>");
      }
      try {
        await joinByCode(code);
        return ok({
          message: `Joined via invite ${code}`,
          tone: "success",
        });
      } catch (error) {
        return err(
          error instanceof Error ? error.message : "Failed to join invite",
        );
      }
    },
  },
  {
    name: "mute",
    description: "Mute your microphone in voice",
    usage: "/mute",
    takesArgs: false,
    execute({ isInVoice, isMuted, setMuted }) {
      if (!isInVoice) {
        return err("Join a voice channel first.");
      }
      if (isMuted) {
        return ok({ message: "Already muted", tone: "info" });
      }
      setMuted(true);
      return ok({ message: "Muted", tone: "success" });
    },
  },
  {
    name: "unmute",
    description: "Unmute your microphone in voice",
    usage: "/unmute",
    takesArgs: false,
    execute({ isInVoice, isMuted, setMuted }) {
      if (!isInVoice) {
        return err("Join a voice channel first.");
      }
      if (!isMuted) {
        return ok({ message: "Already unmuted", tone: "info" });
      }
      setMuted(false);
      return ok({ message: "Unmuted", tone: "success" });
    },
  },
  {
    name: "gif",
    description: "Search GIFs (not configured)",
    usage: "/gif <query>",
    takesArgs: true,
    execute({ args }) {
      if (!args.trim()) {
        return err("Usage: /gif <query>");
      }
      return err(
        "GIF search isn’t configured — no API key. Try pasting a GIF link instead.",
      );
    },
  },
  {
    name: "clear",
    description: "Clear the message composer (local only)",
    usage: "/clear",
    takesArgs: false,
    execute() {
      return ok({
        message:
          "Composer cleared. Server message history is not deleted (no API for that).",
        tone: "info",
      });
    },
  },
];

const byName = new Map(commands.map((c) => [c.name, c]));

export function listSlashCommands(): SlashCommandMeta[] {
  return commands.map(({ name, description, usage, takesArgs }) => ({
    name,
    description,
    usage,
    takesArgs,
  }));
}

export function filterSlashCommands(query: string): SlashCommandMeta[] {
  const q = query.toLowerCase();
  return listSlashCommands().filter((c) => c.name.startsWith(q));
}

/** True while the user is typing `/` or `/partial` with no args yet. */
export function isSlashMenuOpen(value: string): boolean {
  return /^\/\S*$/.test(value);
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
    return err("Unknown command. Type /help for a list.");
  }

  const command = byName.get(parsed.name);
  if (!command) {
    return err(`Unknown command /${parsed.name}. Type /help for a list.`);
  }

  return command.execute({ ...ctx, args: parsed.args });
}
