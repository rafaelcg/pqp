package gg.pqp.app.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.sp
import gg.pqp.app.R

/**
 * The two faces the product is set in, shipped in the APK.
 *
 * The web app pairs **Gabarito** (display) with **Instrument Sans** (body), and
 * the reason for that pairing is written down in `client/src/index.css`. Until
 * now Android had neither: the theme took Material's `Typography()`, bumped a
 * few weights and left `FontFamily.Default`, which on every Android phone is
 * Roboto. That made the app look like a settings screen with pqp's colours on
 * it, which is exactly what it was.
 *
 * **Both files are the upstream `google/fonts` binaries, byte for byte**, not
 * a subset. A subset would be smaller and would also be a binary nobody in this
 * repo could regenerate or diff against anything; these can be checked with one
 * `curl` against `ofl/instrumentsans` and `ofl/gabarito`. They cost **352 KB**
 * together (194 KB + 158 KB) against a release APK that is 54.6 MB after R8
 * because of the WebRTC native libraries, so the subsetting toolchain buys
 * 0.6% and costs a build step and a provenance question. They are stored rather
 * than deflated, because Android memory-maps a font file, so that number is
 * also what a tester downloads. Both are SIL Open Font License
 * 1.1, and the licence texts are checked in at `android/app/licenses/`. They
 * live there rather than in `res/` because `res/font/` accepts font files and
 * nothing else, and an unread copy in `res/raw/` would only be weight.
 *
 * **Variable, not a static instance per weight.** One file per family carries
 * every weight through the `wght` axis, which is two font resources instead of
 * seven and lets the scale below ask for 500 and 600 as real weights rather
 * than as a synthetic smear. Variable axes need API 26, and `minSdk` is 26.
 *
 * Bricolage Grotesque and Dela Gothic One are deliberately **not** here. The
 * first is the web's handle face and this client does not render an `@handle`
 * anywhere yet; the second is a wordmark face whose file carries a Japanese
 * kana set, so it would be the largest thing in `res/` in exchange for a logo
 * that is already drawn as a vector.
 */
private fun variableFont(resId: Int, weight: FontWeight) = Font(
    resId = resId,
    weight = weight,
    variationSettings = FontVariation.Settings(FontVariation.weight(weight.weight)),
)

/** The workhorse. Everything a person reads for longer than a second. */
val InstrumentSans = FontFamily(
    variableFont(R.font.instrument_sans, FontWeight.Normal),
    variableFont(R.font.instrument_sans, FontWeight.Medium),
    variableFont(R.font.instrument_sans, FontWeight.SemiBold),
    variableFont(R.font.instrument_sans, FontWeight.Bold),
)

/** The voice. Titles, headings, names of places. Never a paragraph. */
val Gabarito = FontFamily(
    variableFont(R.font.gabarito, FontWeight.SemiBold),
    variableFont(R.font.gabarito, FontWeight.Bold),
    variableFont(R.font.gabarito, FontWeight.ExtraBold),
    variableFont(R.font.gabarito, FontWeight.Black),
)

/**
 * Line height is set as a number rather than left to the font, and the extra
 * leading is distributed evenly rather than dumped under the last line. Without
 * this every one-line row in the app sits a pixel or two above its own centre,
 * which is invisible on any single row and reads as "sloppy" down a list of
 * forty.
 */
private val EvenLeading = LineHeightStyle(
    alignment = LineHeightStyle.Alignment.Center,
    trim = LineHeightStyle.Trim.None,
)

private fun sans(
    size: Int,
    lineHeight: Int,
    weight: FontWeight = FontWeight.Normal,
    tracking: Double = 0.0,
) = TextStyle(
    fontFamily = InstrumentSans,
    fontWeight = weight,
    fontSize = size.sp,
    lineHeight = lineHeight.sp,
    letterSpacing = tracking.sp,
    lineHeightStyle = EvenLeading,
    platformStyle = PlatformTextStyle(includeFontPadding = false),
)

