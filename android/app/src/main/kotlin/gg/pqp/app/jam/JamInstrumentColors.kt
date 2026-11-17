package gg.pqp.app.jam

/**
 * THE SIX INSTRUMENT IDENTITIES, in one place and as plain numbers, so a test
 * can read the web's tokens and prove they are the same.
 *
 * Source of truth: `--color-inst-*` and `--color-on-inst` in
 * `client/src/index.css`, which are written in OKLCH. These are those six
 * colours converted to sRGB (the conversion is `JamInstrumentColorsTest`, which
 * parses the CSS and converts it again, so a token that moves on the web fails
 * a test here). They are identities, not chrome: the same six fills in light and
 * dark, each carrying the dark ink, and told apart by LIGHTNESS as well as hue
 * (from the darkest blue to the lightest yellow) because hue alone fails for a
 * person who cannot tell the hues apart. Every one also carries its own icon.
 *
 * The guitar is a warm YELLOW, not the lime it started as: lime is the app's
 * accent, the colour of every "do this" button, and a lime guitar lane next to
 * a lime "Gravar" read as one more button.
 */
object JamInstrumentColors {
    /** `oklch(0.92 0.15 90)` */
    const val GUITAR = 0xFFFFE061L

    /** `oklch(0.64 0.15 255)` */
    const val BASS = 0xFF468DE5L

    /** `oklch(0.77 0.15 55)` */
    const val DRUMS = 0xFFFC984CL

    /** `oklch(0.82 0.12 345)` */
    const val VOCALS = 0xFFFCA4D6L

    /** `oklch(0.87 0.11 195)` */
    const val KEYS = 0xFF70EBEBL

    /** `oklch(0.71 0.16 310)` */
    const val OTHER = 0xFFC082EBL

    /** `--color-on-inst`, `oklch(0.16 0.012 250)`: the ink on every instrument fill. */
    const val INK = 0xFF090E12L

    fun of(instrument: JamInstrument): Long = when (instrument) {
        JamInstrument.Guitar -> GUITAR
        JamInstrument.Bass -> BASS
        JamInstrument.Drums -> DRUMS
        JamInstrument.Vocals -> VOCALS
        JamInstrument.Keys -> KEYS
        JamInstrument.Other -> OTHER
    }
}
