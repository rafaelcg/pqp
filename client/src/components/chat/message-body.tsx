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

const MARKDOWN_COMPONENTS = {
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
  const plugins = useMemo(
    // remark-breaks turns a single newline into a <br>. prepareChatMarkdown
    // keeps blank lines from collapsing into a paragraph gap first.
    () => [
      remarkDisableChatBlocks,
      remarkGfm,
      remarkBreaks,
      remarkStripNewlineFillers,
      remarkMentions(currentUsername),
    ],
    [currentUsername],
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
