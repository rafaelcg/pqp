package gg.pqp.app.ui.chat

import gg.pqp.app.protocol.RepoSources
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The grammar a message body is read with.
 *
 * Chat markdown is Discord-shaped rather than CommonMark-shaped, and the shape
 * is the web client's: `client/src/lib/chat-markdown.ts` keeps every newline
 * the author typed and disables headings, indented code, HTML and `---` rules,
 * so `# announcement` is a sentence and not a heading. Two clients disagreeing
 * about which characters are markup is a message that reads differently
 * depending on who opens it, which nothing errors about and nobody reports.
 */
class ChatMarkdownTest {

    private fun spans(body: String): List<ChatSpan> {
        val blocks = ChatMarkdown.parse(body)
        assertEquals("Expected one paragraph out of: $body", 1, blocks.size)
        return (blocks.single() as ChatBlock.Paragraph).spans
    }

    private fun text(body: String): String = spans(body).joinToString("") { it.text }

    @Test
    fun `plain text is one span`() {
        assertEquals(listOf(ChatSpan("hello there")), spans("hello there"))
    }

    @Test
    fun `bold, italic and strikethrough`() {
        assertEquals(
            listOf(ChatSpan("very", bold = true)),
            spans("**very**"),
        )
        assertEquals(listOf(ChatSpan("soft", italic = true)), spans("*soft*"))
        assertEquals(listOf(ChatSpan("soft", italic = true)), spans("_soft_"))
        assertEquals(listOf(ChatSpan("gone", strike = true)), spans("~~gone~~"))
        assertEquals(listOf(ChatSpan("loud", bold = true)), spans("__loud__"))
    }

    @Test
    fun `styles nest`() {
        assertEquals(
            listOf(ChatSpan("both", bold = true, italic = true)),
            spans("**_both_**"),
        )
    }

    @Test
    fun `an unbalanced delimiter stays literal`() {
        assertEquals("**not bold", text("**not bold"))
        assertEquals("2 * 3 * 4", text("2 * 3 * 4"))
        // `snake_case_name` is a word, not emphasis. This is the single most
        // common false positive in a chat full of code.
        assertEquals("snake_case_name", text("snake_case_name"))
    }

    @Test
    fun `an escape is the character it escapes`() {
        assertEquals(listOf(ChatSpan("*literal*")), spans("""\*literal\*"""))
    }

    @Test
    fun `inline code is verbatim`() {
        val result = spans("run `npm  install` now")
        assertEquals(3, result.size)
        assertEquals("npm  install", result[1].text)
        assertTrue(result[1].code)
        // Nothing inside a code span is markup: this is what stops a snippet
        // full of asterisks from being rendered as emphasis.
        assertEquals(listOf(ChatSpan("**not bold**", code = true)), spans("`**not bold**`"))
    }

    @Test
    fun `a fenced block is its own block and keeps its blank lines`() {
        val blocks = ChatMarkdown.parse("before\n```kotlin\nval a = 1\n\nval b = 2\n```\nafter")
        assertEquals(3, blocks.size)
        val code = blocks[1] as ChatBlock.Code
        assertEquals("val a = 1\n\nval b = 2", code.text)
        assertEquals("kotlin", code.language)
    }

    @Test
    fun `a fence nobody closed is still code`() {
        val blocks = ChatMarkdown.parse("```\nhalf a snippet")
        assertEquals(listOf(ChatBlock.Code("half a snippet", null)), blocks)
    }

    @Test
    fun `quotes are their own block`() {
        val blocks = ChatMarkdown.parse("> quoted\n> more")
        assertEquals(1, blocks.size)
        assertEquals("quoted\nmore", (blocks.single() as ChatBlock.Quote).spans.joinToString("") { it.text })
    }

    @Test
    fun `a heading is text, because chat has no headings`() {
        val blocks = ChatMarkdown.parse("# announcement")
        assertEquals(listOf(ChatBlock.Paragraph(listOf(ChatSpan("# announcement")))), blocks)
    }

