import { useMemo, type ReactNode } from "react";
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
import { forgetServerEmoji, noteUnknownServerEmoji } from "@/lib/server-emoji";
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
            forgetServerEmoji(serverId, emoji.id);
          }
        }}
      />
    );
  }
  return <span className={props.className}>{children}</span>;
}

const MARKDOWN_COMPONENTS = {
  span: MarkdownSpan,
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
