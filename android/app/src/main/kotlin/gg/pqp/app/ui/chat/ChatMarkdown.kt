package gg.pqp.app.ui.chat

/**
 * What a message body renders as, once its markdown has been read.
 *
 * A body is a list of blocks: paragraphs of styled runs, fenced code, and
 * quotes. Chat markdown is Discord-shaped rather than CommonMark-shaped, the
 * same way `client/src/lib/chat-markdown.ts` describes it: every newline the
 * author typed is kept, `# topic` is text, and the inline vocabulary is bold,
 * italic, strikethrough, code, links and `@mentions`. That is the vocabulary
 * this parser reads, and nothing more, so a message that the web draws as
 * markdown reads the same on a phone and a message the web leaves literal
 * stays literal here.
 */
sealed interface ChatBlock {
    data class Paragraph(val spans: List<ChatSpan>) : ChatBlock

    /** A ``` fence. Kept verbatim: nothing inside it is markdown. */
    data class Code(val text: String, val language: String? = null) : ChatBlock

    /** Lines that opened with `> `, drawn against a rule. */
    data class Quote(val spans: List<ChatSpan>) : ChatBlock
}

/**
 * One run of text with the styles that apply to all of it.
 *
 * [mention] is the username (without the `@`) so the renderer can decide
 * whether it names the reader. [link] is the destination; the text of a bare
 * URL is the URL itself, and the text of `[label](url)` is the label.
 */
data class ChatSpan(
    val text: String,
    val bold: Boolean = false,
    val italic: Boolean = false,
    val strike: Boolean = false,
    val code: Boolean = false,
    val link: String? = null,
    val mention: String? = null,
)

object ChatMarkdown {

    /**
     * `MENTION_PATTERN` from `packages/shared/src/api.ts`, copied by hand and
     * pinned by `ChatMarkdownContractTest`. No word boundary on purpose: the
     * web has none either, and two clients that disagree about which tokens
     * are mentions would paint the same message two ways.
     */
    val MENTION: Regex = Regex("@([A-Za-z0-9_]{2,32})")

    private val FENCE_LINE = Regex("""^( {0,3})(`{3,}|~{3,})(.*)$""")
    private val LINK = Regex("""^\[([^\]\n]+)]\((https?://[^)\s]+)\)""")
    private val URL = Regex("""^https?://[^\s<]+""")
    private val MENTION_AT = Regex("""^@([A-Za-z0-9_]{2,32})""")
    private val BLANK = Regex("""^[ \t]*$""")

    /**
     * Read a body into blocks. Never throws: an unbalanced delimiter is a
     * literal character, which is also what the web does with it.
     */
    fun parse(body: String): List<ChatBlock> {
        val lines = clampNewlines(body).split("\n")
        val blocks = mutableListOf<ChatBlock>()
        val paragraph = StringBuilder()
        val quote = StringBuilder()
        var fence: Pair<Char, Int>? = null
        var fenceLanguage: String? = null
        val code = StringBuilder()

        fun flushParagraph() {
            if (paragraph.isNotEmpty()) {
                blocks += ChatBlock.Paragraph(inline(paragraph.toString()))
                paragraph.setLength(0)
            }
        }

        fun flushQuote() {
            if (quote.isNotEmpty()) {
                blocks += ChatBlock.Quote(inline(quote.toString()))
                quote.setLength(0)
            }
        }

        for (line in lines) {
            val marker = FENCE_LINE.find(line)
            if (fence != null) {
                val (char, length) = fence
                if (marker != null &&
                    marker.groupValues[2][0] == char &&
                    marker.groupValues[2].length >= length &&
                    marker.groupValues[3].isBlank()
                ) {
                    blocks += ChatBlock.Code(code.toString().trimEnd('\n'), fenceLanguage)
                    code.setLength(0)
                    fence = null
                    fenceLanguage = null
                } else {
                    code.append(line).append('\n')
                }
                continue
            }

            if (marker != null) {
                flushParagraph()
                flushQuote()
                val run = marker.groupValues[2]
                fence = run[0] to run.length
                fenceLanguage = marker.groupValues[3].trim().takeIf { it.isNotEmpty() }
                continue
            }

            if (line.startsWith("> ") || line == ">") {
                flushParagraph()
                if (quote.isNotEmpty()) quote.append('\n')
                quote.append(line.removePrefix(">").removePrefix(" "))
                continue
            }

            flushQuote()
            if (paragraph.isNotEmpty()) paragraph.append('\n')
            paragraph.append(line)
        }

        // A fence somebody never closed is still code; the web renders it
        // that way too, because the alternative is three backticks in the
        // bubble and the snippet mangled as markdown.
        if (fence != null) {
            blocks += ChatBlock.Code(code.toString().trimEnd('\n'), fenceLanguage)
        }
        flushParagraph()
        flushQuote()
        return blocks
    }

