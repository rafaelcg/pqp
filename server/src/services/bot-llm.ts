import Anthropic from "@anthropic-ai/sdk";

/**
 * The one place a server bot's words come from. A seam on purpose: the runner
 * speaks a small provider-neutral shape (messages, tools, tool calls) and each
 * provider translates it. Today pqp pays, through Anthropic or OpenRouter; a
 * server's own key plugs in here later without the runner changing.
 *
 * Which provider: `BOTS_PROVIDER` (`anthropic` | `openrouter`) when set, else
 * Anthropic when `ANTHROPIC_API_KEY` is set, else OpenRouter when
 * `OPENROUTER_API_KEY` is set. With neither key outside production the
 * provider is `fixture`, a canned answer that costs nothing, so the whole loop
 * runs on localhost before anybody has a key. In production a missing key
 * turns bots off (`botProviderConfigured`), never a fixture talking to people.
 */

/** A tool the model may call, described with a JSON Schema for its input. */
export interface BotToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface BotToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface BotToolResult {
  id: string;
  content: string;
  isError?: boolean;
}

/** An image the model looks at: the bytes, base64. Never a URL to our bucket. */
export interface BotImage {
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string;
}

export type BotMessage =
  | {
      role: "user";
      text: string;
      /** Shown before the text, in order: the transcript names them [image 1], [image 2]. */
      images?: BotImage[];
    }
  | {
      role: "assistant";
      text: string | null;
      toolCalls: BotToolCall[];
      /**
       * The provider's own message, replayed verbatim on the next turn.
       * Anthropic requires its thinking blocks back unchanged in a tool loop,
       * so the runner never rebuilds an assistant turn from the parts above.
       */
      raw: unknown;
    }
  | { role: "tool"; results: BotToolResult[] };

export interface BotCompletionInput {
  system: string;
  messages: BotMessage[];
  tools?: BotToolSpec[];
  maxTokens: number;
  /** A turn that may act gets to think; plain chat does not. */
  think?: boolean;
}

export interface BotCompletion {
  /** Null when the model declined (`refusal`) or said nothing. */
  text: string | null;
  toolCalls: BotToolCall[];
  /** The assistant turn to append to the conversation for the next call. */
  message: Extract<BotMessage, { role: "assistant" }>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The model id ASKED for. Pricing reads this, never the response's. */
  model: string;
  stopReason: string | null;
  /** What the provider itself said the call cost, when it says (OpenRouter). */
  reportedCostMicros: number | null;
}

export interface BotProvider {
  name: "anthropic" | "openrouter" | "fixture";
  model: string;
  complete(input: BotCompletionInput): Promise<BotCompletion>;
}

/**
 * Dollars per million tokens, for the spend ceiling. Keyed by the requested
 * id; an unknown model bills at the dearest row, because overestimating stops
 * bots early and underestimating overspends, and only one is recoverable.
 * Free OpenRouter models (`:free`, `openrouter/free`) cost nothing.
 */
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  fixture: { input: 0, output: 0 },
};
const FREE_PRICE = { input: 0, output: 0 };
const FALLBACK_PRICE = { input: 10, output: 50 };

export function isFreeModel(model: string): boolean {
  return model === "openrouter/free" || model.endsWith(":free");
}

export function botPrice(model: string): { input: number; output: number } {
  if (isFreeModel(model)) {
    return FREE_PRICE;
  }
  const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  return PRICE_PER_MTOK[model] ?? PRICE_PER_MTOK[bare] ?? FALLBACK_PRICE;
}

/** Cache reads bill at a tenth of input, cache writes at 1.25x. */
export function botCostMicros(usage: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reportedCostMicros?: number | null;
}): number {
  if (usage.reportedCostMicros != null) {
    return usage.reportedCostMicros;
  }
  const price = botPrice(usage.model);
  const dollars =
    (usage.inputTokens * price.input +
      usage.cacheReadTokens * price.input * 0.1 +
      usage.cacheWriteTokens * price.input * 1.25 +
      usage.outputTokens * price.output) /
    1_000_000;
  return Math.ceil(dollars * 1_000_000);
}

