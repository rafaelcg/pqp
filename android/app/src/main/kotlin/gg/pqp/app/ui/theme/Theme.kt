package gg.pqp.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LocalTonalElevationEnabled
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * The pqp palette, carried over from `client/src/index.css` by way of
 * `ios/pqp/Sources/Design/Theme.swift`, which already did the oklch to sRGB
 * conversion. Same numbers, so the three clients are one product rather than
 * three things that look similar.
 *
 * The values have not moved in this pass. What moved is where they are allowed
 * to appear, which is written down in `docs/ANDROID_DESIGN.md` and encoded in
 * the schemes below.
 */
object Palette {
    val Ink = Color(0xFF090E12)
    val InkDeep = Color(0xFF05080C)
    val Surface = Color(0xFF12181D)
    val SurfaceRaised = Color(0xFF1C2329)
    val Border = Color(0xFF2B343C)

    /** The one loud colour. Sparingly, and never behind long-form text. */
    val Signal = Color(0xFFBBEC4C)
    val SignalDim = Color(0xFF92BF35)

    val Paper = Color(0xFFF0EEE8)
    val PaperMuted = Color(0xFFB6B4AF)
    val PaperSubtle = Color(0xFFD3D0CB)

    val Danger = Color(0xFFEF5350)
    val Warning = Color(0xFFF9BF49)
    val Success = Color(0xFF66D475)

    // The light scheme's counterparts, from the `:root` block the web app uses
    // when the reader has asked for light. The signal darkens there, because a
    // colour that reads as a highlight on ink reads as a highlighter pen on
    // paper.
    val LightSignal = Color(0xFF5F8A28)
    val LightSignalDim = Color(0xFF4E7420)
    val LightGround = Color(0xFFFBFAF7)
    val LightSurface = Color(0xFFFFFFFF)
    val LightSurfaceRaised = Color(0xFFF2F1EC)
    val LightBorder = Color(0xFFDCDAD3)
    val LightInk = Color(0xFF14181C)
    val LightInkMuted = Color(0xFF5A6068)

    /**
     * The chrome, one step further from the reader than the ground.
     *
     * On ink this is `InkDeep`, which is *darker* than the content behind it,
     * exactly as `--color-rail` is darker than `--color-surface-0` on the web.
     * On paper it inverts: the chrome is the tinted card and the content is the
     * white page. That inversion is the whole reason this is a named role
     * rather than an alias.
     */
    val LightChrome = Color(0xFFF2F1EC)
}

/**
 * Deliberately not Material You.
 *
 * Dynamic colour would repaint the one thing this product is recognised by, and
 * pqp's whole visual identity is a lime signal on near-black. The Android feel
 * comes from the components, the motion and the navigation, which are Material 3
 * throughout; it does not have to come from the wallpaper. Discord and Slack
 * make the same call on this platform.
 *
 * ## How the surface roles are used, which is the part that changed
 *
 * Material's `surfaceContainer*` ramp is a ladder of lightness and the default
 * reading of it is "higher is closer". pqp reads the opposite way, and both
 * directions are used on purpose:
 *
 * | Role | Colour | What sits on it |
 * |---|---|---|
 * | `surfaceContainerLowest` | `InkDeep` | **Chrome.** App bars, the bottom navigation bar, the call strip. Deeper than the page, the way a rail is. |
 * | `background` / `surface` | `Ink` | **The page.** Message lists, channel lists, anything scrollable. |
 * | `surfaceContainer` | `Surface` | **Things that lift.** The composer, cards, sheets, dialogs. |
 * | `surfaceContainerHigh` | `SurfaceRaised` | **Things that react.** Pressed rows, the selected channel pill, chips, inline code. |
 * | `surfaceContainerHighest` | `SurfaceRaised` | The same, deliberately: a fifth step would be invisible and would only give components a way to disagree. |
 *
 * A surface never earns its separation from a shadow or from Material's tonal
 * overlay. It earns it from that ramp plus a one pixel `outline` hairline, and
 * `LocalTonalElevationEnabled` is switched off below so no component can quietly
 * reintroduce the overlay and drift a surface off the ramp.
 */