    /**
     * `clampChatNewlines` from `packages/shared/src/chat-text.ts`: three or
     * more newlines become two, leading and trailing blank lines go, and a
     * fenced block is left exactly as typed. Idempotent.
     */
    fun clampNewlines(source: String): String {
        val lines = source.replace("\r\n", "\n").replace('\r', '\n').split("\n")
        val out = mutableListOf<String>()
        var fence: Pair<Char, Int>? = null
        var started = false
        var pendingBlank = false

        for (line in lines) {
            val marker = FENCE_LINE.find(line)
            var isMarker = false
            if (marker != null) {
                val run = marker.groupValues[2]
                if (fence == null) {
                    fence = run[0] to run.length
                    isMarker = true
                } else if (run[0] == fence.first && run.length >= fence.second && marker.groupValues[3].isBlank()) {
                    fence = null
                    isMarker = true
                }
            }

            if (fence != null && !isMarker || isMarker) {
                if (started && pendingBlank) {
                    out += ""
                    pendingBlank = false
                }
                out += line
                started = true
                continue
            }

            if (BLANK.matches(line)) {
                if (started) pendingBlank = true
                continue
            }
            if (pendingBlank) {
                out += ""
                pendingBlank = false
            }
            out += line
            started = true
        }
        return out.joinToString("\n")
    }

    private data class Style(
        val bold: Boolean = false,
        val italic: Boolean = false,
        val strike: Boolean = false,
    )

    /** Inline markup for one paragraph, newlines included as text. */
    internal fun inline(text: String): List<ChatSpan> {
        val out = mutableListOf<ChatSpan>()
        scan(text, Style(), out)
        return merge(out)
    }

    private fun scan(text: String, style: Style, out: MutableList<ChatSpan>) {
        val plain = StringBuilder()
        fun flush() {
            if (plain.isNotEmpty()) {
                out += ChatSpan(plain.toString(), style.bold, style.italic, style.strike)
                plain.setLength(0)
            }
        }

        var i = 0
        while (i < text.length) {
            val c = text[i]

            // Escapes. `\*` is an asterisk, as in every markdown.
            if (c == '\\' && i + 1 < text.length && text[i + 1] in ESCAPABLE) {
                plain.append(text[i + 1])
                i += 2
                continue
            }

            if (c == '`') {
                val run = runLength(text, i, '`')
                val close = findRun(text, i + run, '`', run)
                if (close != -1) {
                    flush()
                    var content = text.substring(i + run, close)
                    // One space either side is stripped, so `` ` `` can be typed.
                    if (content.length >= 2 && content.startsWith(" ") && content.endsWith(" ") && content.isNotBlank()) {
                        content = content.substring(1, content.length - 1)
                    }
                    out += ChatSpan(content, style.bold, style.italic, style.strike, code = true)
                    i = close + run
                    continue
                }
                plain.append(text, i, i + run)
                i += run
                continue
            }

            val emphasis = emphasisAt(text, i, style)
            if (emphasis != null) {
                val (delimiter, inner, next) = emphasis
                flush()
                scan(text.substring(i + delimiter.length, inner), delimiter.applyTo(style), out)
                i = next
                continue
            }

            if (c == '[') {
                val link = LINK.find(text.substring(i))
                if (link != null) {
                    flush()
                    val label = link.groupValues[1]
                    val labelled = mutableListOf<ChatSpan>()
                    scan(label, style, labelled)
                    labelled.forEach { out += it.copy(link = link.groupValues[2]) }
                    i += link.value.length
                    continue
                }
            }

            if (c == 'h' && (text.startsWith("http://", i) || text.startsWith("https://", i))) {
                val url = URL.find(text.substring(i))
                if (url != null) {
                    val trimmed = trimUrl(url.value)
                    flush()
                    out += ChatSpan(trimmed, style.bold, style.italic, style.strike, link = trimmed)
                    i += trimmed.length
                    continue
                }
            }

            if (c == '@') {
                val mention = MENTION_AT.find(text.substring(i))
                if (mention != null) {
                    flush()
                    out += ChatSpan(
                        mention.value,
                        style.bold,
                        style.italic,
                        style.strike,
                        mention = mention.groupValues[1],
                    )
                    i += mention.value.length
                    continue
                }
            }

            plain.append(c)
            i += 1
        }
        flush()
    }