// ---------------------------------------------------------------- Anthropic

/**
 * The last two user-side messages carry a cache breakpoint. Every tool turn
 * sends the whole conversation again plus one assistant turn and its results,
 * so the newest breakpoint writes the prefix and the one before it reads what
 * the previous turn wrote. Without them the transcript, the largest part of a
 * request after the tools, was billed in full on every turn. Two here, plus
 * the system prompt and the tools, is Anthropic's limit of four.
 */
export function toAnthropicMessages(messages: BotMessage[]): Anthropic.MessageParam[] {
  const cached = new Set(
    messages
      .map((message, index) => (message.role === "assistant" ? -1 : index))
      .filter((index) => index >= 0)
      .slice(-2),
  );
  const cache = (index: number) =>
    cached.has(index) ? { cache_control: { type: "ephemeral" as const } } : {};
  return messages.map((message, index): Anthropic.MessageParam => {
    switch (message.role) {
      case "user":
        return {
          role: "user",
          content: [
            ...(message.images ?? []).map(
              (image): Anthropic.ImageBlockParam => ({
                type: "image",
                source: { type: "base64", media_type: image.mediaType, data: image.data },
              }),
            ),
            { type: "text", text: message.text, ...cache(index) },
          ],
        };
      case "assistant":
        return {
          role: "assistant",
          content: message.raw as Anthropic.ContentBlockParam[],
        };
      case "tool":
        return {
          role: "user",
          content: message.results.map((result, resultIndex, all) => ({
            type: "tool_result" as const,
            tool_use_id: result.id,
            content: result.content,
            ...(result.isError ? { is_error: true } : {}),
            ...(resultIndex === all.length - 1 ? cache(index) : {}),
          })),
        };
    }
  });
}

function anthropicProvider(apiKey: string, model: string): BotProvider {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 60_000 });
  return {
    name: "anthropic",
    model,
    async complete(input) {
      const tools = input.tools?.map(
        (tool, index, all): Anthropic.Tool => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
          // The tool list never changes between turns, so it caches with the
          // system prompt behind one breakpoint on the last tool.
          ...(index === all.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
        }),
      );
      const response = await client.messages.create({
        model,
        max_tokens: input.maxTokens,
        // Plain chat does not need thinking, and thinking bills as output.
        // Haiku 5.5 accepts `disabled` at effort `high` or below; a turn that
        // may act thinks adaptively at medium.
        ...(input.think
          ? { thinking: { type: "adaptive" as const }, output_config: { effort: "medium" as const } }
          : { thinking: { type: "disabled" as const }, output_config: { effort: "low" as const } }),
        system: [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }],
        messages: toAnthropicMessages(input.messages),
        ...(tools && tools.length > 0 ? { tools } : {}),
      });
      const text = response.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("")
        .trim();
      const toolCalls = response.content.flatMap((block) =>
        block.type === "tool_use"
          ? [{ id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> }]
          : [],
      );
      const refused = response.stop_reason === "refusal";
      return {
        text: refused || !text ? null : text,
        toolCalls: refused ? [] : toolCalls,
        message: { role: "assistant", text: text || null, toolCalls, raw: response.content },
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        model,
        stopReason: response.stop_reason ?? null,
        reportedCostMicros: null,
      };
    },
  };
}

// --------------------------------------------------------------- OpenRouter

type OpenAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAiContentPart[] | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function toOpenAiMessages(system: string, messages: BotMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({
        role: "user",
        content: message.images?.length
          ? [
              ...message.images.map(
                (image): OpenAiContentPart => ({
                  type: "image_url",
                  image_url: { url: `data:${image.mediaType};base64,${image.data}` },
                }),
              ),
              { type: "text", text: message.text },
            ]
          : message.text,
      });
    } else if (message.role === "assistant") {
      out.push(message.raw as OpenAiMessage);
    } else {
      for (const result of message.results) {
        out.push({
          role: "tool",
          tool_call_id: result.id,
          content: result.isError ? `ERROR: ${result.content}` : result.content,
        });
      }
    }
  }
  return out;
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * OpenRouter's OpenAI-compatible chat completions. The key is sent to
 * `OPENROUTER_BASE_URL` (default OpenRouter), so that stays environment only.
 * `usage.include` asks OpenRouter for the real cost of each call, which is
 * what the spend ceiling settles to.
 */