private fun display(
    size: Int,
    lineHeight: Int,
    weight: FontWeight = FontWeight.ExtraBold,
    tracking: Double = 0.0,
) = TextStyle(
    fontFamily = Gabarito,
    fontWeight = weight,
    fontSize = size.sp,
    lineHeight = lineHeight.sp,
    letterSpacing = tracking.sp,
    lineHeightStyle = EvenLeading,
    platformStyle = PlatformTextStyle(includeFontPadding = false),
)

/**
 * The scale, stated rather than inherited.
 *
 * Every role below names a size, a weight, a line height and a tracking on
 * purpose. Material's defaults are tuned for Gmail and Settings: 16sp body on
 * 24sp leading, 22sp titles, generous everywhere. A chat client is a list of
 * short strings and it needs to be tighter than that or forty messages become
 * four screens of scrolling.
 *
 * | Role | Face | Size / line | Weight | Tracking |
 * |---|---|---|---|---|
 * | `displaySmall` | Gabarito | 34 / 38 | 800 | -0.6 |
 * | `headlineLarge` | Gabarito | 30 / 34 | 800 | -0.5 |
 * | `headlineMedium` | Gabarito | 26 / 30 | 800 | -0.4 |
 * | `headlineSmall` | Gabarito | 21 / 26 | 700 | -0.2 |
 * | `titleLarge` | Gabarito | 19 / 24 | 700 | -0.1 |
 * | `titleMedium` | Instrument Sans | 16 / 21 | 600 | 0 |
 * | `titleSmall` | Instrument Sans | 15 / 20 | 600 | 0 |
 * | `bodyLarge` | Instrument Sans | 15 / 21 | 400 | 0 |
 * | `bodyMedium` | Instrument Sans | 14 / 19 | 400 | 0 |
 * | `bodySmall` | Instrument Sans | 13 / 17 | 400 | 0 |
 * | `labelLarge` | Instrument Sans | 14 / 18 | 600 | 0.1 |
 * | `labelMedium` | Instrument Sans | 12 / 15 | 600 | 0.2 |
 * | `labelSmall` | Instrument Sans | 11 / 13 | 700 | 1.1 |
 *
 * Negative tracking on the display face is not decoration. Gabarito is a
 * geometric sans that sets wide by default, and at 26sp and above the default
 * spacing opens words up until a two-word title looks like a banner. Pulling it
 * in is what makes a heading read as one object.
 *
 * `labelSmall` is the uppercase section rule: the channel-list category
 * headings, the sidebar labels, anything the web app sets in caps. It carries
 * the tracking that uppercase needs to be readable, which is why it is the one
 * role in the scale with more than a hair of it, and which is also why
 * **nothing lowercase may use it**. A timestamp set in `labelSmall` comes out
 * with visible air between its digits. Metadata that is not shouting is
 * `labelMedium`.
 */
val PqpTypography = Typography(
    displayLarge = display(44, 48, tracking = -1.0),
    displayMedium = display(38, 42, tracking = -0.8),
    displaySmall = display(34, 38, tracking = -0.6),

    headlineLarge = display(30, 34, tracking = -0.5),
    headlineMedium = display(26, 30, tracking = -0.4),
    headlineSmall = display(21, 26, FontWeight.Bold, tracking = -0.2),

    titleLarge = display(19, 24, FontWeight.Bold, tracking = -0.1),
    titleMedium = sans(16, 21, FontWeight.SemiBold),
    titleSmall = sans(15, 20, FontWeight.SemiBold),

    bodyLarge = sans(15, 21),
    bodyMedium = sans(14, 19),
    bodySmall = sans(13, 17),

    labelLarge = sans(14, 18, FontWeight.SemiBold, tracking = 0.1),
    labelMedium = sans(12, 15, FontWeight.SemiBold, tracking = 0.2),
    labelSmall = sans(11, 13, FontWeight.Bold, tracking = 1.1),
)

/**
 * Numbers that do not dance.
 *
 * A timestamp beside every message and a member count that ticks are both
 * columns of digits that change while you are looking at them. Proportional
 * figures make the text either side of them shift by a pixel on every tick,
 * which the eye reads as flicker. `tnum` is one OpenType feature and it is the
 * whole fix.
 */
val TabularFigures = "tnum"
