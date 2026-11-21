package gg.pqp.app.jam

/*
 * HOW A PERSON'S TEXT JOINS THE APP'S OWN WORDS, pure so a test can say what a screen draws. The instrument's
 * name and the middle dot are the app's; the label, the artist and the person are typed by strangers
 * (`JamBidi`), so each is an isolate wherever it shares a line with anything else. The iOS twin is
 * `JamTrackNaming` in `JamStyle.swift`.
 */
object JamNaming {
    const val SEPARATOR = " · "

    /**
     * What a drawn line holds for a typed value: an isolate around it, or [fallback] (the app's own words, left
     * alone) when it is absent or was nothing but bidi controls and spaces.
     */
    fun drawn(text: String?, fallback: String? = null): String? {
        val usable = text?.let(JamBidi::clean)?.trim().orEmpty()
        return if (usable.isEmpty()) fallback else JamBidi.isolate(usable)
    }

    /** A track row's first line: the instrument, then its label when it has one ("Bass · take 2"). */
    fun heading(instrumentTitle: String, label: String?): String {
        val tail = drawn(label) ?: return instrumentTitle
        return instrumentTitle + SEPARATOR + tail
    }
}