/**
 * `fallbacks` are other free models OpenRouter tries, in order, when `model`
 * is rate limited or down. Free models are throttled upstream often enough
 * that a single one fails a real share of replies.
 */
function openRouterProvider(apiKey: string, model: string, fallbacks: string[] = []): BotProvider {
  const baseUrl =
    process.env.OPENROUTER_BASE_URL?.trim().replace(/\/+$/, "") || "https://openrouter.ai/api/v1";
  return {
    name: "openrouter",
    model,
    async complete(input) {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://pqp.gg",
          "X-Title": "pqp bots",
        },
        body: JSON.stringify({
          model,
          ...(fallbacks.length > 0 ? { models: [model, ...fallbacks].slice(0, 3) } : {}),
          max_tokens: input.maxTokens,
          messages: toOpenAiMessages(input.system, input.messages),
          ...(input.tools && input.tools.length > 0
            ? {
                tools: input.tools.map((tool) => ({
                  type: "function",
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                  },
                })),
              }
            : {}),
          usage: { include: true },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 300);
        throw new ProviderHttpError(response.status, `openrouter ${response.status}: ${detail}`);
      }
      const body = (await response.json()) as {
        choices?: Array<{ message?: OpenAiMessage; finish_reason?: string | null }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
        /** The model that actually served the request; a router picks one. */
        model?: string;
        error?: { code?: number; message?: string };
      };
      if (body.error) {
        throw new ProviderHttpError(body.error.code ?? 502, `openrouter: ${body.error.message ?? "error"}`);
      }
      const choice = body.choices?.[0];
      const message: OpenAiMessage = choice?.message ?? { role: "assistant", content: null };
      const toolCalls = (message.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        input: parseArguments(call.function.arguments),
      }));
      const text = (typeof message.content === "string" ? message.content : "").trim();
      const cost = body.usage?.cost;
      return {
        text: text || null,
        toolCalls,
        message: {
          role: "assistant",
          text: text || null,
          toolCalls,
          raw: { role: "assistant", content: message.content ?? null, ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) },
        },
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        model: body.model ?? model,
        stopReason: choice?.finish_reason ?? null,
        reportedCostMicros: typeof cost === "number" ? Math.ceil(cost * 1_000_000) : null,
      };
    },
  };
}

// ------------------------------------------------------------------ fixture

const fixtureProvider: BotProvider = {
  name: "fixture",
  model: "fixture",
  async complete(input) {
    const first = input.messages[0];
    const prompt = first?.role === "user" ? first.text : "";
    const lines = prompt.split("\n");
    const last = lines[lines.indexOf("</conversation>") - 1] ?? "";
    const text = `(resposta de teste, sem chave de API) Recebi: ${last.slice(0, 200)}`;
    return {
      text,
      toolCalls: [],
      message: { role: "assistant", text, toolCalls: [], raw: [{ type: "text", text }] },
      inputTokens: Math.ceil((input.system.length + prompt.length) / 4),
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      model: "fixture",
      stopReason: "end_turn",
      reportedCostMicros: 0,
    };
  },
};

// ----------------------------------------------------------------- choosing

let override: BotProvider | null = null;
const built = new Map<string, BotProvider>();

/** Tests only: answer with this provider instead. `null` restores the real one. */
export function setBotProviderForTests(provider: BotProvider | null): void {
  override = provider;
}

/** Whether an error from `complete` is worth another attempt later. */
export function isRetriableProviderError(error: unknown): boolean {
  const status = (error as { status?: number }).status;
  return status === undefined || status === 408 || status === 429 || status >= 500;
}

type ProviderName = "anthropic" | "openrouter";

/** One model a bot may be set to, offered in its settings. */
export interface BotModelChoice {
  /** `provider:model`, what a bot row stores. */
  id: string;
  provider: ProviderName;
  model: string;
  label: string;
}

