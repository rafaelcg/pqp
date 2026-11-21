package gg.pqp.app.jam

/*
 * TEXT A PERSON WROTE, DRAWN INSIDE THE APP'S OWN SENTENCE.
 *
 * A song's title, an artist, a take's label and a display name are typed by
 * strangers. The Unicode bidi algorithm lets one character change how the text
 * AFTER it is laid out: an unclosed right-to-left override (U+202E) in an artist
 * turns "Artista · Gabi" into "ibaG · atsitrA". The server strips the override,
 * embedding and isolate controls from new titles, artists and labels (`cleanLine`
 * in `packages/shared/src/jam.ts`), but a row written before that still holds
 * them, and a display name comes from an account, so a screen cannot rely on the
 * server alone.
 *
 * This is the web's helper (`client/src/lib/bidi.ts`) and the iOS one
 * (`JamBidi.swift`), with the same character set and behaviour so the three
 * clients agree:
 *
 *  - [isolate] for a string that is joined to other text and DRAWN: first-strong
 *    isolate characters (U+2068 .. U+2069) around it, after the explicit controls
 *    are dropped from inside it (a U+2069 in the text would close the isolate
 *    early). Done by hand and not with `BidiFormatter.unicodeWrap`: that wraps in
 *    an EMBEDDING (U+202A/U+202B .. U+202C) plus marks, and strips nothing, so
 *    a control already in the text would survive it.
 *  - [clean] for a string that stands alone in its own `Text`, or that TalkBack
 *    speaks (it reads in logical order, so it needs no isolate and never has to
 *    meet the isolate characters). `clean(isolate(x))` is `clean(x)`, so a line
 *    that already holds isolates can be cleaned for TalkBack in one go.
 *
 * Honest right-to-left text, the joiners (U+200C, U+200D: emoji family sequences,
 * Persian) and the implicit marks (U+200E, U+200F, U+061C) are not touched.
 */
object JamBidi {
    private const val FSI = '⁨'
    private const val PDI = '⁩'

    /** Override and embedding controls (U+202A to U+202E) and isolate controls (U+2066 to U+2069). */
    private fun isExplicitControl(c: Char): Boolean = c in '‪'..'‮' || c in '⁦'..'⁩'

    /** The text without bidi override, embedding and isolate controls. */
    fun clean(text: String): String = if (text.none(::isExplicitControl)) text else text.filterNot(::isExplicitControl)

    /**
     * The text as a self-contained unit for a string: nothing in it can reorder what is around it, and nothing
     * around it reorders it. Empty stays empty (two invisible characters in an otherwise empty slot would still
     * be a slot).
     */
    fun isolate(text: String): String {
        val stripped = clean(text)
        return if (stripped.isEmpty()) "" else "$FSI$stripped$PDI"
    }

    /** [isolate] for a value that may be absent. */
    fun isolateOpt(text: String?): String = if (text == null) "" else isolate(text)
}