private val DarkColors = darkColorScheme(
    primary = Palette.Signal,
    onPrimary = Palette.InkDeep,
    primaryContainer = Palette.SignalDim,
    onPrimaryContainer = Palette.InkDeep,
    secondary = Palette.PaperSubtle,
    onSecondary = Palette.Ink,
    secondaryContainer = Palette.SurfaceRaised,
    onSecondaryContainer = Palette.Paper,
    tertiary = Palette.Signal,
    onTertiary = Palette.InkDeep,
    background = Palette.Ink,
    onBackground = Palette.Paper,
    surface = Palette.Ink,
    onSurface = Palette.Paper,
    surfaceVariant = Palette.Surface,
    onSurfaceVariant = Palette.PaperMuted,
    surfaceContainerLowest = Palette.InkDeep,
    surfaceContainerLow = Palette.Ink,
    surfaceContainer = Palette.Surface,
    surfaceContainerHigh = Palette.SurfaceRaised,
    surfaceContainerHighest = Palette.SurfaceRaised,
    outline = Palette.Border,
    outlineVariant = Palette.Surface,
    error = Palette.Danger,
    onError = Palette.InkDeep,
    inverseSurface = Palette.Paper,
    inverseOnSurface = Palette.Ink,
    scrim = Color(0xCC05080C),
)

private val LightColors = lightColorScheme(
    primary = Palette.LightSignal,
    onPrimary = Color.White,
    primaryContainer = Palette.LightSignalDim,
    onPrimaryContainer = Color.White,
    secondary = Palette.LightInkMuted,
    onSecondary = Color.White,
    secondaryContainer = Palette.LightSurfaceRaised,
    onSecondaryContainer = Palette.LightInk,
    tertiary = Palette.LightSignal,
    onTertiary = Color.White,
    background = Palette.LightGround,
    onBackground = Palette.LightInk,
    surface = Palette.LightGround,
    onSurface = Palette.LightInk,
    surfaceVariant = Palette.LightSurfaceRaised,
    onSurfaceVariant = Palette.LightInkMuted,
    surfaceContainerLowest = Palette.LightChrome,
    surfaceContainerLow = Palette.LightGround,
    surfaceContainer = Palette.LightSurface,
    surfaceContainerHigh = Palette.LightSurfaceRaised,
    surfaceContainerHighest = Palette.LightSurfaceRaised,
    outline = Palette.LightBorder,
    outlineVariant = Palette.LightSurfaceRaised,
    error = Palette.Danger,
    onError = Color.White,
    inverseSurface = Palette.Ink,
    inverseOnSurface = Palette.Paper,
    scrim = Color(0x9914181C),
)

/**
 * Corners.
 *
 * Material's defaults run 4 / 8 / 12 / 16 / 28, which is a soft ramp with one
 * outlier at the top. This one is tighter at the bottom and rounder at the top,
 * so the difference between "a chip" and "a sheet" is legible at a glance:
 *
 * | Role | Radius | Used by |
 * |---|---|---|
 * | `extraSmall` | 6dp | Badges, inline code, tooltips |
 * | `small` | 10dp | Buttons, text fields, the selected channel pill |
 * | `medium` | 14dp | Cards, the squircle a server's icon is drawn in |
 * | `large` | 20dp | Dialogs, menus |
 * | `extraLarge` | 28dp | Bottom sheets, the composer's pill |
 *
 * Every Material component reads these, so setting them here is most of the
 * shape work in the app done once.
 */
private val PqpShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

/**
 * The spacing grid and the sizes that come off it.
 *
 * A chat client is a stack of rows, and what makes a stack of rows read as a
 * product rather than as a settings screen is that the rows are the same height
 * for the same reason every time. These are the numbers; the reasoning is in
 * `docs/ANDROID_DESIGN.md` §Density.
 */