    private enum class Delimiter(val marker: String) {
        BoldStar("**"), BoldUnderscore("__"), Strike("~~"), ItalicStar("*"), ItalicUnderscore("_");

        val length: Int get() = marker.length

        fun applyTo(style: Style): Style = when (this) {
            BoldStar, BoldUnderscore -> style.copy(bold = true)
            Strike -> style.copy(strike = true)
            ItalicStar, ItalicUnderscore -> style.copy(italic = true)
        }
    }

    /**
     * An emphasis run opening at [at], or null when the character there is
     * literal. Returns the delimiter, the index where the content ends and the
     * index just past the closer.
     */
    private fun emphasisAt(text: String, at: Int, style: Style): Triple<Delimiter, Int, Int>? {
        for (delimiter in Delimiter.entries) {
            val marker = delimiter.marker
            if (!text.startsWith(marker, at)) continue
            val char = marker[0]
            // A single `*` must not be the start of a `**` run that failed to
            // close; that case is handled by falling through to the literal.
            if (marker.length == 1 && at + 1 < text.length && text[at + 1] == char) continue
            // Already inside this style: a nested `*` is the closer, which the
            // enclosing scan owns, never a new opener.
            if (delimiter.applyTo(style) == style) continue
            if (char == '_' && at > 0 && text[at - 1].isLetterOrDigit()) continue

            val contentStart = at + marker.length
            if (contentStart >= text.length || text[contentStart].isWhitespace()) continue

            var j = contentStart + 1
            while (j < text.length) {
                if (text.startsWith(marker, j) && !text[j - 1].isWhitespace()) {
                    val after = j + marker.length
                    val longer = marker.length == 1 && after < text.length && text[after] == char
                    val wordAfter = char == '_' && after < text.length && text[after].isLetterOrDigit()
                    if (!longer && !wordAfter) {
                        return Triple(delimiter, j, after)
                    }
                }
                if (text[j] == '\n' && text.getOrNull(j + 1) == '\n') break
                j += 1
            }
        }
        return null
    }

    private fun runLength(text: String, at: Int, char: Char): Int {
        var n = 0
        while (at + n < text.length && text[at + n] == char) n += 1
        return n
    }

    /** The next run of exactly [length] [char]s at or after [from], or -1. */
    private fun findRun(text: String, from: Int, char: Char, length: Int): Int {
        var i = from
        while (i < text.length) {
            if (text[i] == char) {
                val run = runLength(text, i, char)
                if (run == length) return i
                i += run
            } else {
                i += 1
            }
        }
        return -1
    }

    /**
     * Trailing punctuation belongs to the sentence, not the link, and a `)`
     * only belongs to the link when the link opened one. GFM's autolink rule.
     */
    internal fun trimUrl(raw: String): String {
        var url = raw
        while (url.isNotEmpty()) {
            val last = url.last()
            if (last in TRAILING_PUNCTUATION) {
                url = url.dropLast(1)
                continue
            }
            if (last == ')' && url.count { it == '(' } < url.count { it == ')' }) {
                url = url.dropLast(1)
                continue
            }
            break
        }
        return url
    }

    private fun merge(spans: List<ChatSpan>): List<ChatSpan> {
        val out = mutableListOf<ChatSpan>()
        for (span in spans) {
            if (span.text.isEmpty()) continue
            val last = out.lastOrNull()
            if (last != null && last.copy(text = "") == span.copy(text = "") && !span.code) {
                out[out.lastIndex] = last.copy(text = last.text + span.text)
            } else {
                out += span
            }
        }
        return out
    }

    private const val ESCAPABLE = "\\`*_~[]()#>"
    private const val TRAILING_PUNCTUATION = ".,;:!?'\"*_~"
}