function keyFor(provider: ProviderName): string | undefined {
  return (provider === "anthropic"
    ? process.env.ANTHROPIC_API_KEY
    : process.env.OPENROUTER_API_KEY
  )?.trim() || undefined;
}

function parseChoice(raw: string): BotModelChoice | null {
  const [idPart, labelPart] = raw.split("=", 2);
  const id = idPart?.trim() ?? "";
  const colon = id.indexOf(":");
  if (colon < 0) return null;
  const provider = id.slice(0, colon);
  const model = id.slice(colon + 1);
  if ((provider !== "anthropic" && provider !== "openrouter") || !model) return null;
  return { id, provider, model, label: labelPart?.trim() || model };
}

/**
 * The models staff may pick for a bot, only those whose key is configured.
 * `BOTS_MODEL_CHOICES` (`provider:model=Label;...`) sets the list; without it
 * the list is Claude Haiku 5.5 and two free OpenRouter models, for whichever
 * keys exist. The first entry is the default for a bot that picked nothing.
 *
 * Free models are for local testing only and are never offered in production,
 * even when `BOTS_MODEL_CHOICES` names one: their answers were too poor to put
 * in front of members. A bot saved with one falls back to the default there.
 */
export function botModelChoices(): BotModelChoice[] {
  const configured = process.env.BOTS_MODEL_CHOICES?.trim();
  const choices = configured
    ? configured.split(";").map(parseChoice).filter((c): c is BotModelChoice => c !== null)
    : [
        { id: "anthropic:claude-haiku-5-5", provider: "anthropic" as const, model: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
        // Named free models, not the `openrouter/free` router: the router may
        // hand a chat turn to a safety classifier, which answers with a verdict.
        { id: "openrouter:google/gemma-4-31b-it:free", provider: "openrouter" as const, model: "google/gemma-4-31b-it:free", label: "Gemma 4 31B (grátis)" },
        { id: "openrouter:nvidia/nemotron-3-super-120b-a12b:free", provider: "openrouter" as const, model: "nvidia/nemotron-3-super-120b-a12b:free", label: "Nemotron 3 Super (grátis)" },
      ];
  const wanted = process.env.BOTS_PROVIDER?.trim().toLowerCase();
  const production = process.env.NODE_ENV === "production";
  const usable = choices.filter(
    (choice) => keyFor(choice.provider) && !(production && isFreeModel(choice.model)),
  );
  // `BOTS_PROVIDER` / `BOTS_MODEL` still pick the default, which goes first.
  const preferredModel = process.env.BOTS_MODEL?.trim();
  usable.sort((a, b) => {
    const score = (c: BotModelChoice) =>
      (preferredModel && c.model === preferredModel ? 2 : 0) + (wanted && c.provider === wanted ? 1 : 0);
    return score(b) - score(a);
  });
  return usable;
}

function build(choice: BotModelChoice, offered: BotModelChoice[]): BotProvider {
  const key = keyFor(choice.provider)!;
  const signature = `${choice.id}|${key}`;
  let provider = built.get(signature);
  if (!provider) {
    provider =
      choice.provider === "anthropic"
        ? anthropicProvider(key, choice.model)
        : openRouterProvider(
            key,
            choice.model,
            // Only a free pick falls back, and only to other free models, so a
            // paid pick never quietly turns into a different bill.
            isFreeModel(choice.model)
              ? offered
                  .filter((c) => c.provider === "openrouter" && isFreeModel(c.model) && c.id !== choice.id)
                  .map((c) => c.model)
              : [],
          );
    built.set(signature, provider);
  }
  return provider;
}

/**
 * The provider for a bot: its own pick when that pick is still offered, else
 * the default. Null in production with no key; the fixture elsewhere.
 */
export function getBotProvider(choiceId?: string | null): BotProvider | null {
  if (override) {
    return override;
  }
  const choices = botModelChoices();
  const choice = (choiceId && choices.find((c) => c.id === choiceId)) || choices[0];
  if (!choice) {
    return process.env.NODE_ENV === "production" ? null : fixtureProvider;
  }
  return build(choice, choices);
}

/** False when nothing could answer: production with no key. */
export function botProviderConfigured(): boolean {
  return getBotProvider() !== null;
}