object Spacing {
    /** The grid. Everything below is a multiple of 4. */
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 24.dp
    val xxl = 32.dp

    /** The page gutter. One number, so nothing is a pixel out from anything. */
    val gutter = 16.dp

    /** How far a list pill is inset from the page gutter. */
    val railInset = 8.dp
}

object Sizes {
    /** A channel row. Shorter than Material's 56dp list item, on purpose. */
    val channelRow = 44.dp

    /** A person in a list: friends, members, search results. */
    val personRow = 56.dp

    /** A server in a list, which carries two lines. */
    val serverRow = 64.dp

    /** A conversation in the inbox: a name, a preview and a time. */
    val conversationRow = 72.dp

    val avatarSmall = 28.dp
    val avatarRow = 36.dp
    val avatarPerson = 40.dp
    val avatarConversation = 44.dp
    val avatarServer = 44.dp
    val avatarLarge = 72.dp

    /** The box an inline icon occupies, so glyphs of different widths align. */
    val iconInline = 20.dp
    val iconAction = 22.dp

    /**
     * How tall a `LargeTopAppBar` stands before it is scrolled.
     *
     * Material's default is 152dp, which is a two-line hero for titles that are
     * one short word here. 124 leaves the headline room to breathe and puts one
     * more row on screen at rest.
     *
     * It is a token rather than a number at three call sites because the three
     * home tabs cross-fade into each other: a bar that is 124dp on Servers and
     * 152dp on Messages makes the title jump down 28dp when somebody changes
     * tab, and reads as an empty band above two of the three screens. Any new
     * large bar uses this.
     */
    val largeTopBarExpanded = 124.dp

    /** A hairline. Not `Dp.Hairline`, which is a physical pixel and vanishes. */
    val hairline = 1.dp
}

/**
 * Motion vocabulary, one curve per job.
 *
 * Two springs used everywhere read as intentional; a different duration per
 * call site reads as noise. This is the same argument the iOS client's `Motion`
 * makes, in Compose's spelling.
 *
 * Navigation transitions are **not** here and must not be overridden. Navigation
 * Compose's defaults are the platform's, they are what the predictive back
 * gesture animates against, and a bespoke slide breaks that cooperation. See
 * the note in `PqpApp.kt`.
 */
object Motion {
    /** Interface transitions: something appearing, moving or resizing. */
    val standard = androidx.compose.animation.core.spring<Float>(
        dampingRatio = 0.82f,
        stiffness = 380f,
    )

    /** Touch feedback: a press, a toggle, a button waking up. */
    val press = androidx.compose.animation.core.spring<Float>(
        dampingRatio = 0.7f,
        stiffness = 1400f,
    )

    /** Colour and size crossfades, where a spring would overshoot visibly. */
    const val QUICK_MILLIS = 140
    const val SETTLE_MILLIS = 260
}

/**
 * Whether the tree is currently painted on ink.
 *
 * Almost everything should read a role off `MaterialTheme.colorScheme` and never
 * ask. The exception is the handful of places that have to choose a *literal*
 * from `Palette` because the thing being drawn is not a Material surface: a
 * presence dot, a speaking ring, the monogram behind somebody's initials.
 */
val LocalIsDark = staticCompositionLocalOf { true }

@Composable
fun PqpTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    CompositionLocalProvider(
        LocalIsDark provides darkTheme,
        // Off, and this is load-bearing rather than tidy. With it on, every
        // Material surface that carries a `tonalElevation` mixes a translucent
        // wash of `primary` into its own colour, so a raised card on ink comes
        // out faintly lime and a dialog comes out a shade nobody chose. The
        // surface ramp above already says what each level looks like; this
        // stops components from disagreeing with it.
        LocalTonalElevationEnabled provides false,
    ) {
        MaterialTheme(
            colorScheme = if (darkTheme) DarkColors else LightColors,
            typography = PqpTypography,
            shapes = PqpShapes,
            content = content,
        )
    }
}
