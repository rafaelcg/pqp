import { useMemo, useRef, useState, type ReactNode } from "react";
import { Copy } from "@phosphor-icons/react";
import { Icon as Glyph } from "@/components/ui/icon";
import { useTranslation } from "@/lib/i18n";
import { useRedesign } from "@/lib/redesign";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import {
  prepareChatMarkdown,
  remarkDisableChatBlocks,
  remarkStripNewlineFillers,
} from "@/lib/chat-markdown";
import { remarkMentions } from "@/lib/remark-mentions";
import { remarkCustomEmoji } from "@/lib/remark-custom-emoji";
import { noteUnknownServerEmoji } from "@/lib/server-emoji";
import {
  CustomEmojiImage,
  useCustomEmojiScope,
} from "@/components/chat/custom-emoji";
import { remarkRetroEmoticons } from "@/lib/retro-emoticons";
import { useRetroLook } from "@/hooks/use-appearance";

/**
 * Note the absence of `img`: attachments render from the structured array on
 * the message, never from markdown a sender typed. Allowing it here would let
 * any message embed any URL, which is a per-reader tracking pixel and a way to
 * put arbitrary remote content inside our own origin.
 */
const MARKDOWN_ELEMENTS = [
  "p",
  "span",
  "strong",
  "em",
  "del",
  "code",
  "pre",
  "a",
  "br",
  "ul",
  "ol",
  "li",
  "blockquote",
];

/**
 * A span the custom-emoji plugin marked draws the picture from the server's
 * list; every other span (mentions, blank-line spacers) passes through.
 */
function MarkdownSpan({
  node,
  children,
  ...props
}: {
  node?: { properties?: Record<string, unknown> };
  children?: ReactNode;
  className?: string;
}) {
  const { serverId, byId } = useCustomEmojiScope();
  const id = node?.properties?.dataEmojiId;
  const emoji = typeof id === "string" ? byId.get(id) : undefined;
  if (emoji) {
    return (
      <CustomEmojiImage
        emoji={emoji}
        onBroken={() => {
          if (serverId) {
            noteUnknownServerEmoji(serverId);
          }
        }}
      />
    );
  }
  return <span className={props.className}>{children}</span>;
}

/*
 * A code block. Under the redesign it carries Copiar in its corner (the text
 * channels canvas, "Link enorme e código largo"); the block still scrolls
 * sideways and never widens the message. With the toggle off it is the
 * plain <pre> it always was.
 */
function CodeBlock({ children }: { node?: unknown; children?: ReactNode }) {
  const redesign = useRedesign();
  const { t } = useTranslation();
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  if (!redesign) {
    return <pre>{children}</pre>;
  }
  return (
    <div className="pqp-code-block">
      <pre ref={ref}>{children}</pre>
      <button
        type="button"
        className="pqp-code-copy"
        onClick={() => {
          const text = ref.current?.textContent ?? "";
          void navigator.clipboard?.writeText(text).then(
            () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            },
            () => {},
          );
        }}
      >
        <Glyph icon={Copy} kind="symbol" size="sm" className="h-3 w-3" />
        {copied ? t("chat.codeCopied") : t("chat.copyCode")}
      </button>
    </div>
  );
}

const MARKDOWN_COMPONENTS = {
  span: MarkdownSpan,
  pre: CodeBlock,
  // Links in user content are untrusted: never hand the opener a window
  // reference, and never leak the app URL as a referrer.
  a: ({ children, href }: { children?: ReactNode; href?: string }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow ugc">
      {children}
    </a>
  ),
  // Self-closing, no extra text node. A newline next to <br> under
  // `white-space: pre-*` is what turned one Shift+Enter into a blank block.
  br: () => <br />,
};

/** Message body: markdown, with `@username` highlighted inside it. */
export function MessageBody({
  body,
  currentUsername,
}: {
  body: string;
  currentUsername: string | null;
}) {
  const prepared = useMemo(() => prepareChatMarkdown(body), [body]);
  // Modo 2005 reads `(H)` as 😎 at render time, for this reader only.
  const retro = useRetroLook();
  const { serverId, byId } = useCustomEmojiScope();
  const plugins = useMemo(
    // remark-breaks turns a single newline into a <br>. prepareChatMarkdown
    // keeps blank lines from collapsing into a paragraph gap first.
    () => [
      remarkDisableChatBlocks,
      remarkGfm,
      remarkBreaks,
      remarkStripNewlineFillers,
      remarkCustomEmoji(
        (id) => byId.has(id),
        () => {
          if (serverId) {
            noteUnknownServerEmoji(serverId);
          }
        },
      ),
      remarkMentions(currentUsername),
      ...(retro ? [remarkRetroEmoticons] : []),
    ],
    [currentUsername, retro, serverId, byId],
  );

  return (
    <ReactMarkdown
      remarkPlugins={plugins as never}
      allowedElements={MARKDOWN_ELEMENTS}
      unwrapDisallowed
      components={MARKDOWN_COMPONENTS}
    >
      {prepared}
    </ReactMarkdown>
  );
}