    @Test
    fun `a bare url is a link, and trailing punctuation is not part of it`() {
        val result = spans("see https://pqp.gg/app, then")
        val link = result.single { it.link != null }
        assertEquals("https://pqp.gg/app", link.link)
        assertEquals("https://pqp.gg/app", link.text)
        assertEquals("see https://pqp.gg/app, then", result.joinToString("") { it.text })
    }

    @Test
    fun `a labelled link keeps its label`() {
        val result = spans("[the app](https://pqp.gg/app)")
        assertEquals(listOf(ChatSpan("the app", link = "https://pqp.gg/app")), result)
    }

    @Test
    fun `a url inside a code span is not a link`() {
        assertNull(spans("`https://pqp.gg`").single().link)
    }

    @Test
    fun `mentions carry the username without the at sign`() {
        val result = spans("hey @rafa and @bob_2")
        val mentions = result.mapNotNull { it.mention }
        assertEquals(listOf("rafa", "bob_2"), mentions)
        assertEquals("hey @rafa and @bob_2", result.joinToString("") { it.text })
    }

    @Test
    fun `the renderer marks exactly what the server would resolve`() {
        // Including inside an email address, which looks wrong and is right:
        // `MENTION_PATTERN` has no word boundary, so `extractMentions` on the
        // server pulls `example` out of this and notifies an account by that
        // name if one exists. Marking less than the server acts on would be a
        // notification with nothing on screen explaining it.
        //
        // The *picker* is stricter (`MentionAutocomplete.find` refuses an `@`
        // mid-word), which is a different question: what to offer while
        // typing, not what somebody typed.
        assertEquals(listOf("example"), spans("write to me@example.com").mapNotNull { it.mention })
    }

    @Test
    fun `a one letter token is too short to be a mention`() {
        assertEquals(emptyList<String>(), spans("@a").mapNotNull { it.mention })
    }

    @Test
    fun `mentions survive next to markup`() {
        val result = spans("**@rafa** shipped")
        val mention = result.single { it.mention != null }
        assertEquals("rafa", mention.mention)
        assertTrue(mention.bold)
    }

    @Test
    fun `newlines are kept and runs of blank lines are collapsed`() {
        assertEquals("a\n\nb", ChatMarkdown.clampNewlines("a\n\n\n\n\nb"))
        assertEquals("a\nb", ChatMarkdown.clampNewlines("a\nb"))
        assertEquals("a", ChatMarkdown.clampNewlines("\n\na\n\n"))
        // Idempotent, the same way `clampChatNewlines` is.
        val once = ChatMarkdown.clampNewlines("a\n\n\nb")
        assertEquals(once, ChatMarkdown.clampNewlines(once))
    }

    @Test
    fun `a fenced block keeps the blank lines a clamp would eat`() {
        val source = "```\na\n\n\n\nb\n```"
        assertEquals(source, ChatMarkdown.clampNewlines(source))
    }

    /**
     * The one fact here that is a hand-copy off the wire. `MENTION_PATTERN`
     * lives in `packages/shared/src/api.ts` and both the server's resolver and
     * the web renderer use it; a rename or a widened character class there
     * would leave Android marking a different set of tokens than the set that
     * actually notifies somebody.
     */
    @Test
    fun `the mention pattern matches the shared one`() {
        val shared = File(RepoSources.root, "packages/shared/src/api.ts").readText()
        val declared = Regex("""MENTION_PATTERN\s*=\s*/([^/]+)/g""").find(shared)
        assertTrue("MENTION_PATTERN not found in packages/shared/src/api.ts", declared != null)
        assertEquals(
            "The shared mention pattern changed. ChatMarkdown.MENTION is a hand-copy of it.",
            declared!!.groupValues[1],
            ChatMarkdown.MENTION.pattern,
        )
    }
}
